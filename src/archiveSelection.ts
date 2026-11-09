/**
 * 「哪些会话算她的」这条规则的唯一实现：家在哪个工作区，就收那个工作区的普通会话。
 *
 * 导出：MemoryArchiveScope（范围取值）、validArchiveScope（读配置时的校验）、createArchiveSelection（归档范围）、
 * createWorkspaceMembership（世界触达范围）。
 * 调用方：index.ts 建记忆服务与运行时的时候注入；memory.ts、runtime.ts 只拿回调，不自己判断范围。
 * 依赖：宿主的 workspaceRegistry 与调用方给的家会话判定；没有工作区服务时抛错，不静默降级。
 *
 * 坑：一律按房间目录的真实路径认领工作区，不认预设名或显示名 —— 从旧工作区搬过来的家仍留在旧列表里，
 * 不能因此把那个工作区也认成她的。宿主还没起工作区服务时成员判断返回 false：宁可这一轮不收，也不乱收。
 */
import { existsSync, realpathSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';

/** 归档范围：只收她家的会话（home），或收她房间所在工作区的全部普通会话（workspace）。 */
export type MemoryArchiveScope = 'home' | 'workspace';
/**
 * 配置或 world.json 里读出来的归档范围是否合法。
 * @param value 任意来路的值。
 * @returns 为 'home' 或 'workspace' 时是；其余（含 undefined 与已废弃的 'world'）都不是。
 */
export const validArchiveScope = (value: unknown): value is MemoryArchiveScope => value === 'home' || value === 'workspace';

interface Workspace { path: string; sessionIds: readonly string[] }
// 工作区列表每次都现取：成员随会话开关变，插件不缓存它。
const workspaces = (ctx: Context) => (ctx.get('workspaceRegistry') as { list(): Workspace[] } | undefined)?.list();
/** Native resolution canonicalizes case on Windows, as the host's registry does. */
const byPath = (roomDir: string) => (workspace: Workspace) => workspace.path === (existsSync(roomDir) ? realpathSync.native(roomDir) : roomDir);

/**
 * Whose conversations her archive keeps: her home, or every session of her room's workspace. The room is found by
 * its path, as for her world's reach: a home moved in from an older workspace stays listed there too, and that
 * workspace must not become hers. Workspace membership comes from the host, never a preset or a display name.
 */
export function createArchiveSelection(ctx: Context, scope: MemoryArchiveScope, isHome: (id: string) => boolean, roomDir: string): (id: string) => boolean {
  return id => {
    if (scope === 'home') return isHome(id);
    const all = workspaces(ctx);
    // 配了工作区归档却没有工作区服务：这是配置错，当场说出来，不能悄悄当成「谁都不收」。
    if (!all) throw new Error('工作区归档需要宿主工作区服务');
    // 找不到房间所在的工作区（宿主还没登记它）时算「不在」，不猜。
    return all.find(byPath(roomDir))?.sessionIds.includes(id) ?? false;
  };
}

/**
 * Whether a session is in her room's workspace. Found by the room's path only, so a home recorded elsewhere cannot
 * pull another workspace in; nothing is while the host keeps no workspaces (or has not started them yet).
 */
export function createWorkspaceMembership(ctx: Context, roomDir: string): (id: string) => boolean {
  return id => workspaces(ctx)?.find(byPath(roomDir))?.sessionIds.includes(id) ?? false;
}
