// Surface transaction adapted from @deepseek-ai/dsh-compaction-basic@0.2.1-rc.2 (MIT, Copyright (c) 2026 DeepSeek).
// Kept local so the stock package is used unmodified; selection here always runs to the newest balanced cut.
//
// 会话 surface 的区域压缩事务：选一段、摘要、用一条 checkpoint 消息替换；失败按阶段回滚或报错。
// 导出：SummaryResult / RegionAgent / RegionDependencies / RegionOptions 类型、selectWholeRange、
//       compactSurfaceRegion、assertNoActiveCompaction；被 compaction.ts 调用，手动压缩也会走到这里。
// 依赖：@deepseek-ai/dsh-compaction（CompactionId/ManualCompactionError/toolPairing*）、dsh-llm、dsh-session、token-meter。
// 坑：start/end 不能切断 tool-call 与 tool-result 的配对，否则会话无法重放；摘要必须比被替换内容小；
//     写 compaction/end 之后 flush 失败要按 persistence 报错，不能当成成功。
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CompactionId, ManualCompactionError, compactCheckpointSource, toolPairingBalancedAfter, toolPairingBalancedBefore, type CompactionResult } from '@deepseek-ai/dsh-compaction';
import type { CommandId } from '@deepseek-ai/dsh-commands/brand';
import { createUserMessage, errorChain, type ContentBlock, type Message, type TokenUsage, type UserMessage } from '@deepseek-ai/dsh-llm';
import { SessionSeq, type Session } from '@deepseek-ai/dsh-session';
import type { TokenMeasurement, TokenSurfaceNode } from '@deepseek-ai/dsh-token-meter';

/** 摘要结果：summary 是最终写给会话的块，rawOutput 是模型原始输出。 */
export interface SummaryResult { summary: ContentBlock[]; rawOutput: ContentBlock[]; provider: string; model: string; maxTokens: number; usage?: TokenUsage }
/** 区域压缩需要的最小 agent 形状：会话 + 当前路由。 */
export interface RegionAgent { session: Session; options: { provider?: string; model?: string } }
/** 区域压缩的依赖；由压缩引擎注入，测试可换假实现。 */
export interface RegionDependencies {
  meter: { measure(session: Session): TokenMeasurement; estimateMessage(message: Message): number };
  summarize(messages: Message[], agent: RegionAgent, signal?: AbortSignal): Promise<SummaryResult>;
  frame(summary: ContentBlock[]): ContentBlock[];
  recover(error: unknown, agent: RegionAgent, seqs: readonly SessionSeq[], signal?: AbortSignal): boolean;
}
/** 一次区域压缩的选项。 */
export interface RegionOptions { owner: 'current-turn' | null; stability: 'whole-surface' | 'selected-span'; sourceCommandId?: CommandId; flush?: () => Promise<void> }
interface Selection { start: SessionSeq; end: SessionSeq; startIdx: number; endIdx: number; shadowedSeqs: readonly SessionSeq[] }
interface Prepared extends Selection { measurement: TokenMeasurement; selectedNodes: readonly TokenSurfaceNode[]; shadowedTokenCount: number; shadowedRouteTokenCount: number; messages: Message[] }
type Summarized = Prepared & SummaryResult & { checkpointMessage: UserMessage };

function eventAt(session: Session, seq: SessionSeq) {
  const event = session.eventAt(seq);
  // event 丢失说明 seq 和当前 surface 对不上，直接抛错，不能继续压。
  if (event === undefined) throw new Error(`compaction: session seq ${seq} has no event`);
  return event;
}

// surface 在摘要期间被别人改了：手动压缩转成 changed，自动压缩原样抛出。
class SurfaceChangedError extends Error {}

/** Everything after the system head through the newest cut that splits no tool call from its result. */
export function selectWholeRange(session: Session, measurement: TokenMeasurement): { start: SessionSeq; end: SessionSeq } | null {
  const nodes = session.surface.nodes;
  if (!nodes.length) return null;
  // 测量结果必须和当前 surface 完全一致，否则测的不是这段会话。
  if (nodes.length !== measurement.nodes.length || nodes.some((seq, index) => seq !== measurement.nodes[index]?.seq)) throw new Error('compaction: token-meter surface does not match the current session surface');
  // 跳过 system 头，它不参与摘要。
  const firstIdx = eventAt(session, nodes[0]).type === 'system/message' ? 1 : 0;
  let endIdx = nodes.length - 1;
  // 从末尾往前找第一个不切断工具配对的切点：宁可少压，也不能压出半个 tool 对。
  while (endIdx >= firstIdx && !toolPairingBalancedAfter(session, nodes[endIdx])) endIdx -= 1;
  return endIdx < firstIdx ? null : { start: nodes[firstIdx], end: nodes[endIdx] };
}

