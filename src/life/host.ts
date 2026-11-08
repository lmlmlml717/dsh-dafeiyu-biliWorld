import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';

/** A workspace of the host: a directory that groups its sessions in the sidebar and opens new ones there. */
export interface HostWorkspace { id: string; sessionIds: readonly string[]; attachSession(sessionId: string): Promise<void> }
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
interface HostServices {
  sessionController: {
    create(request: ({ cwd: string } | { workspaceId: string }) & { agentPreset: string }): Promise<{ sessionId: string }>;
    resolveAgent(sessionId: string): Promise<{ agent: Agent } | { error: { code: string; message: string } }>;
    rename(request: { sessionId: string; title: string }): Promise<unknown>;
  };
  webServer: { getOrigin(): string };
  workspaceRegistry?: { archivedSessionIds: Iterable<string>; create(path: string, title: string): Promise<HostWorkspace> };
}
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
      if (found.error.code === 'session/not-found') return undefined;
      throw new Error(`dsh-world: home ${sessionId} cannot be resolved: ${found.error.message}`);
    },
    // Optional, so read without injecting it: Cordis throws on an un-injected property access.
    isArchived: sessionId => Array.from((ctx.get('workspaceRegistry') as HostServices['workspaceRegistry'])?.archivedSessionIds ?? []).includes(sessionId),
    rename: async (sessionId, title) => { await host.sessionController.rename({ sessionId, title }); },
    origin: () => host.webServer.getOrigin(),
  };
}
