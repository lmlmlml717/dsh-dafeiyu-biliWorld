import type { ConversationRecord } from '../src/types.ts';
export function record(id: string, input: Partial<ConversationRecord> = {}): ConversationRecord {
  return { schemaVersion: 1, worldId: 'fish', recordId: id, sourceSessionId: 'a', sourceMessageId: id,
    sourceSeq: Number(id.replace(/\D/g, '')) || 1, turnId: `a:${id}`, role: 'assistant',
    occurredAt: '2026-10-23T12:30:00.000Z', content: id, status: 'complete', ...input };
}
