// 控制台的“应用并压缩家会话”：把已保存的人格/世界提示词应用到家会话，并在空闲时做一次手动压缩。
//
// 导出：HomeApplyState 类型、compactionFor（找会话预设里或宿主上的压缩引擎）与 createHomeApply（单飞请求工厂）。
// 被谁调用：index.ts 组装 ConsoleActions.applyHome 与快照里的 homeApply 状态；控制台 POST /console/apply-home。
// 依赖：宿主 Context/Agent/Session、@deepseek-ai/dsh-compaction 的 CompactionEngine 与 ManualCompactionError、faults.errorText。
// 坑：Web 宿主的压缩在会话预设里（宿主平面看不到），所以先查 agentPresets.serviceFor 再退回 ctx.get('compaction')；
//     请求只存在内存里，失败必须登记到控制台 health，否则夜里自动触发的那次没人看得到。
import { addAbortListener } from 'node:events';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-llm';
import { ManualCompactionError, type CompactionEngine } from '@deepseek-ai/dsh-compaction';
import type { Session } from '@deepseek-ai/dsh-session';
import { errorText } from '../faults.ts';

/** 一次应用请求的状态；面板只读这个对象。 */
export interface HomeApplyState {
  status: 'idle' | 'waiting' | 'compacting' | 'done' | 'failed' | 'cancelled';
  /** 目标家会话 id；请求还没拿到会话时为空。 */
  sessionId?: string;
  /** 完成/失败/取消时给用户看的一句话。 */
  message?: string;
}
/** createHomeApply 的依赖；全部由 index.ts 注入。 */
interface HomeApplyDeps {
  ctx: Context;
  home(): Promise<Agent>;
  isHome(agent: Agent): boolean;
  /** The engine her home actually compacts with; on the Web host it sits inside the session's preset, not on the host. */
  compaction(agent: Agent): Pick<CompactionEngine, 'compactNow'> | undefined;
  refresh(session: Session): void;
  changed(): void;
  /** The console health entry for a failed request; undefined clears it. */
  fault(message: string | undefined): void;
}
/** The Web host's preset registry; `serviceFor` reads a service from a session's isolated preset group (0.2.1-rc.2 on). */
interface AgentPresets { serviceFor?(agent: Agent, name: string): unknown }
/**
 * DSH's Web host composes compaction inside each session's preset, an isolated realm the host plane cannot see; the
 * host-plane service is what the TUI, or a profile that inserts one at the top level, provides.
 */
export function compactionFor(ctx: Pick<Context, 'get'>, agent: Agent): Pick<CompactionEngine, 'compactNow'> | undefined {
  const preset = (ctx.get('agentPresets') as AgentPresets | undefined)?.serviceFor?.(agent, 'compaction') as CompactionEngine | undefined;
  // 预设里没有（或旧宿主没有 agentPresets）就退回宿主平面服务。
  return preset ?? ctx.get('compaction') as CompactionEngine | undefined;
}
const unavailable = '未加载压缩服务：家会话所用的预设里和宿主上都没有压缩插件';
/** The manual compaction error says only which stage failed; what actually went wrong is in its cause. */
function failureText(error: unknown): string {
  const parts: string[] = [];
  // 沿 cause 链最多取 4 层，避免异常链成环时死循环。
  for (let current = error; current !== undefined && parts.length < 4; current = current instanceof Error ? current.cause : undefined) parts.push(errorText(current));
  return parts.join('：');
}
/** 把外部 AbortSignal 接进任意 promise：abort 后以 signal.reason 拒绝，finally 注销监听避免泄漏。 */
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let listener: ReturnType<typeof addAbortListener>;
  const aborted = new Promise<never>((_, reject) => { listener = addAbortListener(signal, () => reject(signal.reason)); });
  try { return await Promise.race([promise, aborted]); }
  finally { listener![Symbol.dispose](); }
}

