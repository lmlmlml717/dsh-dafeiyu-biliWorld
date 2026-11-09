/**
 * 宿主的会话与工作区接口，把 Cordis 服务收窄成生活线需要的那几个方法。
 *
 * 导出：HostWorkspace、LifeHost、hostLife。
 * 调用方：life/runtime.ts、ecosystem/shared/sessions.ts（群聊各自开一间屋子）。
 * 依赖：@deepseek-ai/cordis 的 Context；sessionController/webServer/workspaceRegistry 由宿主提供。
 * 坑：workspaceRegistry 是可选服务，必须用 ctx.get 读、不能直接取属性，否则 Cordis 会因未注入而抛错；
 * resolveAgent 只把 session/not-found 当「不存在」，其余错误照实抛出。
 */
/**
 * 【链路位置】
 * 链路的宿主接口层：她的家由它建、被它找回，回顾和闹钟的投递因此才有一个落点。
 * 上游：runtime.ts 把 LifeHost 交给 home.ts；群聊的生态模块也借它各开一间屋子。
 * 下游：Cordis 的 sessionController 与 webServer；workspaceRegistry 是可选服务。
 * 读写：不碰世界目录；会话与工作区都由宿主持有，这里只转调。
 * 失败：找会话只有 session/not-found 算「不存在」，其余错误照实抛出。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';

/** A workspace of the host: a directory that groups its sessions in the sidebar and opens new ones there. */
export interface HostWorkspace { id: string; sessionIds: readonly string[]; attachSession(sessionId: string): Promise<void> }
/** 生活线用到的宿主能力；实现见 hostLife，测试可以整体替换。 */
export interface LifeHost {
  /** In `workspaceId` when given (its directory is the cwd), otherwise in `cwd`. */
  createSession(cwd: string, agentPreset: string, workspaceId?: string): Promise<string>;
  /** The workspace owning `path`, registered under `title` if none does; undefined when the host keeps no workspaces. */
  workspace(path: string, title: string): Promise<HostWorkspace | undefined>;
  /** The live or resumed Agent, or `undefined` when the session no longer exists; other failures throw. */
  resolveAgent(sessionId: string): Promise<Agent | undefined>;
  isArchived(sessionId: string): boolean;
  rename(sessionId: string, title: string): Promise<void>;
  origin(): string;
}
/**
 * 【上游参考】
 * DSH 宿主把会话、工作区、网页服务做成 Cordis 服务；这里只按生活线要用的几个方法收窄，
 * 不直接碰宿主的存储，测试也能整体换成一个假的 LifeHost。
 */
interface HostServices {
  sessionController: {
    create(request: ({ cwd: string } | { workspaceId: string }) & { agentPreset: string }): Promise<{ sessionId: string }>;
    resolveAgent(sessionId: string): Promise<{ agent: Agent } | { error: { code: string; message: string } }>;
    rename(request: { sessionId: string; title: string }): Promise<unknown>;
  };
  webServer: { getOrigin(): string };
  workspaceRegistry?: { archivedSessionIds: Iterable<string>; create(path: string, title: string): Promise<HostWorkspace> };
}
/**
 * 从 Cordis 上下文取出宿主服务，包装成 LifeHost；可选服务缺失时在调用点才失败。
 * @param ctx Cordis 上下文，需已注入 sessionController 与 webServer。
 * @returns 收窄后的 LifeHost；workspaceRegistry 不存在时 workspace() 返回 undefined。
 */
/**
 * 谁调用：插件入口建生活线时传入 ctx，runtime 再把它交给 home。
 * 参数：ctx 需已注入 sessionController 与 webServer；workspaceRegistry 缺了也能跑。
 * 返回：收窄后的 LifeHost，六个方法各自转调宿主服务。
 * 失败：可选服务缺失只在调用点失败；resolveAgent 的其它错误包成中文后抛出。
 */
export function hostLife(ctx: Context): LifeHost {
  const host = ctx as unknown as HostServices;
  return {
    createSession: async (cwd, agentPreset, workspaceId) => (await host.sessionController.create({ ...(workspaceId ? { workspaceId } : { cwd }), agentPreset })).sessionId,
    // Optional like isArchived; `create` returns the existing workspace of a directory without retitling it.
    workspace: async (path, title) => {
      const registry = ctx.get('workspaceRegistry') as Partial<NonNullable<HostServices['workspaceRegistry']>> | undefined;
      return registry?.create ? registry.create(path, title) : undefined;
    },
    async resolveAgent(sessionId) {
      const found = await host.sessionController.resolveAgent(sessionId);
      if ('agent' in found) return found.agent;
      // 只有「真的没了」才算不存在；其余错误代表宿主出了问题，不能吞成空。
      if (found.error.code === 'session/not-found') return undefined;
      throw new Error(`dsh-world: home ${sessionId} cannot be resolved: ${found.error.message}`);
    },
    // Optional, so read without injecting it: Cordis throws on an un-injected property access.
    isArchived: sessionId => Array.from((ctx.get('workspaceRegistry') as HostServices['workspaceRegistry'])?.archivedSessionIds ?? []).includes(sessionId),
    rename: async (sessionId, title) => { await host.sessionController.rename({ sessionId, title }); },
    origin: () => host.webServer.getOrigin(),
  };
}
