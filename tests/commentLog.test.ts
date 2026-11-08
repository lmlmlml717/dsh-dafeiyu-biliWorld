import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commentLogPath, deleteCommentLogEntry, readCommentLog } from '../src/bili/commentLog.ts';

function world(t: import('node:test').TestContext, lines: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'dw-commentlog-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bili'), { recursive: true });
  writeFileSync(commentLogPath(dir), lines.join('\n') + '\n', 'utf8');
  writeFileSync(join(dir, 'bili', 'credentials.json'), JSON.stringify({ SESSDATA: 's', bili_jct: 'j', buvid3: 'b' }), 'utf8');
  return { dir, read: () => readFileSync(commentLogPath(dir), 'utf8') };
}

const now = Date.now();
const iso = (offsetDays: number) => new Date(now - offsetDays * 86_400_000).toISOString();

test('reads newest first, filters by days, and gives legacy lines a stable id and kind', t => {
  const share = JSON.stringify({ v: 2, id: 'id-share', at: iso(1), kind: 'share-comment', ok: true, bvid: 'BV1a', aid: 111, title: '转发的那条', rpid: '9001', text: '转发+评论正文' });
  const plain = JSON.stringify({ v: 2, id: 'id-plain', at: iso(2), kind: 'comment', ok: false, bvid: 'BV1b', text: '只评论正文', code: -101, why: '账号未登录' });
  const legacy = JSON.stringify({ at: iso(3), ok: true, bvid: 'BV1c', title: '旧记录', rpid: '9003', text: '旧格式正文', code: 0, why: 'OK' });
  const tooOld = JSON.stringify({ v: 2, id: 'id-old', at: iso(40), ok: true, bvid: 'BV1d', text: '很久以前' });
  const w = world(t, [legacy, tooOld, plain, share]);

  const list = readCommentLog(w.dir, { days: 7, limit: 100 });
  assert.deepEqual(list.map(entry => entry.id), ['id-share', 'id-plain', list[2]!.id]);
  assert.equal(list[0]!.kind, 'share-comment');
  assert.equal(list[0]!.aid, 111);
  assert.equal(list[1]!.ok, false);
  assert.equal(list[1]!.why, '账号未登录');
  assert.equal(list[2]!.kind, 'comment', 'legacy records default to comment');
  assert.match(list[2]!.id, /^legacy-[0-9a-f]{16}$/);
  assert.equal(list[2]!.text, '旧格式正文');

  // 同一个 legacy 行每次读出来的 id 必须一致，删除才能定位。
  assert.equal(readCommentLog(w.dir, { days: 7 })[2]!.id, list[2]!.id);

  const all = readCommentLog(w.dir, { days: 0, limit: 100 });
  assert.equal(all.length, 4, 'days=0 means no cutoff');
  assert.equal(readCommentLog(w.dir, { days: 7, limit: 1 }).length, 1, 'limit is applied after sorting');
});

test('a record without rpid is removed locally only', async t => {
  const w = world(t, [
    JSON.stringify({ v: 2, id: 'keep', at: iso(1), ok: true, bvid: 'BV1k', text: '留下' }),
    JSON.stringify({ v: 2, id: 'drop', at: iso(2), ok: false, bvid: 'BV1x', text: '删掉', why: '失败' }),
  ]);
  const result = await deleteCommentLogEntry(w.dir, 'drop');
  assert.equal(result.ok, true);
  assert.equal(result.biliDeleted, false);
  assert.match(result.why ?? '', /只删了本地记录/);
  assert.doesNotMatch(w.read(), /"id":"drop"/);
  assert.match(w.read(), /"id":"keep"/);
});

test('a record with rpid whose video cannot be found keeps the local line instead of pretending it was deleted', async t => {
  const w = world(t, [
    JSON.stringify({ v: 2, id: 'lost', at: iso(1), ok: true, bvid: 'BV1lost', rpid: '7002', text: '找不到视频' }),
  ]);
  const fakeFetch = (async (url: string | URL | Request) => {
    assert.match(String(url), /web-interface\/view/);
    return { json: async () => ({ code: -404, message: '啥都木有' }) } as Response;
  }) as unknown as typeof fetch;

  const result = await deleteCommentLogEntry(w.dir, 'lost', { fetch: fakeFetch });
  assert.equal(result.ok, false);
  assert.match(result.why ?? '', /有 rpid 但查不到 aid/);
  assert.match(w.read(), /"id":"lost"/, 'the local line is kept when the B站 target cannot be located');
});

test('deleting a real comment calls the B站 delete endpoint with oid/rpid/csrf, then removes the local line', async t => {
  const w = world(t, [
    JSON.stringify({ v: 2, id: 'real', at: iso(1), kind: 'share-comment', ok: true, bvid: 'BV1a', aid: 222, rpid: '7001', text: '真评论' }),
  ]);
  const calls: { url: string; body: string; cookie: string }[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? ''), cookie: String((init?.headers as Record<string, string>)?.cookie ?? '') });
    return { json: async () => ({ code: 0, message: '0' }) } as Response;
  }) as unknown as typeof fetch;

  const result = await deleteCommentLogEntry(w.dir, 'real', { fetch: fakeFetch });
  assert.equal(result.ok, true);
  assert.equal(result.biliDeleted, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/x\/v2\/reply\/action$/);
  assert.match(calls[0]!.body, /type=1/);
  assert.match(calls[0]!.body, /oid=222/);
  assert.match(calls[0]!.body, /rpid=7001/);
  assert.match(calls[0]!.body, /action=del/);
  assert.match(calls[0]!.body, /csrf=j/);
  assert.match(calls[0]!.cookie, /SESSDATA=s/);
  assert.equal(w.read().trim(), '', 'the only line was removed');
});

test('when the B站 delete fails the local record is kept and the reason is returned', async t => {
  const w = world(t, [
    JSON.stringify({ v: 2, id: 'real', at: iso(1), ok: true, bvid: 'BV1a', aid: 222, rpid: '7001', text: '真评论' }),
  ]);
  const failing = (async () => ({ json: async () => ({ code: 12015, message: '投稿被限流' }) } as Response)) as unknown as typeof fetch;
  const result = await deleteCommentLogEntry(w.dir, 'real', { fetch: failing });
  assert.equal(result.ok, false);
  assert.match(result.why ?? '', /B 站删除失败/);
  assert.match(w.read(), /"id":"real"/, 'the local record survives a failed B站 delete');

  const throwing = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
  const second = await deleteCommentLogEntry(w.dir, 'real', { fetch: throwing });
  assert.equal(second.ok, false);
  assert.match(second.why ?? '', /调用 B 站删除接口失败/);
  assert.match(w.read(), /"id":"real"/);
});

test('an unknown id is reported instead of rewriting the file', async t => {
  const w = world(t, [JSON.stringify({ v: 2, id: 'only', at: iso(1), ok: true, text: 'x' })]);
  const before = w.read();
  const result = await deleteCommentLogEntry(w.dir, 'nope');
  assert.equal(result.ok, false);
  assert.match(result.why ?? '', /记录不存在/);
  assert.equal(w.read(), before);
});
