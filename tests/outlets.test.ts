import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { busyText, createOutlet, outletUrl, plainMessage, pushOf, readBaseUrl } from '../src/ecosystem/shared/outlets.ts';

const BOM = String.fromCharCode(0xfeff);
async function tempDir(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-world-outlet-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function fakeFetch(reply: () => Promise<Response> = () => Promise.resolve(Response.json({ ok: true }))) {
  const calls: { url: string; body: any; signal: unknown; method?: string }[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)), signal: init.signal, method: init.method }); return reply(); }) as typeof fetch;
  return { calls, fetchImpl };
}

test('stickers come out of her markdown as images and the text is reduced to plain lines', () => {
  assert.deepEqual(plainMessage('![开心](http://127.0.0.1:5173/dsh-deepseek-meme/assets/a?size=150)\n## 好呀\n**今天**去 __公园__，带上 `伞`。\n\n![x](http://h/b.png "title")'), {
    text: '好呀\n今天去 公园，带上 伞。', images: ['http://127.0.0.1:5173/dsh-deepseek-meme/assets/a?size=150', 'http://h/b.png'],
  });
  assert.deepEqual(plainMessage('只有字\n第二行'), { text: '只有字\n第二行', images: [] });
});
test('a reply that is only stickers keeps their alt text, since an outlet may drop a push without text', () => {
  assert.deepEqual(plainMessage('![哼](http://h/a.png) ![得意](http://h/b.png)'), { text: '哼 得意', images: ['http://h/a.png', 'http://h/b.png'] });
  assert.deepEqual(plainMessage('![](http://h/a.png)'), { text: '（表情包）', images: ['http://h/a.png'] });
  assert.equal(plainMessage('').text, '');
});
test('a sticker URL without an origin is resolved against the DSH origin; other schemes are dropped', () => {
  assert.deepEqual(plainMessage('![a](/dsh-deepseek-meme/assets/a?size=150) 嗨 ![b](javascript:alert(1)) ![c](<http://h/c.png>)', 'http://127.0.0.1:5173'), {
    text: '嗨', images: ['http://127.0.0.1:5173/dsh-deepseek-meme/assets/a?size=150', 'http://h/c.png'],
  });
  assert.deepEqual(plainMessage('![a](/x.png) 嗨').images, [], 'no origin, no relative image');
});
test('a base URL is read from a JSON file, with or without a BOM', async t => {
  const dir = await tempDir(t); const file = join(dir, 'running.json');
  await writeFile(file, BOM + JSON.stringify({ baseUrl: 'http://127.0.0.1:7340/', pid: 1 }));
  assert.equal(readBaseUrl(file), 'http://127.0.0.1:7340');
  await writeFile(file, JSON.stringify({ pid: 1 }));
  assert.throws(() => readBaseUrl(file), /baseUrl/);
  assert.throws(() => readBaseUrl(join(dir, 'missing.json')), /missing\.json 读不到/);
});
test('a urlFile outlet re-reads its file before every push, so a new port is picked up', async t => {
  const dir = await tempDir(t); const file = join(dir, 'running.json');
  const { calls, fetchImpl } = fakeFetch();
  const outlet = createOutlet({ name: '桌面应用', urlFile: file, path: '/hook?x=1' }, () => 'http://dsh', fetchImpl);
  assert.deepEqual(outlet.kinds, ['reply', 'busy', 'reach'], 'all kinds when none are listed');
  await writeFile(file, BOM + JSON.stringify({ baseUrl: 'http://127.0.0.1:7001' }));
  await outlet.send({ text: '在呢', kind: 'reply', name: 'TA', images: ['http://h/a.png'] });
  await writeFile(file, JSON.stringify({ baseUrl: 'http://127.0.0.1:7002' }));
  await outlet.send({ text: busyText('TA'), kind: 'busy', name: 'TA' });
  assert.deepEqual(calls.map(call => [call.method, call.url, call.body]), [
    ['POST', 'http://127.0.0.1:7001/hook?x=1', { text: '在呢', kind: 'reply', name: 'TA', images: ['http://h/a.png'] }],
    ['POST', 'http://127.0.0.1:7002/hook?x=1', { text: 'TA在忙，忙完会在家里回你', kind: 'busy', name: 'TA' }],
  ]);
  assert.ok(calls[0]!.signal instanceof AbortSignal);
});
test('a url outlet fills in the DSH origin, takes only the kinds it lists, and a push carries her name and the expression', async () => {
  const { calls, fetchImpl } = fakeFetch();
  const outlet = createOutlet({ name: '气泡', url: '{origin}/pet/broadcast?pet=main', kinds: ['reach'] }, () => 'http://127.0.0.1:5173', fetchImpl);
  assert.deepEqual(outlet.kinds, ['reach']);
  await outlet.send(pushOf('**想你了** ![哼](/m/a.png)', 'reach', '小鱼', 'http://127.0.0.1:5173', '可爱'));
  assert.deepEqual(calls.map(call => [call.url, call.body]), [['http://127.0.0.1:5173/pet/broadcast?pet=main', { text: '想你了', kind: 'reach', name: '小鱼', images: ['http://127.0.0.1:5173/m/a.png'], image: '可爱' }]]);
  assert.throws(() => outletUrl({ name: '空的' }, () => 'http://dsh'), /推送目标「空的」没有 url 也没有 urlFile/);
});
test('a push fails when the app is not running, refuses, or cannot be reached', async t => {
  const dir = await tempDir(t); const file = join(dir, 'running.json');
  let reply = () => Promise.resolve(Response.json({ ok: true }));
  const { fetchImpl, calls } = fakeFetch(() => reply());
  const outlet = createOutlet({ name: 'app', urlFile: file }, () => 'http://dsh', fetchImpl);
  const push = () => outlet.send({ text: 'hi', kind: 'reach', name: 'TA' });
  await assert.rejects(push(), /running\.json 读不到/);
  assert.equal(calls.length, 0);
  await writeFile(file, JSON.stringify({ baseUrl: 'http://127.0.0.1:7001' }));
  reply = () => Promise.resolve(new Response('nope', { status: 500 }));
  await assert.rejects(push(), { message: 'HTTP 500' });
  reply = () => Promise.resolve(Response.json({ ok: false, message: 'busy' }));
  await assert.rejects(push(), { message: 'busy' });
  reply = () => Promise.reject(new Error('connect ECONNREFUSED'));
  await assert.rejects(push(), { message: 'connect ECONNREFUSED' });
  reply = () => Promise.resolve(new Response('', { status: 200 }));
  await push();
});
