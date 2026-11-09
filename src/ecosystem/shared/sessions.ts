/**
 * 每个渠道会话一间屋子：按会话键复用或新建 Agent，并保证它属于房间工作区。
 *
 * 导出：createChannelSessions。
 * 调用方：微信/QQ 渠道的装配层，用 open(identity) 拿到能说话的 Agent。
 * 依赖：host.LifeHost、store 的 channelSession/bindChannelSession、shared/identity。
 * 坑：同一会话的并发 open 共享一个 promise，避免建出两间屋子；新会话的第一轮结束后补标题，
 * 因为宿主会用第一句 prompt 覆盖；归档的会话视为不存在，重新建。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-session';
import { conversationKey, type SpeakerIdentity } from './identity.ts';
import type { LifeHost } from '../../life/host.ts';
import type { ArchiveStore } from '../../store.ts';

/**
 * 返回 open/stop；stop 之后所有 open 都抛错，晚到的回调也不会再改名。
 * @param deps 宿主、归档存储、房间路径、房间标题与 agent 预设。
 * @returns open/stop；同一会话并发 open 共享同一个 promise。
 */
export function createChannelSessions(deps: { ctx: Context; host: LifeHost; store: Pick<ArchiveStore, 'channelSession' | 'bindChannelSession'>; roomDir: string; roomTitle: string; agentPreset: string }) {
  const opening = new Map<string, Promise<Agent>>();
  // 新会话建好到第一轮结束之间，标题会被首句 prompt 覆盖，届时再补。
  const firstTitles = new Map<string, string>();
  let stopped = false;
  // 只关心第一轮结束：补一次标题后就不再听这个会话。
  const dispose = deps.ctx.on('session/event', (session, event) => {
    const title = firstTitles.get(session.id);
    if (event.type !== 'turn/end' || !title || stopped) return;
    firstTitles.delete(session.id);
    void deps.host.rename(session.id, title).catch(error => deps.ctx.logger.error(error));
  });
  async function resolve(identity: SpeakerIdentity): Promise<Agent> {
    if (stopped) throw new Error('Channel sessions stopped');
    const key = conversationKey(identity);
    const title = `${identity.channel === 'wechat' ? '微信' : identity.channel === 'qq' ? 'QQ' : identity.channel} · ${identity.conversationName || identity.conversationId}`;
    const workspace = await deps.host.workspace(deps.roomDir, deps.roomTitle);
    if (!workspace) throw new Error('群聊需要支持工作区的宿主');
    let id = deps.store.channelSession(key);
    // 记着的会话还在、没被归档才复用；否则重新建。
    let agent = id && !deps.host.isArchived(id) ? await deps.host.resolveAgent(id) : undefined;
    if (!agent) {
      if (stopped) throw new Error('Channel sessions stopped');
      id = await deps.host.createSession(deps.roomDir, deps.agentPreset, workspace.id);
      deps.store.bindChannelSession(key, id);
      firstTitles.set(id, title);
      agent = await deps.host.resolveAgent(id);
      if (!agent) throw new Error('新建群聊会话无法打开');
    } else if (!workspace.sessionIds.includes(agent.id)) await workspace.attachSession(agent.id);
    if (stopped) throw new Error('Channel sessions stopped');
    await deps.host.rename(agent.id, title);
    return agent;
  }
  return {
    open(identity: SpeakerIdentity): Promise<Agent> {
      const key = conversationKey(identity);
      let pending = opening.get(key);
      if (!pending) { pending = resolve(identity).finally(() => opening.delete(key)); opening.set(key, pending); }
      return pending;
    },
    stop() { stopped = true; dispose(); firstTitles.clear(); },
  };
}
