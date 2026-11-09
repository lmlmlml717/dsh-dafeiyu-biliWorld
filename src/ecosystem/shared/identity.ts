/**
 * 渠道身份：校验发言人是谁、属于哪个会话，并生成她看到的会话前缀。
 *
 * 导出：SpeakerIdentity、speakerIdentity、conversationKey、chatLabel、chatName、identityPrefix、
 * legacyIdentityPrefix、IDENTITY_HEADER_LINE。
 * 调用方：qq/微信渠道的入站装配、shared/context 与 shared/sessions。
 * 依赖：无。
 * 坑：身份只从适配器的结构化字段来，绝不从消息正文猜；speakerId 必须带 `频道:` 前缀；
 * 会话键固定是「频道+账号+私聊/群+会话 id」四元组，改了会让老会话全部对不上。
 */
/** 一条渠道消息的身份；群聊里还带发言人名字和 @ 名单。 */
export interface SpeakerIdentity {
  channel: string;
  accountId: string;
  conversationId: string;
  speakerId: string;
  speakerName?: string;
  conversationType?: 'private' | 'group';
  conversationName?: string;
  platformMessageId?: string;
  mentionIds?: string[];
}

/** Structured adapter metadata only; message text is never an identity source. */
export function speakerIdentity(value: unknown): SpeakerIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid identity');
  const input = value as Record<string, unknown>;
  for (const key of ['channel', 'accountId', 'conversationId', 'speakerId']) {
    const field = input[key];
    if (typeof field !== 'string' || !field.trim() || field.length > 256 || /[\u0000-\u001f\u007f]/.test(field)) throw new TypeError(`invalid ${key}`);
  }
  const channel = input.channel as string;
  const speakerId = input.speakerId as string;
  if (!/^[a-z][a-z0-9-]*$/.test(channel) || !speakerId.startsWith(`${channel}:`) || speakerId.length === channel.length + 1) throw new TypeError('invalid speakerId namespace');
  for (const key of ['speakerName', 'conversationName']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 256 || /[\u0000-\u001f\u007f]/.test(input[key]))) throw new TypeError(`invalid ${key}`);
  if (input.conversationType !== undefined && input.conversationType !== 'private' && input.conversationType !== 'group') throw new TypeError('invalid conversationType');
  if (input.platformMessageId !== undefined && (typeof input.platformMessageId !== 'string' || !input.platformMessageId.trim() || input.platformMessageId.length > 256 || /[\u0000-\u001f\u007f]/.test(input.platformMessageId))) throw new TypeError('invalid platformMessageId');
  if (input.mentionIds !== undefined && (!Array.isArray(input.mentionIds) || input.mentionIds.length > 64 || input.mentionIds.some(id => typeof id !== 'string' || !id.startsWith(`${channel}:`) || id.length <= channel.length + 1 || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)))) throw new TypeError('invalid mentionIds');
  return { channel, accountId: input.accountId as string, conversationId: input.conversationId as string, speakerId,
    ...(input.speakerName === undefined ? {} : { speakerName: input.speakerName as string }),
    ...(input.conversationType === undefined ? {} : { conversationType: input.conversationType as 'private' | 'group' }),
    ...(input.platformMessageId === undefined ? {} : { platformMessageId: input.platformMessageId as string }),
    ...(input.mentionIds === undefined ? {} : { mentionIds: [...input.mentionIds as string[]] }),
    ...(input.conversationName === undefined ? {} : { conversationName: input.conversationName as string }) };
}

/** 会话的唯一键；同一个群的两个人算同一个会话，同一个人在两个频道算两个。 */
export function conversationKey(identity: SpeakerIdentity): string {
  return JSON.stringify([identity.channel, identity.accountId, identity.conversationType ?? 'private', identity.conversationId]);
}

// 渠道名说成人话；没认出来的渠道原样显示。
const appName = (channel: string) => channel === 'wechat' ? '微信' : channel === 'qq' || channel === 'qq-bridge' ? 'QQ' : channel;
/** A chat as she reads it: 微信「Ken」, 微信群「一家人」, QQ群「…」. */
export function chatLabel(channel: string, conversationType: SpeakerIdentity['conversationType'], name: string): string {
  return `${appName(channel)}${conversationType === 'group' ? '群' : ''}「${name}」`;
}
/** The chat's own name, or for a private chat the person it is with. */
export const chatName = (identity: Pick<SpeakerIdentity, 'conversationName' | 'conversationType' | 'speakerName'>) =>
  identity.conversationName ?? (identity.conversationType === 'group' ? undefined : identity.speakerName);

/**
 * Opens every channel message she receives: which chat, who in a group, and the chatId her send tools take. Kept to
 * one short line because it stays in her context with every message; the full identity rides on the message source.
 *
 * `owner` 标的是「这个私聊里的人就是主人」。她刚从记忆被清空的状态里出来时，只看到名字「伙伴」并不能把
 * 它和「主人」对上（实测她回的是「我认识的人里没有一个这么说话的……再这么含糊我就当你发错人了」）。
 * 所以这一条要在**每一句**上都明说，而不是靠人设里一句「看到这两个字就知道是你」去推。
 */
export function identityPrefix(identity: SpeakerIdentity, options: { owner?: boolean } = {}): string {
  const speaker = identity.conversationType === 'group' ? ` ${identity.speakerName ?? identity.speakerId} 说` : '';
  // 只标私聊：群里「（你主人）」会跟着发言人名字跑（「（你主人） 甲 说」），自相矛盾，也让人以为整群人都是主人。
  const mine = options.owner && identity.conversationType !== 'group' ? '（你主人）' : '';
  return `【${chatLabel(identity.channel, identity.conversationType, chatName(identity) ?? identity.conversationId)}${mine}${speaker}，chatId ${identity.conversationId}】\n`;
}
/** Channel messages from 0.7.0 and earlier opened with the whole identity; an upgraded log may still hold some. */
export const legacyIdentityPrefix = (identity: SpeakerIdentity) => `【消息来源 ${JSON.stringify(identity)}】\n`;
/** A whole line that is one of the headers above, new or legacy, whoever it names. */
export const IDENTITY_HEADER_LINE = /^【(?:消息来源 \{.*\}|[^【】\n]*，chatId [^【】\n]+)】$/;
