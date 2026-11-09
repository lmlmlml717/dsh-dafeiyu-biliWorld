/**
 * 把宿主会话日志里的对话回放进归档：按会话记住读到哪，任务一个接一个跑。
 *
 * 导出：isCorruptSessionLog、belongsToWorld、inWorld、isNotFound、createSourceArchive（排队与回放）。
 * 调用方：runtime.ts（实时事件、启动补读、世界停止时跳过）。
 * 依赖：ctx.sessionPersistence（读日志与元数据）、archive.ts（事件转记录）、store.ts（写记录与进度）、faults.ts。
 *
 * 坑：同一会话重复入队会合并成一个任务，任务在跑期间又来改动时只让它再跑一轮；损坏的日志单独降级成警告，
 * 不让一条坏日志卡住后面所有会话。范围外的会话不归档，但仍然排在队尾等一等 —— 它的记忆块也要拿到最新进度。
 */
import type { Context } from '@deepseek-ai/cordis';
import { SessionId, type Session } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';
import { extractConversationRecords, isOrdinarySession } from './archive.ts';
import type { ArchiveStore } from './store.ts';
import type { WorldConfig } from './types.ts';
import { wechatDeliveryPatch } from './ecosystem/wechat/archive.ts';
import { errorText, Faults } from './faults.ts';

// 读日志的批量：与归档落盘的批量一致，一次回放读一页、写一页。
const pageSize = 128;
/** Unreadable logs are isolated per source; their archive gaps remain visible until replay succeeds. */
export function isCorruptSessionLog(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? '');
  return /stored log is corrupt|SessionFormatError|does not match (?:an|the) open turn/i.test(text);
}
/**
 * 这个会话是不是她世界里的普通会话：预设对得上，且不是子代理或委派出来的。
 * @param session 只看 header。
 * @param config 世界配置，取其中的 agentPreset。
 * @returns 预设一致且是普通会话才为 true；预设不符、来源是 subagent、委派深度大于 0 都是 false。
 */
export function belongsToWorld(session: Pick<Session, 'header'>, config: WorldConfig): boolean {
  const header = session.header;
  return header.agentPreset === config.agentPreset && isOrdinarySession(header);
}
/** One of her sessions that is also in her room's workspace; without a membership test, any of her sessions. */
export function inWorld(session: Pick<Session, 'header' | 'id'>, config: WorldConfig, inWorkspace?: (sessionId: string) => boolean): boolean {
  return belongsToWorld(session, config) && (inWorkspace?.(session.id) ?? true);
}
/** 宿主持久化层「找不到这个会话」的错误；按错误类型名判断，不依赖那个包的实现细节。 */
export const isNotFound = (error: unknown) => error instanceof Error && error.name === 'SessionPersistenceNotFoundError';

/**
 * Copies her conversations from the host's session logs into the archive. Each session is replayed from where
 * the archive left off; replays run one at a time, and a session already queued is not queued twice. Sessions
 * outside `archived` are left alone.
 */
