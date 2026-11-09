// “只留对话”的压缩引擎：替换宿主的 compaction-basic，压缩时剔除工具调用/结果/模式与推理块，把整段会话换成一段摘要。
//
// 导出：默认的 ToolFreeCompaction 引擎类，以及 toolFreeMessages（可测的纯函数）、compactionThreshold 与配置类型。
// 被谁调用：宿主按 profile 的预设/压缩行加载（package.json 的 exports["./compaction"] 指向 lib/compaction.js）。
// 依赖：@deepseek-ai/dsh-compaction、dsh-llm、dsh-session、dsh-token-meter，以及 ./compactionRegion.ts 的区域事务。
// 坑：模型没声明 contextWindow 时按 1M 假设并只警告一次；摘要必须比被替换内容小，否则压缩没有意义；
//     自动压缩失败不能挡住当前轮，手动压缩则要把阶段（busy/summary/commit/cancelled）翻译成 ManualCompactionError。
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type {} from '@deepseek-ai/dsh-agent-loop';
import { CompactionEngine, ManualCompactionError, isCompactCheckpointSource, type CompactionAgentContext, type CompactionResult, type CompactionTrigger, type ManualCompactAgentContext } from '@deepseek-ai/dsh-compaction';
import type { CommandId } from '@deepseek-ai/dsh-commands/brand';
import { BlockAssembler, CONTEXT_WINDOW_EXCEEDED_CODE, LlmError, createUserMessage, type ContentBlock, type Message } from '@deepseek-ai/dsh-llm';
import { appendPluginRecord, type Session, type SessionSeq } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-token-meter';
import { visibleText } from './archive.ts';
import { assertNoActiveCompaction, compactSurfaceRegion, selectWholeRange, type RegionAgent, type RegionDependencies, type SummaryResult } from './compactionRegion.ts';
import { formatTimeContext } from './timeContext.ts';
import './hostContract.ts';

const summaryInstruction = [
  // 摘要指令里明确哪些内容压缩后会重新提供，避免模型把注入块写进摘要。
  '现在暂停对话，改为执行上下文压缩：把上面这段会话中双方的交流整理成一段精炼的中文摘要，供你之后接着对话使用。',
  '保留用户的意图、情绪与关系进展、明确要求、重要事实、已作决定、未完成事项和最近进展；最后一条用户发言尽量按原意完整保留。以“以下是此前交流的摘要”开头的消息是更早的摘要，请与新内容合并为同一段。',
  '以【我的时间】（较早的是【你的时间】）开头的消息是你自己定的闹钟和留给自己的话，不是用户说的话；把它们当作你自己的安排来记，不要算作用户发言。',
  '开头写着“这是我们最近的聊天记录”（较早的写着“最近的聊天记忆”或“最近的相处记忆”）的记忆资料、系统提示里的世界提示词（含「我是谁」）和“Time sampled”开头的时间块会在压缩后重新提供，不要写进摘要。工具调用过程已从会话中删除，不要提及工具。',
  '保留准确的姓名、日期、数字和标识，分清每件事是谁说的、谁做的。不要标题、列表或分段，不要开头语，不要补写原文没有的事实，不要调用任何工具，直接输出摘要正文。',
].join('\n');
// The model tends to echo the checkpoint lead it saw on earlier summaries; the frame adds it once.
const leadEcho = /^以下是此前交流的摘要[^：:]{0,40}[：:]\s*/;
const checkpointLead ='以下是此前交流的摘要，工具调用过程已省略；请把它当作已知背景，直接接着当前对话继续：';
// Re-injected after every successful compaction by the memory runtime; replayed only as cacheable prefix.
const injectedSources = new Set(['time-context', 'dsh-world-history']);

interface SummaryAudit { policyVersion: 2; provider: string; model: string; maxTokens: number; instruction: string; timeContext: string; replayedMessageIds: string[] }
declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap { 'plugin:dsh-world/compaction-request': SummaryAudit }
}
/**
 * `thresholdRatio`: compaction starts at this share of the context window. `defaultContextWindow`: the window assumed for a model
 * whose adapter declares none. `headroomTokens` no longer takes anything off the trigger; it only sizes the summary reply when
 * `maxTokens` is unset.
 */
