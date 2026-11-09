/**
 * 把生活线和相册工具挂到 Agent 上，并在会话离开她的世界时摘掉。
 *
 * 导出：createToolRegistry。
 * 调用方：life/runtime.ts 在 agent 创建、pre-step、世界范围变化时调用。
 * 依赖：worldScope.registerWorldTool、faults、@deepseek-ai/dsh-tools 的类型。
 * 坑：闹钟工具每个世界会话都挂（她在哪儿都能定闹钟），reach_out/相册只挂当前的家；
 * 一组工具要么全挂上要么全不挂，挂到一半失败要回滚，绝不阻断 agent 创建；
 * 工具执行时还会再查一次 inWorld，防止会话被移出世界后继续用。
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-tools';
import { errorText, type Faults } from '../faults.ts';
import { registerWorldTool } from '../worldScope.ts';
import type { ToolDefinition, ToolGuard } from '@deepseek-ai/dsh-tools';

type Registration = (() => void)[];
// 闹钟工具跟人走；相册和 reach_out 只属于当前的家。
const ALARM_TOOLS = ['plan_next', 'check_alarm', 'cancel_alarm'];
const HOME_TOOLS = ['reach_out', 'keep_photo', 'list_photos', 'forget_photo'];

/** Disposes in reverse; a disposer whose agent scope is already gone may throw and is skipped. */
function undo(list: Registration): void {
  for (const dispose of list.splice(0).reverse()) { try { dispose(); } catch { /* scope already disposed */ } }
}

/**
 * The alarm tools are held by every world session (she can set her alarm anywhere; it rings at home), with `guard`
 * checking each of its tool calls; reach_out only by the current home. A registration that fails (a name clash) is a fault and never breaks
 * agent creation; it registers all of a group or none. Each tool refuses to run once its session leaves her world.
 */
export function createToolRegistry(deps: { faults: Faults; logger: { error(...args: unknown[]): void }; tools: (agent: Agent) => readonly ToolDefinition[]; isHome(agent: Agent): boolean; inWorld(agent: Agent): boolean; guard?: ToolGuard }) {
  const alarm = new Map<Agent, Registration>();
  const home = new Map<Agent, Registration>();
  function register(agent: Agent, tools: readonly ToolDefinition[], names: string[]): Registration {
    const done: Registration = [];
    // 先全部注册成功再交给调用方；中途失败由调用方 undo 已挂上的部分。
    try { for (const tool of tools) if (names.includes(tool.name)) done.push(registerWorldTool(agent, tool, () => deps.inWorld(agent))); }
    catch (error) { undo(done); throw error; }
    return done;
  }
  function forget(agent: Agent): void { alarm.delete(agent); home.delete(agent); deps.faults.clear(`attach:${agent.id}`); }
  return {
    /** Registers what the agent is missing; true when its tool list changed. */
    attach(agent: Agent): boolean {
      // 已经挂过就什么都不做：pre-step 每一步都会来问一次。
      const needsAlarm = !alarm.get(agent)?.length, needsHome = deps.isHome(agent) && !home.get(agent)?.length;
      if (!needsAlarm && !needsHome) return false;
      let changed = false;
      try {
        const tools = deps.tools(agent);
        if (needsAlarm) {
          const done = register(agent, tools, ALARM_TOOLS);
          // The world sessions' own policy comes and goes with their alarm tools.
          try { if (deps.guard) done.push(agent.ctx.tools.guard(execution => deps.inWorld(agent) ? deps.guard!(execution) : undefined)); }
          catch (error) { undo(done); throw error; }
          alarm.set(agent, done); changed = true;
        }
        if (needsHome) { home.set(agent, register(agent, tools, HOME_TOOLS)); changed = true; }
        deps.faults.clear(`attach:${agent.id}`);
      } catch (error) { deps.faults.set(`attach:${agent.id}`, `工具挂载失败：${errorText(error)}`); deps.logger.error(error); }
      return changed;
    },
    forget,
    /** Takes every tool away from an agent that left her world; true when it had any. */
    detach(agent: Agent): boolean {
      // 离开世界：两组的 disposer 都跑一遍，再清掉记录。
      const lists = [alarm.get(agent), home.get(agent)];
      const changed = lists.some(list => list?.length);
      for (const list of lists) if (list) undo(list);
      forget(agent);
      return changed;
    },
    /** A rebuilt home takes reach_out from the old one. */
    releaseOldHomes(): void { for (const [agent, list] of home) if (!deps.isHome(agent)) undo(list); },
    clear(): void {
      for (const list of [...home.values(), ...alarm.values()]) undo(list);
      home.clear(); alarm.clear();
    },
  };
}
