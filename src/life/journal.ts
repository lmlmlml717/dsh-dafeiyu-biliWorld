/**
 * 控制台看到的生活流水：家里的每次工具调用（等结果出来才记）和世界会话里的每次压缩。
 *
 * 导出：createJournal。
 * 调用方：life/runtime.ts 的 session/event 监听里，分别喂 world 和 home。
 * 依赖：activity.summarizeCall、lifeStore、faults、Session/SessionEvent 类型。
 * 坑：工具调用先暂存在 Map 里，等 tool/result 才落盘；没有结果的（取消、崩溃）在 turn/end 补记，
 * 这样既不会丢，也不会把没跑完的调用写成成功。
 */
/**
 * 【链路位置】
 * 回顾链路的旁路：不写日记，但回顾要读的「今天做了什么」正是这里记下的流水。
 * 上游：runtime.ts 的 session/event 监听，世界会话喂 world（压缩），她的家喂 home（工具调用）。
 * 下游：summarizeCall 把调用压成一行，写进 lifeStore 的 activity/compaction；写失败登记 faults。
 * 读写：只追加 lifeStore 的记录，这些记录最终落在 worlds/<worldId>/activity/YYYY-MM-DD.jsonl。
 * 与回顾的接点：lookBack 把当天的 activity 文件路径填进模板，本文件的记录就是那份原料。
 */
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-compaction';
import { errorText, type Faults } from '../faults.ts';
import { summarizeCall } from './activity.ts';
import type { LifeStore } from './lifeStore.ts';

interface PendingCall { sessionId: string; name: string; arguments: string; time: string }

/**
 * 【上游参考】
 * 生活线骨架（alarm/journal/runtime 的闹钟+回顾模型）来自 dsh-dafeiyu-life；
 * 这里沿用「流水只记已经发生的事、回顾再读流水」的分工，journal 不参与回顾正文的生成。
 */
/**
 * What the console shows of her life: every tool call in her home, logged once its result is known, and every
 * compaction in her world sessions.
 */
/**
 * 谁调用：runtime.ts 在装配生活线时创建一次，之后每个 session/event 都喂给它。
 * 参数：store 是 lifeStore；faults 用来报写盘失败；roomDir 用来判断调用在不在房间外；
 *   logger 在写失败时留一条日志。
 * 返回：world/home 两个事件处理器；没有查询接口，控制台读的是 store 里的表。
 * 失败：写盘失败不抛给宿主，登记 activity/compaction 故障并保留上一条的位置。
 */
export function createJournal(deps: { store: LifeStore; faults: Faults; roomDir: string; logger: { error(...args: unknown[]): void } }) {
  const { store, faults } = deps;
  // 等结果的调用按 callId 暂存；一条调用只落一次。
  const calls = new Map<string, PendingCall>();
  const shadowed = new Map<string, number>();
  function logCall(callId: string, call: PendingCall, status?: 'ok' | 'error'): void {
    const { summary, outside } = summarizeCall(call.name, call.arguments, deps.roomDir);
    if (store.appendActivity({ time: call.time, sessionId: call.sessionId, callId, tool: call.name, summary, outside, ...(status ? { status } : {}) })) faults.clear('activity');
    else { faults.set('activity', '活动记录写入失败，下一条会标记缺口'); deps.logger.error('dsh-world: activity log write failed'); }
  }
  return {
    /** Any world session: compactions. */
    world(session: Session, event: SessionEvent): void {
      if (event.type === 'compaction/summary') shadowed.set(event.data.compactionId, event.data.shadowedTokenCount);
      if (event.type !== 'compaction/end') return;
      // 压缩结束事件不带被压掉的 token 数，只能从之前的 summary 事件里取。
      const tokens = shadowed.get(event.data.compactionId); shadowed.delete(event.data.compactionId);
      const { error } = event.data;
      try {
        store.appendCompaction({ time: new Date(event.time).toISOString(), sessionId: session.id, ok: error === undefined, ...(tokens === undefined ? {} : { shadowedTokens: tokens }), ...(error === undefined ? {} : { error }) });
        faults.clear('compaction');
      } catch (cause) { faults.set('compaction', `压缩记录写入失败：${errorText(cause)}`); deps.logger.error(cause); }
    },
    /** Her home: tool calls, logged at their result; one that never got a result (cancelled, crashed) is logged when the turn ends. */
    /**
     * 谁调用：runtime.ts 的 session/event，只喂她的家会话。
     * 时机：tool/call 先存进 Map，tool/result 才落盘；turn/end 补记还没结果的调用。
     * 参数：session 是家的会话，event 是宿主事件；其他会话的事件不会进来。
     * 失败：单条写失败只登记故障，不打断这一轮。
     */
    home(session: Session, event: SessionEvent): void {
      if (event.type === 'tool/call') calls.set(event.data.callId, { sessionId: session.id, name: event.data.name, arguments: event.data.arguments, time: new Date(event.time).toISOString() });
      if (event.type === 'tool/result') {
        const callId = event.data.message.toolCallId; const call = calls.get(callId);
        if (call) { calls.delete(callId); logCall(callId, call, event.data.message.isError ? 'error' : 'ok'); }
      }
      // 轮次结束时还没等到结果的调用，按「没有状态」补记，避免流水里留下空洞。
      if (event.type === 'turn/end') for (const [callId, call] of calls) if (call.sessionId === session.id) { calls.delete(callId); logCall(callId, call); }
    },
  };
}
