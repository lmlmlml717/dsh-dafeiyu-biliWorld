// 回复通道的两条边：她连着说几段时每段都要发；工具旁白不能当答复发出去。
import assert from 'node:assert/strict';
import test from 'node:test';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { hostFixture, textResponse } from './hostFixture.ts';
import { createQqNativeModule, type QqNativeConfig, type QqPart, type QqTransport } from '../src/ecosystem/qq-native/index.ts';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const settle = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms));

/** 一条 assistant 消息里既有正文、又带一次工具调用：这一轮会继续，她说的是过程话。 */
async function* sayThenTool(text: string, name: string): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  const id = ToolCallId(`${name}-call`);
  const block = { type: 'tool-call' as const, id, name, arguments: '{}' };
  yield { type: 'block-start', index: 1, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 1, id, name, argumentsDelta: '{}' };
  yield { type: 'block-end', index: 1, block };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}

function transport() {
  const sent: { to: string; parts: string | QqPart[] }[] = [];
  let options: { onPrivateMessage?(message: unknown): void } | undefined;
  const factory = (next: { onPrivateMessage?(message: unknown): void }): QqTransport => {
    options = next;
    return {
      async start() {}, async stop() {}, getState: () => 'online',
      sendGroup: async () => ({ messageId: 'g' }),
      sendPrivate: async (to: string, parts: string | QqPart[]) => { sent.push({ to, parts }); return { messageId: String(sent.length) }; },
    };
  };
  return { factory, sent, private: (message: unknown) => options?.onPrivateMessage?.(message) };
}

const config: QqNativeConfig = {
  enabled: true, wsUrl: 'ws://127.0.0.1:1', accessToken: '', allowPrivate: ['100'], ownerQQ: '100', allowGroups: [],
  autoReply: true, contextMessages: 3, batchQuietMs: 0, groupTrigger: 'mention', groupKeywords: [], mutedUntil: '',
  snowlumaHome: '', supervise: false, bindHomeSession: 'none', bridge: { port: 0, token: '', title: '阳台', contextMessages: 6 },
};

async function channel(t: test.TestContext, model: Parameters<typeof hostFixture>[1]) {
  const { ctx, cleanup } = await hostFixture(t, model);
  const agent = (await ctx.agents.create({ sessionId: SessionId('qq-home'), agentOptions: { provider: 'test', model: 'test' } })).agent;
  const wire = transport();
  const module = createQqNativeModule({ ctx, home: async () => agent, config: () => config, logger: quiet, transport: wire.factory, isHome: id => id === agent.id });
  cleanup.push(() => module.stop());
  module.start();
  return { ctx, wire, cleanup };
}

test('0.9.6：她一段话分四段说，QQ 收到四条，顺序不变', async t => {
  const { wire } = await channel(t, () => textResponse('第一段。\n\n第二段。\n\n第三段。\n\n第四段。'));
  wire.private({ kind: 'private', groupId: null, userId: '100', messageId: 'm1', selfId: '9', text: '在吗' });
  await settle(3_000);
  assert.deepEqual(wire.sent.map(item => item.parts), ['第一段。', '第二段。', '第三段。', '第四段。']);
});

test('0.9.6：工具旁白不是答复——只有最后那句发到 QQ', async t => {
  let calls = 0;
  const { ctx, wire } = await channel(t, () => (async function* (): AsyncIterable<StreamChunk> {
    if (calls++ === 0) { yield* sayThenTool('我先查一下', 'check'); return; }
    yield { type: 'finish', reason: { kind: 'stop' } };
  })());
  ctx.tools.register(defineTool({
    name: 'check', description: 'check', parameters: {},
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] },
    execute: async () => 'done',
  }));
  wire.private({ kind: 'private', groupId: null, userId: '100', messageId: 'm2', selfId: '9', text: '查一下' });
  await settle(1_500);
  assert.deepEqual(wire.sent, [], '过程话不能当答复发出去');
});