interface Policy { thresholdRatio: number; defaultContextWindow: number; headroomTokens: number; summarizationProvider: string; summarizationModel: string; maxTokens: number; maxOverflowRetries: number }
/**
 * 压缩引擎配置：策略字段与宿主的 compaction-basic 同名，另有 timeZone/auto/toolFreeFor/modelPolicies。
 * 所有字段都可缺省，缺省值由 resolvePolicy 与构造函数补。
 */
export interface ToolFreeCompactionConfig extends Partial<Policy> {
  timeZone?: string;
  auto?: boolean;
  /**
   * 只在这些目录下的会话里剔除工具调用（她的房间）；留空＝所有会话都剔除（0.8.x 的行为）。
   * 一份预设是全 profile 共用的，靠它把「只留对话」限制在世界的房间，写代码的会话仍按原版方式摘要。
   */
  toolFreeFor?: string[];
  modelPolicies?: (Partial<Policy> & { provider: string; model: string })[];
}
interface Target { provider: string; model: string }

/**
 * The compacted span exactly as the conversation request sent it, minus every
 * tool call and tool result, so the summary request shares the longest possible
 * provider-cached prefix. Assistant text split around a removed call is rejoined.
 */
export function toolFreeMessages(messages: readonly Message[]): Message[] {
  const kept: Message[] = [];
  for (const message of messages) {
    if (message.role === 'tool') continue;
    // A mid-history update (memory block, tool change) may only follow a user turn on DeepSeek Messages. A tool result was
    // that turn after a tool call; with it removed, such an update would sit between two replies and the request is refused.
    // What these updates carry is provided again after compaction, so the summary loses nothing.
    if (message.role === 'system' || message.role === 'developer') {
      if (kept.findLast(previous => previous.role === 'user' || previous.role === 'assistant')?.role === 'user') kept.push(message);
      continue;
    }
    if (message.role !== 'assistant') { kept.push(message); continue; }
    // 去掉 tool-call 块；如果只剩 reasoning，这条 assistant 就没有可保留的内容。
    const content = message.content.filter(block => block.type !== 'tool-call');
    // A step that only reasoned before calling a tool has nothing left to say.
    if (!content.some(block => block.type !== 'reasoning')) continue;
    const previous = kept.at(-1);
    // 被工具调用隔开的 assistant 文本并回上一条，摘要请求才和原请求共享前缀。
    if (previous?.role === 'assistant') kept[kept.length - 1] = { ...previous, content: [...previous.content, ...content] };
    else kept.push(content.length === message.content.length ? message : { ...message, content });
  }
  return kept;
}

function hasConversation(messages: readonly Message[]): boolean {
  // 只算真正的对话：排除注入块和上一次压缩的摘要，避免把“没有内容”当成有内容去压缩。
  return messages.some(message => (message.role === 'user' || message.role === 'assistant') && !injectedSources.has(message.source.kind) && !(message.role === 'user' && isCompactCheckpointSource(message.source)) && visibleText(message.content).trim());
}

/** 会话的工作目录是否落在这些前缀之一（大小写、斜杠方向、末尾斜杠都不敏感）。 */
function underAny(cwd: string | undefined, roots: readonly string[]): boolean {
  if (cwd === undefined) return false;
  // 路径比较前统一斜杠、去掉末尾斜杠并转小写；Windows 盘符大小写不敏感。
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const path = normalize(cwd);
  return roots.some(root => {
    const base = normalize(root);
    return base !== '' && (path === base || path.startsWith(`${base}/`));
  });
}

/**
 * 整段会话里是否还有“能讲给人听”的话。只剩工具调用、注入块或上一次压缩留下的摘要时，手动压缩无事可做：
 * 摘要请求是空的，`summarize` 会抛 `no visible conversation remains`，面板上却显示成“应用并压缩失败”。
 * 这种情况按“没有可压缩的内容”处理（返回 null），调用方已经有那句友好提示。
 */
function hasVisibleConversation(session: Session): boolean {
  const messages = session.surface.nodes
    .map(seq => {
      const event = session.eventAt(seq);
      return event === undefined ? null : session.deriveEventMessage(event);
    })
    .filter((message): message is Message => message !== null);
  return hasConversation(toolFreeMessages(messages));
}