export function createSourceArchive(ctx: Context, config: WorldConfig, store: ArchiveStore, archived: (sessionId: string) => boolean = () => true) {
  // 待回放的会话：任务在跑期间又来了事件，就让它再跑一轮，而不是再排一个任务。
  const dirty = new Set<string>();
  const jobs = new Map<string, Promise<void>>();
  const failures = new Map<string, unknown>();
  const faults = new Faults();
  // 所有回放串成一条链：同一时刻只有一个在跑，归档的写入顺序才是确定的。
  let tail = Promise.resolve();

  // 宿主已经没有这个会话：只忘掉「从哪接着读」，归档里已经写下的记录一条都不删。
  function forget(sessionId: string): void {
    store.forgetProgress(sessionId);
    failures.delete(sessionId); faults.clear(sessionId);
  }

  /** Copies what the archive has not seen yet; `skip` moves past it without keeping it. */
  async function copySource(sessionId: string, skip: boolean): Promise<void> {
    const id = SessionId(sessionId);
    const live = ctx.sessions.get(id);
    // 活着的会话先把内存里的尾巴刷进日志，否则最后几条消息会漏在归档外。
    if (live) await ctx.sessions.flush(live);
    // A deleted session keeps what it already archived; there is nothing left to replay.
    const handle = await ctx.sessionPersistence.open(id, 'read').catch(error => {
      if (isNotFound(error)) { ctx.logger.warn(`dsh-world: session ${sessionId} is no longer stored; skipping replay`); forget(sessionId); return undefined; }
      throw error;
    });
    if (!handle) return;
    try {
      let { nextSeq, turn } = store.progress(id);
      while (true) {
        // 按页读，读到空页就是这一轮读完了；nextSeq 每页推进一次，崩溃后从上次提交的位置接着来。
        const { events } = await handle.read(nextSeq, pageSize);
        if (!events.length) break;
        const records = events.flatMap(event => {
          // 轮次只在 turn/start 里更新：用户消息自身不带轮次，靠它给后续记录定位。
          if (event.type === 'turn/start') turn = event.data.turn;
          return skip ? [] : extractConversationRecords(event, { ...config, header: handle.header, inheritedEventCount: handle.inheritedEventCount, turn }).map(record => {
            // 重放时用已存的投递状态覆盖，否则会把「已发出」退回成「待发送」。
            const delivery = record.wechatDelivery ? store.delivery(record.recordId) : undefined;
            return delivery ? { ...record, ...wechatDeliveryPatch(record, delivery) } : record;
          });
        });
        nextSeq = events.at(-1)!.seq + 1;
        await store.commitRecords(records, { sessionId: id, nextSeq, turn });
      }
    } finally { await handle.close(); }
  }
  async function replay(sessionId: string, skip = false): Promise<void> {
    try {
      await copySource(sessionId, skip);
      failures.delete(sessionId); faults.clear(sessionId);
    } catch (error) {
      // 失败就不再挂着「脏」标记：下次 schedule 重新排一轮，不会因为残留标记空转。
      dirty.delete(sessionId);
      const message = `会话 ${sessionId} 归档未完成：${errorText(error)}`;
      faults.set(sessionId, message);
      // 日志本身坏了，重试也不会好：降级成警告，归档留一个看得见的缺口。
      if (isCorruptSessionLog(error)) {
        failures.delete(sessionId); ctx.logger.warn(`dsh-world: ${message}`); return;
      }
      failures.set(sessionId, error);
      throw error;
    }
  }
  /** Runs after every queued replay. */
  function enqueue(work: () => Promise<void>): Promise<void> {
    const job = tail.then(work);
    // 失败只记日志，不把后面的任务一起打断；真正的失败由 failures 收集，flush 时统一报。
    tail = job.catch(error => { ctx.logger.error(error); });
    return job;
  }
  function schedule(sessionId: string): Promise<void> {
    // Not archived itself, it still waits for the replays already queued, so its memory block is current.
    if (!archived(sessionId)) return tail;
    dirty.add(sessionId);
    const pending = jobs.get(sessionId);
    if (pending) return pending;
    const job = tail.then(async () => {
      // 任务在跑期间又来事件时，dirty 标记还在，循环会自己再跑一轮，不另排任务。
      try { while (dirty.delete(sessionId)) await replay(sessionId); }
      finally { jobs.delete(sessionId); }
    });
    jobs.set(sessionId, job);
    tail = job.catch(error => { ctx.logger.error(error); });
    return job;
  }
  return {
    schedule,
    faults: () => faults.list(),
    /**
     * Every session the archive has seen, replayed again so nothing written while the plugin was not loaded is
     * missed; with `skip`, what was said while her world was stopped is passed over instead.
     */
    async catchUp(skip = false): Promise<void> {
      // One session's failure is kept for flush(); it must not stop the sessions after it.
      const replayOne = (id: string) => (skip ? enqueue(() => replay(id, true)) : schedule(id)).catch(() => {});
      // The host exposes a metadata inventory; every selected message log is still read in pages.
      // 宿主给的是元数据清单；消息日志仍然要一页一页读。
      const snapshots = await ctx.sessionPersistence.list();
      const visited = new Set<string>();
      for (let offset = 0; offset < snapshots.length; offset += pageSize) {
        for (const { header } of snapshots.slice(offset, offset + pageSize)) {
          if (!isOrdinarySession(header) || !archived(header.id)) continue;
          visited.add(header.id);
          await replayOne(header.id);
        }
      }
      let after = '';
      // 再补一遍归档里见过、宿主清单却没列出的会话：清单不一定覆盖全部日志，按 id 分页翻。
      for (let ids = store.sourcePage(after); ids.length; ids = store.sourcePage(after)) {
        for (const id of ids) {
          after = id;
          if (visited.has(id)) continue;
          // A session deleted from the host (not merely archived there) keeps its records but has nothing left to resume.
          if (!await ctx.sessionPersistence.stat(SessionId(id))) { forget(id); continue; }
          if (!archived(id)) continue;
          await replayOne(id);
        }
      }
    },
    /** Moves past everything a session holds now without keeping it (said while her world was stopped). */
    skip: (sessionId: string) => enqueue(() => replay(sessionId, true)),
    /** Waits for every queued replay; rejects while any session still has an unresolved failure. */
    async flush(): Promise<void> {
      let current: Promise<void>;
      // 反复等到链尾不再变化：等待期间可能又有新任务挂上来。
      do { current = tail; await current; } while (current !== tail);
      // 只有真正的失败才抛；坏日志已经降级成警告，不算在这里。
      if (failures.size) throw new AggregateError([...failures.values()], 'dsh-world: source archive has unresolved failures');
    },
  };
}