/** One explicit request, held behind existing turns and cancelled with the life line. */
export function createHomeApply(deps: HomeApplyDeps) {
  let state: HomeApplyState = { status: 'idle' };
  // 单飞：同一时间只允许一个应用请求；pending 存在时 request() 直接返回。
  let controller: AbortController | undefined;
  let pending: Promise<void> | undefined;
  const stopped = new Error('世界已停止');
  function update(next: HomeApplyState): void {
    state = next; deps.changed();
    // The state only lives in memory, and the nightly request after the review has no one watching it.
    if (next.status === 'failed') { deps.ctx.logger.warn(`dsh-world: ${next.message ?? ''}`); deps.fault(next.message); }
    else if (next.status === 'done') { deps.ctx.logger.info(`dsh-world: ${next.message ?? ''}`); deps.fault(undefined); }
  }
  async function run(operation: AbortController): Promise<void> {
    const { signal } = operation;
    // 取家会话也要能被取消：世界停止时不能卡在 home()。
    const agent = await abortable(deps.home(), signal);
    const engine = deps.compaction(agent);
    if (!engine) throw new Error(unavailable);
    const check = () => {
      if (!signal.aborted && !deps.isHome(agent)) operation.abort(new Error('家会话已变化，请重新提交'));
      signal.throwIfAborted();
    };
    for (;;) {
      await abortable(agent.whenIdle(), signal);
      check();
      // entered 表示已经真正进入 maintenance；只有还没进入时的 busy 才值得等待重试，否则交给外层报失败。
      let entered = false;
      try {
        const result = await engine.compactNow({ session: agent.session, options: agent.options,
          runMaintenance: task => agent.runMaintenance(async agentSignal => {
            entered = true; check();
            update({ status: 'compacting', sessionId: agent.id });
            // 压缩流里的每一步和提交摘要前都确认没被取消/换会话。
            const dispose = deps.ctx.on('llm/stream', async function* (request, next) {
              if (request.purpose !== 'compaction' || request.sessionId !== agent.id) { yield* next(); return; }
              check();
              for await (const chunk of next()) { check(); yield chunk; }
              // Both stock and tool-free compactNow check this signal before committing their summary.
              check();
            });
            try {
              const result = await task(agentSignal);
              check(); agentSignal.throwIfAborted();
              // Refresh before maintenance releases queued input, including an empty selection.
              deps.refresh(agent.session);
              return result;
            } finally { dispose(); }
          }),
        }, signal);
        update({ status: 'done', sessionId: agent.id, message: result ? '已应用并压缩家会话，下轮使用已保存配置。' : '已应用已保存配置，家会话暂无内容，无需压缩。' });
        return;
      } catch (error) {
        // Input can claim the idle phase between whenIdle and compactNow; no summary has started yet.
        if (!entered && error instanceof ManualCompactionError && error.code === 'busy') { update({ status: 'waiting', sessionId: agent.id }); continue; }
        throw error;
      }
    }
  }
  return {
    snapshot: () => state,
    /** Failures, including a missing engine, arrive later as the `failed` state. */
    request(): undefined {
      // 已有请求在跑就忽略新的点击：面板会继续显示同一个状态。
      if (pending) return;
      controller = new AbortController();
      const { signal } = controller;
      update({ status: 'waiting' });
      // 把异常收敛成 failed/cancelled 状态；request() 本身不返回 promise。
      pending = run(controller).catch(error => {
        update({ ...state, status: signal.reason === stopped ? 'cancelled' : 'failed', message: signal.reason === stopped ? '已取消应用并压缩家会话。' : `应用并压缩失败：${failureText(signal.aborted ? signal.reason : error)}` });
      }).finally(() => { controller = undefined; pending = undefined; });
      return undefined;
    },
    // cancel 等 pending 结束再返回，调用方可以安全地紧接着重启世界。
    async cancel(): Promise<void> { controller?.abort(stopped); await pending; },
  };
}