function routedTarget(session: Session): Target | undefined {
  // 从会话最近一次请求头取路由；没有就返回 undefined，压缩不猜模型。
  const config = session.requestHeader()?.config;
  return config?.provider && config.model ? { provider: config.provider, model: config.model } : undefined;
}

function resolvePolicy(config: ToolFreeCompactionConfig): Policy {
  // 配置缺省值集中在这里：75% 触发、1M 默认窗口、64K 预留/摘要上限。
  return {
    thresholdRatio: config.thresholdRatio ?? 0.75, defaultContextWindow: config.defaultContextWindow ?? 1_048_576, headroomTokens: config.headroomTokens ?? 65536,
    summarizationProvider: config.summarizationProvider ?? '', summarizationModel: config.summarizationModel ?? '',
    maxTokens: config.maxTokens ?? config.headroomTokens ?? 65536, maxOverflowRetries: config.maxOverflowRetries ?? 1,
  };
}

/** Compaction starts at `ratio` of the window, or earlier when a reply of `reserved` tokens would then no longer fit after the prompt. */
export function compactionThreshold(input: { contextWindow: number; ratio: number; reserved: number }): number {
  const fits = input.contextWindow - input.reserved;
  if (fits <= 0) throw new Error(`a ${input.reserved}-token reply leaves no room in a ${input.contextWindow}-token window`);
  return Math.floor(Math.min(input.contextWindow * input.ratio, fits));
}

/** Pressure failures specific to one routed model; warned once per target. */
class TargetConfigError extends Error {
  /** 带上 provider/model 键，警告去重按它做。 */
  readonly targetKey: string;
  constructor(targetKey: string, message: string) { super(message); this.targetKey = targetKey; }
}

/**
 * Replacement for `@deepseek-ai/dsh-compaction-basic`: drops every tool call,
 * tool result, tool schema and reasoning block from the compacted span, then
 * replaces the whole conversation with one summary paragraph.
 */
