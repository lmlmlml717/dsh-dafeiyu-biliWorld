/**
 * 相册工具：把当前消息里的图片收进相册、分页列出、移除。
 *
 * 导出：photoTools（返回三个 defineTool 的定义）。
 * 调用方：life/runtime.ts 在家会话里注册，和闹钟工具一起挂到 Agent 上。
 * 依赖：@deepseek-ai/dsh-tools 的 defineTool、photos.PhotoStore、宿主的 AttachmentStore。
 * 坑：只认本轮最新一条用户消息（或它的渠道引用）里的图片，避免把旧消息的图重复收藏；
 * 三个工具执行前都先确认「现在还是不是她的家」，离开世界后不能再用。
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { MessageId } from '@deepseek-ai/dsh-llm';
import { SessionSeq } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { PhotoStore } from './photos.ts';

/** Channel images stay in recall data, linked to the current message rather than shared memory. */
function currentImages(agent: Agent): ImageAttachmentRef[] {
  let messageId: MessageId | undefined;
  // 从最新的会话事件往回找，撞到本轮开始/结束就停：只认这一轮。
  for (let seq = agent.session.seq - 1; seq >= 0; seq--) {
    const event = agent.session.eventAt(SessionSeq(seq));
    if (event?.type === 'turn/start' || event?.type === 'turn/end') break;
    if (event?.type !== 'user/message') continue;
    const source = event.data.source;
    if (source.kind === 'user' || (source.kind === 'dsh-world-channel-context' && !source.forMessageId)) {
      if (messageId !== undefined) return [];
      // 又遇到一条用户消息：说明最新那条没带图，本轮就没有可收藏的东西。
      messageId = event.data.id;
      const images = event.data.content.flatMap(block => block.type === 'image' ? [block.attachment] : []);
      if (images.length) return images;
    } else if (source.kind === 'dsh-world-channel-context' && messageId !== undefined && source.forMessageId === messageId) {
      return event.data.content.flatMap(block => block.type === 'image' ? [block.attachment] : []);
    }
  }
  return [];
}
/**
 * 生成 keep_photo、list_photos、forget_photo 三个工具。
 * deps.inside 每次调用现判（家可能已经被换掉），store 也延迟到执行时才取。
 * @param deps agent 是挂工具的会话；store/attachments 延迟取；inside 返回现在能不能用。
 * @returns 三个工具定义，顺序固定。
 */
export function photoTools(deps: { agent: Agent; store(): PhotoStore; attachments(): AttachmentStore | undefined; inside(): boolean }) {
  const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };
  // 每次执行都重新确认：家会话可能在挂载之后被换掉。
  const check = () => { if (!deps.inside()) throw new Error('相册工具只能在当前家会话的世界工作区内使用'); };
  return [
    defineTool({ name: 'keep_photo', description: '想收藏当前消息里值得长期保留的图片时使用，由我自己决定。index 从 0 开始，只能选本轮最新消息中的图片（含本轮已读取的微信图片和引用图）；照片保存到我的相册，不自动加入之后每轮上下文。description 最多 500 字，tags 最多 8 个、每个 40 字。', parameters: { index: { type: 'integer' }, description: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, output,
      execute: async ({ index = 0, description = '', tags = [] }, context) => {
        check(); const images = currentImages(deps.agent);
        if (!Number.isSafeInteger(index) || index < 0 || index >= images.length) throw new Error('index 必须指向本轮最新用户消息中的图片');
        const attachments = deps.attachments();
        if (!attachments) throw new Error('宿主图片存储不可用');
        const image = await attachments.readImage(images[index]!, context.signal);
        // 读图期间可能被取消，写库之前再确认一次身份和状态。
        context.signal.throwIfAborted(); check();
        return JSON.stringify(deps.store().keep(image, description, tags));
      } }),
    defineTool({ name: 'list_photos', description: '分页查看我收藏的照片描述、标签、日期和尺寸，不读取图片正文。limit 默认 20、最多 100，offset 默认 0；hasMore 表示还有下一页。', parameters: { limit: { type: 'integer' }, offset: { type: 'integer' } }, output,
      execute: async ({ limit = 20, offset = 0 }) => { check(); return JSON.stringify(deps.store().list(limit, offset)); } }),
    defineTool({ name: 'forget_photo', description: '移除一张收藏及其相册内图片副本，id 必须来自 list_photos。不会删除原聊天消息或原始附件。', parameters: { id: { type: 'string', required: true } }, output,
      execute: async ({ id }) => { check(); deps.store().forget(id); return '已移出相册。'; } }),
  ];
}
