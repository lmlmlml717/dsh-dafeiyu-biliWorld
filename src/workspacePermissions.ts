/**
 * 房间工作区的默认权限：新建会话落在她的房间里时，套用世界设置里的那一档。
 *
 * 导出：createWorkspacePermissions（挂 agent/created 钩子，并给出控制台要的选项快照）。
 * 调用方：index.ts 在控制台那侧建一份，快照进面板，设置值来自 worldSwitch。
 * 依赖：宿主的 permissionPresets 服务和 agent/created 事件、路径真实化（Windows 上统一大小写）。
 *
 * 坑：只对「新建」的会话动手（启动时创建、还没被写过、没有父会话、不是子代理），不去改用户自己已经建好的会话；
 * 只认路径相等的房间工作区，并按真实路径比较，免得同一个目录因大小写或符号链接被认成两个。
 */
import { existsSync, realpathSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';

/** 宿主权限预设的一个选项：值、显示名，以及可选的说明。 */
interface PermissionOption { value: string; name: string; description?: string }
/** 宿主权限预设服务的两个能力：列出可选档位、给某个会话套用一档。 */
interface PermissionPresets {
  catalog(): { defaultOptions: PermissionOption[] };
  set(session: Session, name: string): void;
}

/** The host seeds every session; a workspace default overrides that seed only on fresh creation. */
export function createWorkspacePermissions(ctx: Context, roomDir: string, settings: { workspacePermission(): string; setWorkspacePermission(value: string): void }) {
  const presets = ctx.get('permissionPresets') as PermissionPresets;
  ctx.on('agent/created', ({ agent, source }) => {
    const { session } = agent, header = session.header;
    // 只接管「启动时新建、还没被写过、没有父会话、不是子代理」的会话：别人已经在用的会话不能事后改权限。
    if (source !== 'startup' || header.isSeeded || header.parentSession || header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0 || !header.cwd || !existsSync(header.cwd) || !existsSync(roomDir)) return undefined;
    // Native resolution canonicalizes case on Windows, where the JS fallback keeps the input's spelling.
    if (realpathSync.native(header.cwd) === realpathSync.native(roomDir)) presets.set(session, settings.workspacePermission());
    return undefined;
  }, { prepend: true });
  return {
    // 面板要的是当前默认值和可选档位；档位直接来自宿主，插件不另定义一套名字。
    snapshot: () => ({ defaultPermission: settings.workspacePermission(), options: presets.catalog().defaultOptions }),
    set(permission: string): void {
      // 只收宿主认得的档位：写进 world.json 之后没法再校验，入口这里必须拦住。
      if (!presets.catalog().defaultOptions.some(option => option.value === permission)) throw new Error('未知的工作区权限选项');
      settings.setWorkspacePermission(permission);
    },
  };
}