/**
 * 把 surface 上 [start, end] 这段替换成一条摘要 checkpoint。
 * @param deps 测量、摘要、帧、恢复回调
 * @param agent 目标会话与路由
 * @param start 起始 seq（不能切断工具配对）
 * @param end 结束 seq（不能切断工具配对）
 * @param options owner/stability/sourceCommandId/flush；手动压缩的 owner 为 null
 * @param signal 可选取消信号
 * @returns 压缩结果；手动压缩失败会抛 ManualCompactionError（按阶段），自动压缩原样抛出
 */
export async function compactSurfaceRegion(deps: RegionDependencies, agent: RegionAgent, start: SessionSeq, end: SessionSeq, options: RegionOptions, signal?: AbortSignal): Promise<CompactionResult> {
  const { session } = agent;
  // 手动压缩没有 turn，只能检查调用方 signal；自动压缩必须在一个 turn 里。
  if (options.owner === null) signal?.throwIfAborted();
  const selection = validateSurfaceRegion(session, start, end);
  const entry = inspectEntryState(session);
  assertInactive(entry, 'compaction');
  // 手动压缩要求会话空闲；自动压缩必须发生在 turn 内，否则压缩事件没有归属。
  if (options.owner === null && entry.openTurn !== null) throw new ManualCompactionError('busy', 'manual compaction: the session already has an open turn');
  if (options.owner !== null && entry.openTurn === null) throw new Error('compactRegion: no open turn — automatic compaction events must be enclosed in a turn');
  const lifecycle = { compactionId: CompactionId(randomUUID()), ...(options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId }), turn: options.owner === null ? null : entry.openTurn };
  const startEvent = session.append('compaction/start', lifecycle);
  // 自动压缩要求整个 surface 没变；手动压缩只要求选中的那段没变（前后可以继续追加）。
  const assertStable = options.stability === 'whole-surface' ? assertWholeSurfaceUnchanged : assertSelectedSpanStable;
  let failure: { error: unknown; stage: 'summary' | 'commit' } | undefined;
  let flushFailure: unknown;
  let result: CompactionResult | undefined;
  let closed = false; let closing = false; let stage: 'summary' | 'commit' = 'summary';
  try {
    // 先摘要、再校验、最后一次性提交；提交后写 compaction/end。
    const summarized = await summarize(deps, prepare(deps, session, selection), agent, lifecycle.compactionId, options.sourceCommandId, assertStable, signal);
    if (options.owner === null) signal?.throwIfAborted();
    assertStable(deps, session, summarized);
    stage = 'commit';
    const pending = commitBody(session, startEvent.seq, lifecycle, summarized);
    closing = true;
    const endEvent = session.append('compaction/end', lifecycle);
    closed = true;
    result = { ...pending, endSeq: endEvent.seq };
  } catch (error) {
    failure = { error, stage: closing ? 'commit' : stage };
    if (!closing) {
      closing = true;
      try { session.append('compaction/end', { ...lifecycle, error: errorChain(error) }); closed = true; } catch (closeError) { failure = { error: closeError, stage: 'commit' }; }
    }
  }
  // 只有 end 写成功才 flush；flush 失败按持久化失败报，不能当成功。
  if (closed && options.flush) try { await options.flush(); } catch (error) { flushFailure = error; }
  if (options.owner === null) signal?.throwIfAborted();
  if (failure) {
    // 手动压缩把失败翻译成 ManualCompactionError 的阶段码；自动压缩原样抛给宿主。
    if (options.owner !== null) throw failure.error;
    if (failure.stage === 'commit') throw new ManualCompactionError('commit', 'manual compaction did not commit cleanly', { cause: failure.error });
    if (failure.error instanceof SurfaceChangedError) throw new ManualCompactionError('changed', 'the compacted history changed during manual compaction', { cause: failure.error });
    throw new ManualCompactionError('summary', 'manual compaction could not produce a smaller summary', { cause: failure.error });
  }
  if (flushFailure !== undefined) throw new ManualCompactionError('persistence', 'manual compaction durability checkpoint failed', { cause: flushFailure });
  return result!;
}

