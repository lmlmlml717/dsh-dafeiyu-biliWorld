import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { createStickerLibrary } from '../src/ecosystem/wechat/stickerLibrary.ts';
import { createStickerTools } from '../src/ecosystem/wechat/stickerTools.ts';
import { speakerIdentity } from '../src/ecosystem/shared/identity.ts';

const identity = speakerIdentity({ channel: 'wechat', accountId: 'bot', speakerId: 'wechat:bot', conversationId: 'family@chatroom', conversationType: 'group', conversationName: '家人' });
const gif = (seed: string) => Buffer.concat([Buffer.from('GIF89a'), Buffer.from(seed.padEnd(16, '.'))]);
const context = { signal: new AbortController().signal } as ToolRunContext;

async function fixture(t: import('node:test').TestContext, answer: (fields: { chatId: string; stickerId: string }) => Promise<unknown> | unknown = () => { throw new Error('no adapter'); }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sticker-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = createStickerLibrary(join(root, 'stickers'));
  const stagingDir = join(root, 'stickers', 'incoming');
  await mkdir(stagingDir, { recursive: true });
  const asked: unknown[] = [];
  const tools = createStickerTools({ library, stagingDir, target: id => { if (id !== identity.conversationId && id !== 'mom') throw new Error('聊天不在配置中'); return identity; },
    ask: async (_identity, fields) => { asked.push(fields); return JSON.stringify(await answer(fields)); } });
  const run = (name: string, args: object) => tools.find(tool => tool.name === name)!.execute(args as never, context) as Promise<string>;
  return { library, stagingDir, tools, run, asked };
}
const stage = async (dir: string, data: Buffer) => {
  const md5 = createHash('md5').update(data).digest('hex');
  await writeFile(join(dir, `${md5}.gif`), data);
  return { md5, file: `${md5}.gif`, mediaType: 'image/gif', bytes: data.length };
};

test('the sticker tools are few and their descriptions stay short', async t => {
  const { tools } = await fixture(t);
  assert.deepEqual(tools.map(tool => tool.name), ['sticker_search', 'sticker_save', 'sticker_edit', 'sticker_remove']);
  const words = tools.reduce((sum, tool) => sum + [...tool.description].length, 0);
  assert.ok(words < 420, `descriptions total ${words} characters`);
});

test('saving takes the fetched original into the library, labelled, and cleans up what the adapter staged', async t => {
  const data = gif('from-chat');
  let staged: Awaited<ReturnType<typeof stage>>;
  const f = await fixture(t, async () => staged);
  staged = await stage(f.stagingDir, data);
  const saved = await f.run('sticker_save', { chatId: 'family@chatroom', messageId: 'message_0:77', tags: ['无语', '翻白眼'], name: '白眼' });
  assert.match(saved, /已收进表情库：st_[a-f0-9]{12}「白眼」/);
  assert.deepEqual(f.asked, [{ chatId: 'family@chatroom', limit: 1, stickerId: 'message_0:77' }]);
  assert.equal(existsSync(join(f.stagingDir, staged.file)), false, 'the staged copy is removed');
  const [sticker] = await f.library.list();
  assert.deepEqual([sticker!.name, sticker!.tags, sticker!.md5], ['白眼', ['无语', '翻白眼'], staged.md5]);

  staged = await stage(f.stagingDir, data);
  assert.match(await f.run('sticker_save', { chatId: 'mom', messageId: 'message_0:78', tags: ['别的'] }), /库里已经有这张/);
  assert.equal((await f.library.list()).length, 1);
  assert.equal(existsSync(join(f.stagingDir, staged.file)), false);
});

test('saving refuses bad ids and labels, a staged file that is not what was checked, and leaves nothing behind', async t => {
  let staged: Awaited<ReturnType<typeof stage>> | undefined;
  const f = await fixture(t, async () => staged);
  for (const args of [{ messageId: '' }, { messageId: 'x' }, { messageId: 'm.db:x' }, { chatId: 'stranger' }]) {
    await assert.rejects(f.run('sticker_save', { chatId: 'mom', messageId: 'm.db:1', tags: ['x'], ...args }));
  }
  assert.equal(f.asked.length, 0, 'bad ids and chats never reach the adapter');
  const real = gif('real');
  staged = await stage(f.stagingDir, gif('no-labels'));
  await assert.rejects(f.run('sticker_save', { chatId: 'mom', messageId: 'm.db:2', tags: [] }), /标签/);
  assert.equal(existsSync(join(f.stagingDir, staged.file)), false, 'a refused file is removed');
  staged = { ...(await stage(f.stagingDir, real)), md5: '0'.repeat(32) };
  await assert.rejects(f.run('sticker_save', { chatId: 'mom', messageId: 'm.db:2', tags: ['x'] }), /md5/);
  assert.equal(existsSync(join(f.stagingDir, staged.file)), false, 'even a refused file is removed');
  assert.deepEqual(await f.library.list(), []);
});

test('search answers with a few compact lines and says plainly when there is nothing', async t => {
  const f = await fixture(t);
  assert.match(await f.run('sticker_search', {}), /还是空的/);
  await f.library.add(gif('a'), { name: '收到', tags: ['收到', '明白'] });
  await f.library.add(gif('b'), { name: '哼', tags: ['傲娇'] });
  const hit = await f.run('sticker_search', { query: '傲娇' });
  assert.match(hit, /^共 2 张，显示 1 张：\nst_[a-f0-9]{12}｜哼｜傲娇$/);
  assert.match(await f.run('sticker_search', { query: '不存在的词' }), /没有匹配「不存在的词」.*共 2 张/);
  assert.equal((await f.run('sticker_search', {})).split('\n').length, 3, 'a header and both stickers, newest first');
});

test('edit and remove work through the tools and say what they did', async t => {
  const f = await fixture(t);
  const { sticker } = await f.library.add(gif('c'), { name: '旧', tags: ['旧'] });
  assert.match(await f.run('sticker_edit', { id: sticker.id, tags: ['新'] }), /已更新.*新/);
  await assert.rejects(f.run('sticker_edit', { id: sticker.id }), /name 或 tags/);
  await assert.rejects(f.run('sticker_edit', { id: 'st_000000000000', name: 'x' }), /没有这个表情/);
  assert.match(await f.run('sticker_remove', { id: sticker.id }), /已移出/);
  assert.deepEqual(await f.library.list(), []);
});