export default class ToolFreeCompaction extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions'];
  static Config = z.object({
    timeZone: z.string(), auto: z.boolean(),
    thresholdRatio: z.number(), defaultContextWindow: z.natural(), headroomTokens: z.natural(), summarizationProvider: z.string(), summarizationModel: z.string(),
    maxTokens: z.natural(), maxOverflowRetries: z.natural(),
    toolFreeFor: z.array(z.string()),
    modelPolicies: z.array(z.object({ provider: z.string().required(), model: z.string().required(), thresholdRatio: z.number(), defaultContextWindow: z.natural(), headroomTokens: z.natural(), summarizationProvider: z.string(), summarizationModel: z.string(), maxTokens: z.natural(), maxOverflowRetries: z.natural() })),
  });
  private readonly policy: Policy;
  private readonly overrides: (Policy & Target)[];
  private readonly timeZone: string;
  /** 空数组 = 所有会话都剔除工具（旧行为）；非空 = 只有这些目录下的会话剔除。 */
  private readonly toolFreeFor: readonly string[];
  // 每个目标只警告一次；溢出重试按 agent/session 分开记，避免跨会话串号。
  private readonly warnedTargets = new Set<string>();
  private readonly assumedWindows = new Set<string>();
  private readonly overflowRetries = new WeakMap<object, number>();
  private readonly overflowAgents = new WeakMap<Session, object>();

  constructor(ctx: Context, config: ToolFreeCompactionConfig = {}) {
    super(ctx);
    // 过滤 undefined 再合并：显式的 0/false 要保留，只有未配置才落默认值。
    const source = Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined)) as ToolFreeCompactionConfig;
    this.timeZone = source.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.toolFreeFor = source.toolFreeFor ?? [];
    this.policy = resolvePolicy(source);
    this.overrides = (source.modelPolicies ?? []).map(override => {
      const entry = Object.fromEntries(Object.entries(override).filter(([, value]) => value !== undefined)) as typeof override;
      const merged: ToolFreeCompactionConfig = { ...this.policy, ...entry };
      // maxTokens 没显式配时跟着 headroomTokens 走，和顶层规则一致。
      if (entry.maxTokens === undefined && entry.headroomTokens !== undefined && source.maxTokens === undefined) merged.maxTokens = entry.headroomTokens;
      return { ...resolvePolicy(merged), provider: entry.provider, model: entry.model };
    });
    // auto 默认开启：不配也要有自动压缩。
    if (source.auto ?? true) this.registerAutomaticCompaction();
  }

  private policyFor(target: Target | undefined): Policy {
    return (target && this.overrides.find(policy => policy.provider === target.provider && policy.model === target.model)) || this.policy;
  }

  private registerAutomaticCompaction(): void {
    const { ctx } = this;
    // 日志只记替换了多少节点/估算 token，便于对照压缩前后。
    const log = (result: CompactionResult, trigger: string) => ctx.logger.info(`compaction (${trigger}): replaced ${result.shadowedSeqs.length} surface nodes with one tool-free summary (~${result.shadowedTokenCount} tokens)`);
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      // 每步开始前按压力压缩；压缩失败不能挡住这一轮，记 warning 后继续。
      if (!signal.aborted) try {
        const result = await this.compactIfNeeded(agent, 'pressure', signal);
        if (result) log(result, 'step pressure');
      } catch (error) {
        if (error instanceof TargetConfigError) {
          if (this.warnedTargets.has(error.targetKey)) return next();
          // 同一个目标的配置错误只警告一次，避免每步刷屏。
          this.warnedTargets.add(error.targetKey);
        }
        ctx.logger.warn(`step compaction failed: ${error instanceof Error ? error.message : String(error)}; continuing the turn`);
      }
      return next();
    });
    // idle 或收到新的 assistant 消息说明溢出已缓解，清零重试计数。
    ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') this.overflowRetries.delete(agent); });
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return;
      const agent = this.overflowAgents.get(session);
      if (agent) this.overflowRetries.delete(agent);
    });
    ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
      // 只有上下文超限才尝试压缩；其它请求错误原样交给宿主。
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next();
      this.overflowAgents.set(agent.session, agent);
      const target = routedTarget(agent.session);
      if (!target) return next();
      const retries = this.overflowRetries.get(agent) ?? 0;
      // 重试次数用完就放弃，把原始错误交回宿主。
      if (retries >= this.policyFor(target).maxOverflowRetries) return next();
      const generation = agent.session.surface.replaceGeneration;
      let result: CompactionResult | null;
      try { result = await this.compactIfNeeded(agent, 'context-overflow', signal); } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // surface 已有持久进展时，这次失败可以从新 surface 重试，不必原样交给宿主。
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(`context-overflow compaction failed after durable surface progress: ${message}; retrying from the replacement surface`);
          this.overflowRetries.set(agent, retries + 1);
          return { kind: 'retry' };
        }
        ctx.logger.warn(`context-overflow compaction failed: ${message}; ${signal.aborted ? 'cancellation prevents retry' : 'preserving the original request error'}`);
        return next();
      }
      if (signal.aborted || agent.session.surface.replaceGeneration <= generation) return next();
      if (result) log(result, 'context overflow recovery');
      this.overflowRetries.set(agent, retries + 1);
      return { kind: 'retry' };
    });
  }

  async compactIfNeeded(agent: CompactionAgentContext, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null> {
    const target = routedTarget(agent.session);
    // 没有路由就不猜模型，也不压。
    if (!target) return null;
    const meter = this.ctx.tokenMeter;
    if (trigger === 'context-overflow') {
      // 溢出路径不按阈值判断，直接整段压缩。
      const range = selectWholeRange(agent.session, meter.measure(agent.session));
      // 没有可见对话时压缩只会产出空摘要：交给宿主按“无需压缩”处理，而不是抛错。
      if (!range || !hasVisibleConversation(agent.session)) return null;
      return this.compactRegion(range.start, range.end, agent, signal);
    }
    const policy = this.policyFor(target);
    // 按当前路由解析模型窗口；解析失败会抛出，由调用方决定是否继续。
    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
    // 自动压缩也要拿同一把锁，避免和手动压缩撞车。
    assertNoActiveCompaction(agent.session, 'automatic pressure compaction');
    const key = `${target.provider}/${target.model}`;
    let contextWindow = info.context?.contextWindow;
    if (contextWindow === undefined) {
      // 模型没声明窗口时按默认窗口假设；只警告一次，提示用户配 contextWindow。
      contextWindow = policy.defaultContextWindow;
      if (!this.assumedWindows.has(key)) {
        this.assumedWindows.add(key);
        this.ctx.logger.warn(`dsh-world/compaction: ${key} declares no contextWindow; assuming ${contextWindow} tokens, so compaction starts at ${Math.floor(contextWindow * policy.thresholdRatio)}. If its real window is smaller, set contextWindow on that adapter model, or defaultContextWindow for it in modelPolicies.`);
      }
    }
    // 预留的是本轮回复的 maxTokens：回复放不下时提前压缩。
    const reserved = agent.session.requestHeader()?.config.maxTokens ?? info.defaultMaxTokens ?? 0;
    let threshold: number;
    try { threshold = compactionThreshold({ contextWindow, ratio: policy.thresholdRatio, reserved }); }
    catch (error) { throw new TargetConfigError(key, `dsh-world/compaction: ${key}: ${error instanceof Error ? error.message : String(error)}`); }
    // 没到阈值就不压。
    if (meter.measure(agent.session).totalTokens < threshold) return null;
    const range = selectWholeRange(agent.session, meter.measure(agent.session));
    if (!range) return null;
    if (!hasVisibleConversation(agent.session)) return null;
    const result = await this.compactRegion(range.start, range.end, agent, signal);
    const after = meter.measure(agent.session).totalTokens;
    // 压缩后仍超阈值说明摘要不够小，抛错让调用方保留原请求错误。
    if (after >= threshold) throw new Error(`compaction still above threshold after summarizing the whole conversation (${after} estimated tokens >= threshold ${threshold})`);
    return result;
  }

  compactRegion(start: SessionSeq, end: SessionSeq, agent: CompactionAgentContext, signal?: AbortSignal): Promise<CompactionResult> {
    return compactSurfaceRegion(this.dependencies(), agent, start, end, { owner: 'current-turn', stability: 'whole-surface' }, signal);
  }

  compactNow(agent: ManualCompactAgentContext, signal: AbortSignal, sourceCommandId?: CommandId): Promise<CompactionResult | null> {
    // 手动压缩必须独占空闲会话；busy 由外层统一转成 ManualCompactionError('busy')。
    signal.throwIfAborted();
    try {
      return agent.runMaintenance(async agentSignal => {
        // 把 agent 的 maintenance signal 和调用方 signal 合成一个，任一取消都停。
        const operationSignal = AbortSignal.any([agentSignal, signal]);
        try {
          operationSignal.throwIfAborted();
          const range = selectWholeRange(agent.session, this.ctx.tokenMeter.measure(agent.session));
          if (!range) return null;
          // 只剩工具调用/注入块/旧摘要时没有可压缩的内容：返回 null，控制台显示“暂无内容，无需压缩”。
          if (!hasVisibleConversation(agent.session)) return null;
          return await compactSurfaceRegion(this.dependencies(), agent, range.start, range.end, {
            owner: null, stability: 'selected-span', ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
            flush: async () => { await this.ctx.sessions.flush(agent.session); },
          }, operationSignal);
        } catch (error) {
          // agentSignal 被取消才算 cancelled；外层 signal 取消继续抛给调用方。
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) throw new ManualCompactionError('cancelled', 'manual compaction was cancelled', { cause: error });
          operationSignal.throwIfAborted();
          throw error;
        }
      });
    } catch (error) {
      throw new ManualCompactionError('busy', 'manual compaction requires an idle agent with no waking queued work', { cause: error });
    }
  }

  private dependencies(): RegionDependencies {
    // 把区域压缩需要的测量、摘要、帧、恢复回调接到本引擎。
    return {
      meter: this.ctx.tokenMeter,
      summarize: (messages, agent, signal) => this.summarize(messages, agent, signal),
      frame: summary => [{ type: 'text', text: `${checkpointLead}${summary.map(block => block.type === 'text' ? block.text : '').join('')}` }],
      recover: (error, agent, sourceEventSeqs, signal) => this.ctx.waterfall('compaction/summary-error', { session: agent.session, sourceEventSeqs, error, ...(signal === undefined ? {} : { signal }) }, () => false),
    };
  }

  protected async summarize(messages: Message[], agent: RegionAgent, signal?: AbortSignal): Promise<SummaryResult> {
    signal?.throwIfAborted();
    // 优先用会话最近请求的路由，其次才用 agent options；两者都没有就报错。
    const routed = routedTarget(agent.session) ?? (agent.options.provider && agent.options.model ? { provider: agent.options.provider, model: agent.options.model } : undefined);
    const policy = this.policyFor(routed);
    // 摘要模型可单独配；没配就沿用当前路由，保证至少能跑。
    const provider = policy.summarizationProvider || routed?.provider;
    const model = policy.summarizationModel || routed?.model;
    const { maxTokens } = policy;
    if (!provider || !model) throw new Error('dsh-world: no provider/model configured for compaction');
    // 她的房间（toolFreeFor 里的目录）：只把对话拿去摘要；其它会话（写代码的工作区）：工具调用与结果照常进摘要，
    // 和宿主原版压缩的行为一致，压缩后仍能看到跑过什么命令、读过什么文件。
    const toolFree = this.toolFreeFor.length === 0 || underAny(agent.session.header.cwd, this.toolFreeFor);
    const visible = toolFreeMessages(messages);
    const replayed = toolFree ? visible : messages;
    // 没有可见对话时摘要请求是空的：直接报错，让上层按“无需压缩”处理。
    if (!hasConversation(visible)) throw new Error('dsh-world: no visible conversation remains to summarize');
    const { session } = agent;
    // system 头单独保留在请求最前面，和宿主原版压缩一致。
    const head = session.surface.nodes[0] === undefined ? undefined : session.eventAt(session.surface.nodes[0]);
    const system = head?.type === 'system/message' ? session.deriveEventMessage(head) : null;
    const header = session.requestHeader();
    const timeContext = formatTimeContext(new Date(), this.timeZone);
    // 把这次摘要请求的完整参数记进会话，事后能解释摘要为什么是这样。
    appendPluginRecord(session, 'plugin:dsh-world/compaction-request', { policyVersion: 2, provider, model, maxTokens, instruction: summaryInstruction, timeContext, replayedMessageIds: replayed.map(message => message.id) });
    // 先 flush 审计记录再发请求：摘要请求失败也能查到用了哪个模型/指令。
    await this.ctx.sessions.flush(session);
    const request = [
      ...(system ? [system] : []), ...replayed,
      createUserMessage({ source: { kind: 'dsh-world-summary-input' }, content: [{ type: 'text', text: `${summaryInstruction}\n\n${timeContext}` }] }),
    ];
    // 统一用 BlockAssembler 收流，最后按 finish 判断是 stop 还是 error/aborted。
    const assembler = new BlockAssembler();
    for await (const chunk of this.ctx.llm.stream({ provider, model, maxTokens, messages: request, ...(header?.tools === undefined ? {} : { tools: [...header.tools] }), toolHistory: session.toolHistory(), sessionId: session.id, purpose: 'compaction', ...(signal === undefined ? {} : { signal }) })) assembler.push(chunk);
    signal?.throwIfAborted();
    const finish = assembler.finish;
    // 只有 stop 才拿得到完整摘要；截断/错误/取消都抛错。
    if (finish.kind === 'error' || finish.kind === 'aborted') throw new LlmError(finish.failure.message, finish.failure.code, finish.failure);
    if (finish.kind !== 'stop') throw new Error(`dsh-world: compaction summary truncated or invalid (${finish.kind})`);
    const rawOutput: ContentBlock[] = assembler.blocks();
    // 模型会复述上一版摘要的开头，这里去掉重复的引导句；换行压成空格，保证摘要是单段。
    const text = rawOutput.flatMap(block => block.type === 'text' ? [block.text.trim()] : []).join(' ').replace(/\s*\r?\n\s*/g, ' ').trim().replace(leadEcho, '').trim();
    // 空摘要等于没压，宁可报错让调用方保留原内容。
    if (!text) throw new Error('dsh-world: summarizer returned no paragraph');
    return { summary: [{ type: 'text', text }], rawOutput, provider, model, maxTokens, ...(assembler.usage ? { usage: assembler.usage } : {}) };
  }
}