/**
 * 断言会话当前没有未结束的压缩；有就抛 ManualCompactionError('busy')。
 * @param session 目标会话
 * @param stage 报错里用的阶段名，便于定位是自动还是手动压缩
 */
export function assertNoActiveCompaction(session: Session, stage: string): void { assertInactive(inspectEntryState(session), stage); }

function assertInactive(entry: ReturnType<typeof inspectEntryState>, stage: string): void {
  // 只有 compaction/start 后面没有对应的 end 才算锁被占用；end 比 start 新说明已经结束。
  if (entry.unmatchedStart === undefined || (entry.latestEndSeedSeq !== undefined && entry.latestEndSeedSeq > entry.unmatchedStart)) return;
  throw new ManualCompactionError('busy', `${stage}: compaction already in progress; the session compaction lock is already active`);
}

function validateSurfaceRegion(session: Session, start: SessionSeq, end: SessionSeq): Selection {
  // start/end 必须在 surface 上，且两端都不能切断工具配对。
  const nodes = session.surface.nodes;
  const startIdx = nodes.indexOf(start); const endIdx = nodes.indexOf(end);
  if (startIdx === -1) throw new Error(`compactRegion: start seq ${start} not found in surface`);
  if (endIdx === -1) throw new Error(`compactRegion: end seq ${end} not found in surface`);
  if (startIdx > endIdx) throw new Error(`compactRegion: start seq ${start} is after end seq ${end} on the surface`);
  if (!toolPairingBalancedBefore(session, nodes[startIdx])) throw new Error(`compactRegion: start seq ${start} would split a tool-call/result pair`);
  if (!toolPairingBalancedAfter(session, nodes[endIdx])) throw new Error(`compactRegion: end seq ${end} would split a tool-call/result pair, or the step is still open`);
  return { start, end, startIdx, endIdx, shadowedSeqs: nodes.slice(startIdx, endIdx + 1) };
}

function prepare(deps: RegionDependencies, session: Session, selection: Selection): Prepared {
  // 把选中节点映射成消息；surface 在测量后被改过就抛 SurfaceChangedError。
  const measurement = deps.meter.measure(session);
  const selectedNodes = measurement.nodes.slice(selection.startIdx, selection.endIdx + 1);
  if (selectedNodes.length !== selection.shadowedSeqs.length || selectedNodes.some((node, index) => node.seq !== selection.shadowedSeqs[index])) throw new SurfaceChangedError('compaction: selected surface changed before summarization began');
  return {
    ...selection, measurement, selectedNodes,
    shadowedTokenCount: selectedNodes.reduce((total, node) => total + node.heuristicTokens, 0),
    shadowedRouteTokenCount: selectedNodes.reduce((total, node) => total + node.tokens, 0),
    messages: selection.shadowedSeqs.map(seq => session.deriveEventMessage(eventAt(session, seq))).filter((message): message is Message => message !== null),
  };
}

async function summarize(deps: RegionDependencies, prepared: Prepared, agent: RegionAgent, compactionId: CompactionId, sourceCommandId: CommandId | undefined, assertStable: typeof assertWholeSurfaceUnchanged, signal?: AbortSignal): Promise<Summarized> {
  let summary: SummaryResult;
  // 摘要失败先看 recover 钩子要不要重试；重试前必须重新 prepare，因为 surface 可能已经变了。
  for (;;) {
    signal?.throwIfAborted();
    try { summary = await deps.summarize(prepared.messages, agent, signal); break; } catch (error) {
      if (signal?.aborted) throw error;
      assertStable(deps, agent.session, prepared);
      if (!deps.recover(error, agent, prepared.shadowedSeqs, signal)) throw error;
      prepared = prepare(deps, agent.session, validateSurfaceRegion(agent.session, prepared.start, prepared.end));
    }
  }
  // 用 checkpoint 消息承载摘要，来源标记成 compactCheckpointSource，压缩后能被识别为“旧摘要”。
  const checkpointMessage = createUserMessage({ content: deps.frame(summary.summary), source: compactCheckpointSource(compactionId, sourceCommandId) });
  const framed = deps.meter.estimateMessage(checkpointMessage);
  // 摘要（含框架文本）必须比被替换的 token 少，否则压缩没有意义。
  if (framed >= prepared.shadowedRouteTokenCount) throw new Error(`summary is not smaller than the shadowed content (${framed} estimated framed tokens >= ${prepared.shadowedRouteTokenCount})`);
  return { ...prepared, ...summary, checkpointMessage };
}

