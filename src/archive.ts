/**
 * 归档的最基本一步：把宿主的一次会话事件翻译成一条待写入的记录（ConversationRecord）。
 *
 * 导出：conversationRecordId（记录主键）、visibleText（取可见正文）、isOrdinarySession（是不是真人会话）、
 * extractConversationRecords（事件 → 记录，可能为空数组）。
 * 调用方：sourceArchive.ts 的回放循环，它把结果交给 store.commitRecords。
 * 依赖：宿主 llm 的流式块、session 的 append 面判断，以及微信消息的渲染（replyMessages / replyText）。
 *
 * 坑：微信「已生成、发送未确认」的消息也记成 assistant，但正文是待发清单并带 wechatDelivery 状态；
 * 拿不到合法轮次时宁可抛错，也不猜一个 turn —— 记错轮次会让同一轮的话散到几处。
 */
import { createHash } from 'node:crypto';
import { lastAssistantStreamChunk, type ContentBlock } from '@deepseek-ai/dsh-llm';
import { isAppendSurfaceEvent, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
import type { ArchiveScope, ConversationRecord } from './types.ts';
import { identityPrefix, legacyIdentityPrefix, speakerIdentity } from './ecosystem/shared/identity.ts';
import { replyMessages, replyText } from './ecosystem/wechat/messages.ts';

/**
 * 一条归档记录的稳定主键：对世界、会话、消息三元组取 sha256。
 * @param worldId 世界标识，保证同一份会话日志在不同世界里互不覆盖。
 * @param sessionId 宿主会话 id。
 * @param messageId 宿主消息 id，同一条消息重放时得回同一个键。
 * @returns 64 位十六进制串，作为 records.recordId 与去重依据。
 */
export const conversationRecordId = (worldId: string, sessionId: string, messageId: string) =>
  createHash('sha256').update(JSON.stringify([worldId, sessionId, messageId])).digest('hex');

/**
 * 消息里真正给她看的部分：文本按顺序拼接，图片、文件用 JSON 摘要占位（附件本身不进归档）。
 * @param content 宿主消息的内容块数组。
 * @returns 以换行连接的正文；没有任何可见块时是空串，调用方据此丢弃这条事件。
 */
export function visibleText(content: readonly ContentBlock[]): string {
  return content.flatMap(block => {
    if (block.type === 'text') return [block.text];
    if (block.type === 'image' || block.type === 'file') return [JSON.stringify({ type: block.type, attachment: block.attachment })];
    return [];
  }).join('\n');
}

/** A session someone talks in: not a subagent, not delegated. Only these are archived or carry her world. */
export const isOrdinarySession = (header: Pick<SessionHeader, 'origin' | 'delegationDepth'>) => header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0;

/**
 * 把一个宿主会话事件翻译成零条或一条归档记录。
 *
 * 只收普通会话的 user/message 与 assistant/message：子代理、被委派的会话，以及继承来的事件都不归档。
 * @param event 宿主会话事件，实时收到的或回放读到的那一条。
 * @param scope 归档范围：世界、会话头、继承事件数，以及当前轮次（由回放循环在 turn/start 时更新）。
 * @returns 一条记录的数组；不是要归档的事件、正文为空、或来源不是真人时返回空数组。
 * @throws 微信待发消息的身份对不上、或拿不到合法轮次时抛错；回放方会把它记成会话级故障，不会静默跳过。
 */
export function extractConversationRecords(event: SessionEvent, scope: ArchiveScope): ConversationRecord[] {
  const { header } = scope;
  // 继承来的事件已经记在父会话名下了；这里再收一次，同一句话就会被两个会话各记一遍。
  if (!isOrdinarySession(header) || event.seq < scope.inheritedEventCount) return [];
  // 归档只收一问一答：工具调用、轮次边界、压缩标记都不是「谁说过的话」。
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return [];
  if (!isAppendSurfaceEvent(event)) return [];
  const message = event.type === 'user/message' ? event.data : event.data.message;
  const outgoing = event.type === 'user/message' && event.data.source.kind === 'dsh-world-wechat-outgoing' ? event.data.source : undefined;
  // 别的来源（记忆块、时间提示、生活线提醒）是程序放进去的，不算对话；只有真人说的和微信待发清单例外。
  if (event.type === 'user/message' && message.source.kind !== 'user' && !outgoing) return [];
  const identity = event.type === 'user/message' && 'identity' in message.source ? speakerIdentity(message.source.identity) : undefined;
  const sentMessages = outgoing ? replyMessages(outgoing.messages) : undefined;
  // 微信私聊的说话人必须就是账号本人；对不上说明来源标识不对，宁可整条失败也不把别人的话记成她的。
  if (outgoing && (identity?.channel !== 'wechat' || identity.speakerId !== `wechat:${identity.accountId}`)) throw new Error('Invalid WeChat outgoing identity');
  const visible = visibleText(message.content);
  // 三个前缀都要认：早期版本把「谁说的」直接写在正文里，升级后归档时仍要能剥掉，不能当成她的话留下；
  // 私聊主人那条还多一个「（你主人）」标记，不一起剥就会把整行身份写进她的记忆。
  const prefix = identity && [identityPrefix(identity), identityPrefix(identity, { owner: true }), legacyIdentityPrefix(identity)].find(prefix => visible.startsWith(prefix));
  const content = outgoing ? `微信待发送给 ${identity!.conversationId}（已生成，发送尚未确认）：\n${replyText(sentMessages!)}` : prefix ? visible.slice(prefix.length) : visible;
  if (!content) return [];
  // assistant 事件自带轮次；用户消息只能沿用 scope.turn，它由回放循环在 turn/start 时更新。
  const turn = event.type === 'assistant/message' ? event.data.turn : scope.turn;
  if (!Number.isSafeInteger(turn) || turn < 1) throw new Error(`dsh-world: no host turn for ${header.id}/${event.seq}`);
  return [{
    schemaVersion: 1, worldId: scope.worldId,
    recordId: conversationRecordId(scope.worldId, header.id, message.id),
    sourceSessionId: header.id, sourceMessageId: message.id, sourceSeq: event.seq,
    turnId: `${header.id}:${turn}`, role: event.type === 'user/message' && !outgoing ? 'user' : 'assistant',
    occurredAt: new Date(event.time).toISOString(), content, ...identity,
    // 待发送的行先记成 pending：真实发送结果由微信模块随后回填，归档在这里只保证「生成过、几条」不丢。
    ...(sentMessages ? { wechatDelivery: { status: 'pending' as const, confirmed: 0, total: sentMessages.length } } : {}),
    // 被打断或撞到 max-tokens 的回复标成 interrupted：记忆里要能看出那句话没说完，而不是当成完整回答。
    status: event.type === 'assistant/message' && (event.data.interrupted || lastAssistantStreamChunk(event.data.stream, 'finish')?.reason.kind === 'max-tokens') ? 'interrupted' : 'complete',
  }];
}
