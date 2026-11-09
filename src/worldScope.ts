/**
 * 「她的世界」的边界工具：成员判定、越界错误、只在世界内可用的工具包装，以及提示变更后的重新装配。
 *
 * 导出：InWorld 类型、OutsideWorldError、admit、scopedTool、registerWorldTool、reassembleOnChange。
 * 调用方：memoryTools.ts 与 runtime.ts 用它挂工具；生态渠道用它确认 agent 还在不在世界里。
 * 依赖：cordis 的 Context、dsh-agent 与 dsh-tools 的类型、dsh-system-prompt 的装配钩子。
 *
 * 坑：会话随时可能离开工作区，所以每一处入口都要重新问一遍：注入前、等待后、工具执行时。`when` 抛错会被宿主
 * 判成整个回合失败，所以成员关系读不到时一律按「不在」处理，把探测失败降级成这一次不挂工具。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

/**
 * Her world reaches only the sessions of her room's workspace (plus her persona, which follows the preset). A
 * session can join or leave the workspace at any time, so every way in checks again where it matters: before an
 * injection, after every wait, and when a tool runs.
 */
export type InWorld = (session: Session) => boolean;

/** 会话已经不在她的世界里：拒绝注入、拒绝工具调用时抛的固定错误。 */
export class OutsideWorldError extends Error {
  constructor() { super('会话不在世界工作区内'); this.name = 'OutsideWorldError'; }
}

/** The agent, if it is (still) in her world; without a predicate every agent is. */
export function admit(inWorld: InWorld | undefined, agent: Agent): Agent {
  if (inWorld && !inWorld(agent.session)) throw new OutsideWorldError();
  return agent;
}

/** The tool, refusing to run once its agent has left her world; `left` lets the owner take it away. */
export function scopedTool(tool: ToolDefinition, inside: () => boolean, left?: () => void): ToolDefinition {
  return { ...tool, execute: (args, exec) => {
    // 每次执行前再问一次；已经离开就顺手通知拥有者摘掉，并把错误抛给宿主，而不是假装成功。
    if (!inside()) { left?.(); throw new OutsideWorldError(); }
    return tool.execute(args, exec);
  } };
}

/**
 * 把「在不在她的世界里」登记成工具的 `when`，而不是只靠挂载/摘除。
 *
 * 0.2.2-rc.1 起，每一步的模型工具目录在 `tools.resolve` 里先算好（`when` 就在那一刻求值），
 * `system-prompt/assemble` 的水合排在它后面。以前在 assemble 里补挂工具、再触发一次 assemble 的做法，
 * 这一轮请求已经拿不到新目录了：宿主返回 assembly 时用的是水合之前算出的工具表。
 *
 * 写成 `when` 之后，可见性由宿主在解析阶段自己判断，注册表只要跟着 agent 的生命周期即可；`scopedTool`
 * 的执行期检查保留，处理解析之后才发生的离开。0.2.1 的 `register` 不认第二个参数（多出来的属性被忽略），
 * 在那里仍旧按原来的 attach/detach 工作，行为不变。
 */
export function registerWorldTool(agent: Agent, tool: ToolDefinition, inside: () => boolean, left?: () => void): () => void {
  // `when` 抛错会被宿主判成这一步的 ToolActivationError（整个回合失败）。成员关系读不到时按「不在」处理，
  // 与旧 attach 路径把异常记成故障、这一轮不挂工具的结果一致，不把探测失败升级成回合失败。
  const visible = (): boolean => { try { return inside(); } catch { return false; } };
  return agent.ctx.tools.register(scopedTool(tool, inside, left), { when: visible });
}

/**
 * Membership can change after `agent/created`, so whatever a session's world providers depend on is synced as its
 * system prompt is assembled; when `sync` changed something, the prompt is assembled again to include it.
 */
export function reassembleOnChange(ctx: Context, sync: (agent: Agent) => boolean): () => void {
  // sync 说变了就立刻重新装配：工具可见性在解析阶段就定了，晚一步这一轮就拿不到新目录。
  return ctx.on('system-prompt/assemble', (_assembly, context, next) => context.agent && sync(context.agent) ? context.agent.ctx.systemPrompt.assemble(context) : next());
}