function assertWholeSurfaceUnchanged(deps: RegionDependencies, session: Session, prepared: Prepared): void {
  // deepStrictEqual 比较节点列表：seq 顺序或内容变了都算 surface 变了。
  if (!isDeepStrictEqual(deps.meter.measure(session).nodes, prepared.measurement.nodes)) throw new SurfaceChangedError('compaction: session surface changed during summarization');
}

function assertSelectedSpanStable(deps: RegionDependencies, session: Session, prepared: Prepared): void {
  // 手动压缩允许前后追加，但选中的这段必须还在原位、内容没被重写。
  let current: Selection;
  try { current = validateSurfaceRegion(session, prepared.start, prepared.end); } catch (error) { throw new SurfaceChangedError('compaction: the selected span is no longer a valid replacement target', { cause: error }); }
  if (!isDeepStrictEqual([...current.shadowedSeqs], [...prepared.shadowedSeqs])) throw new SurfaceChangedError('compaction: the selected span changed during summarization');
  if (!isDeepStrictEqual(deps.meter.measure(session).nodes.slice(current.startIdx, current.endIdx + 1), prepared.selectedNodes)) throw new SurfaceChangedError('compaction: the selected span was rewritten during summarization');
}

function commitBody(session: Session, startSeq: SessionSeq, lifecycle: { compactionId: CompactionId; sourceCommandId?: CommandId }, summarized: Summarized): Omit<CompactionResult, 'endSeq'> {
  // 先写 compaction/summary，再用 user/message 的 replace surfaceOp 替换整段；两个事件由 session 保证原子。
  const { start, end, shadowedSeqs, shadowedTokenCount, summary, rawOutput, provider, model, maxTokens, usage, checkpointMessage } = summarized;
  const { compactionId, sourceCommandId } = lifecycle;
  const command = sourceCommandId === undefined ? {} : { sourceCommandId };
  const summaryEvent = session.append('compaction/summary', {
    compactionId, ...command, summary, rawOutput, shadowedRange: { start, end }, shadowedSeqs: [...shadowedSeqs], shadowedTokenCount, provider, model, maxTokens, ...(usage === undefined ? {} : { usage }),
  });
  session.append('user/message', checkpointMessage, { surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, sourceEventSeqs: [startSeq, summaryEvent.seq, ...shadowedSeqs] });
  return { compactionId, ...command, startSeq, summarySeq: summaryEvent.seq, summary, shadowedRange: { start, end }, shadowedSeqs: [...shadowedSeqs], shadowedTokenCount };
}

function inspectEntryState(session: Session) {
  // 从尾部往前扫，找最近的未配对 compaction/start、最近的 turn/start 与 session/end-seed；三个都找到就停。
  let openTurn: number | null = null; let turnKnown = false;
  let unmatchedStart: SessionSeq | undefined; let lockKnown = false;
  let latestEndSeedSeq: SessionSeq | undefined;
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = eventAt(session, SessionSeq(seq));
    if (latestEndSeedSeq === undefined && event.type === 'session/end-seed') latestEndSeedSeq = event.seq;
    if (!lockKnown) {
      if (event.type === 'compaction/start') { unmatchedStart = event.seq; lockKnown = true; } else if (event.type === 'compaction/end') lockKnown = true;
    }
    if (!turnKnown) {
      if (event.type === 'turn/start') { openTurn = event.data.turn; turnKnown = true; } else if (event.type === 'turn/end') turnKnown = true;
    }
    if (turnKnown && lockKnown && latestEndSeedSeq !== undefined) break;
  }
  return { openTurn, unmatchedStart, latestEndSeedSeq };
}
