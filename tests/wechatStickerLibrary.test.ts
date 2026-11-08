import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStickerLibrary, importLegacyStickers, MAX_STICKERS } from '../src/ecosystem/wechat/stickerLibrary.ts';

const gif = (seed: string) => Buffer.concat([Buffer.from('GIF89a'), Buffer.from(seed.padEnd(16, '.'))]);
const png = (seed: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(seed.padEnd(16, '.'))]);
const md5 = (data: Buffer) => createHash('md5').update(data).digest('hex');
async function fixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-stickers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, dir: join(root, 'stickers'), library: createStickerLibrary(join(root, 'stickers')) };
}

test('a sticker is stored once by content, keeps its tags, and survives a restart', async t => {
  const { dir, library } = await fixture(t);
  const first = await library.add(gif('happy'), { name: '开心', tags: ['开心', '庆祝', '开心'] });
  assert.match(first.sticker.id, /^st_[a-f0-9]{12}$/);
  assert.equal(first.existing, false);
  assert.deepEqual(first.sticker.tags, ['开心', '庆祝'], 'duplicate tags collapse');
  assert.equal(first.sticker.mediaType, 'image/gif');
  assert.equal(first.sticker.md5, md5(gif('happy')));
  const again = await library.add(gif('happy'), { name: '别的名字', tags: ['别的'] });
  assert.equal(again.existing, true);
  assert.equal(again.sticker.id, first.sticker.id, 'the same bytes are the same sticker');
  assert.equal((await library.list()).length, 1);
  const reopened = createStickerLibrary(dir);
  assert.deepEqual((await reopened.list()).map(sticker => sticker.id), [first.sticker.id]);
  assert.deepEqual(await readFile(join(dir, 'files', first.sticker.file)), gif('happy'));
});

test('only real sticker images with usable labels are accepted', async t => {
  const { library } = await fixture(t);
  await assert.rejects(library.add(Buffer.from('not an image'), { tags: ['x'] }), /GIF、PNG、WebP 或 JPEG/);
  await assert.rejects(library.add(gif('a'), { tags: [] }), /标签/);
  await assert.rejects(library.add(gif('a'), { tags: ['x'.repeat(17)] }), /标签/);
  await assert.rejects(library.add(gif('a'), { tags: Array.from({ length: 9 }, (_, i) => `t${i}`) }), /标签/);
  await assert.rejects(library.add(gif('a'), { name: 'n'.repeat(31), tags: ['x'] }), /名称/);
  await assert.rejects(library.add(gif('a'), { name: '坏\u0000名', tags: ['x'] }), /名称/);
  await assert.rejects(library.add(Buffer.alloc(10 * 1024 * 1024 + 1, 0x47), { tags: ['x'] }), /10MB|过大/);
  await assert.rejects(library.add(gif('a'), { tags: ['x'] }, { expectedMd5: '0'.repeat(32) }), /md5/);
  assert.deepEqual(await library.list(), []);
});

test('search returns a few compact matches instead of the whole library', async t => {
  const { library } = await fixture(t);
  await library.add(png('a'), { name: '收到', tags: ['收到', '明白'] });
  await library.add(png('b'), { name: '谢谢你', tags: ['感谢', '谢谢'] });
  await library.add(png('c'), { name: '哼', tags: ['傲娇', '生气', '不服'] });
  const hit = await library.search({ query: '谢谢' });
  assert.equal(hit.total, 3); assert.equal(hit.items.length, 1); assert.equal(hit.items[0]!.name, '谢谢你');
  assert.equal((await library.search({ query: '傲娇 生气' })).items[0]!.name, '哼');
  assert.deepEqual((await library.search({ query: '傲娇，感谢' })).items.map(s => s.name).sort(), ['哼', '谢谢你']);
  assert.equal((await library.search({ query: '完全不相关' })).items.length, 0);
  const everything = await library.search({});
  assert.equal(everything.items.length, 3, 'no query browses, newest first');
  assert.equal(everything.items[0]!.name, '哼');
  assert.equal((await library.search({ limit: 2 })).items.length, 2);
  assert.equal((await library.search({ limit: 999 })).items.length, 3);
});

test('edit changes only the labels and remove deletes the file and the entry', async t => {
  const { dir, library } = await fixture(t);
  const { sticker } = await library.add(gif('x'), { name: '旧名', tags: ['旧'] });
  const edited = await library.edit(sticker.id, { tags: ['新', '标签'] });
  assert.deepEqual([edited.name, edited.tags], ['旧名', ['新', '标签']]);
  assert.equal((await library.edit(sticker.id, { name: '新名' })).name, '新名');
  await assert.rejects(library.edit('st_000000000000', { name: 'x' }), /没有这个表情/);
  await library.remove(sticker.id);
  assert.deepEqual(await library.list(), []);
  assert.deepEqual(await readdir(join(dir, 'files')), []);
  await assert.rejects(library.remove(sticker.id), /没有这个表情/);
  assert.equal(await library.has(sticker.id), false);
});

test('the library has a size cap and a damaged index is never overwritten', async t => {
  const { dir, library } = await fixture(t);
  assert.ok(MAX_STICKERS >= 100);
  await library.add(gif('keep'), { tags: ['x'] });
  await writeFile(join(dir, 'index.json'), '{ broken');
  await assert.rejects(library.list(), /index\.json/);
  await assert.rejects(library.add(gif('other'), { tags: ['y'] }), /index\.json/);
  assert.equal(await readFile(join(dir, 'index.json'), 'utf8'), '{ broken', 'left for a person to repair');
});

test('concurrent saves of different stickers all land', async t => {
  const { library } = await fixture(t);
  await Promise.all(Array.from({ length: 12 }, (_, i) => library.add(gif(`s${i}`), { tags: [`t${i}`] })));
  assert.equal((await library.list()).length, 12);
});

test('the old plugin library is imported with its ids, names and tags, once', async t => {
  const { root, library } = await fixture(t);
  const legacy = join(root, 'memes');
  await mkdir(join(legacy, 'assets'), { recursive: true });
  const a = png('legacy-a'), b = gif('legacy-b');
  await writeFile(join(legacy, 'assets', 'st_aaaaaaaaaaaa.png'), a);
  await writeFile(join(legacy, 'assets', 'st_bbbbbbbbbbbb.gif'), b);
  await writeFile(join(legacy, 'catalog.json'), JSON.stringify({ version: 1, packs: [
    { id: 'p1', name: '包一', stickers: [{ id: 'st_aaaaaaaaaaaa', name: '收到！', meaning: '一句很长的含义', tags: ['收到', '明白'], file: 'st_aaaaaaaaaaaa.png', mediaType: 'image/png' }] },
    { id: 'p2', name: '包二', stickers: [
      { id: 'st_bbbbbbbbbbbb', name: '哼', meaning: '傲娇', tags: [], file: 'st_bbbbbbbbbbbb.gif', mediaType: 'image/gif' },
      { id: 'st_cccccccccccc', name: '丢了', tags: ['x'], file: 'missing.png', mediaType: 'image/png' },
    ] },
  ] }));
  const report = await importLegacyStickers(legacy, library);
  assert.deepEqual([report.imported, report.skipped.length], [2, 1]);
  assert.match(report.skipped[0]!, /st_cccccccccccc/);
  const all = await library.list();
  assert.deepEqual(all.map(s => s.id).sort(), ['st_aaaaaaaaaaaa', 'st_bbbbbbbbbbbb']);
  assert.deepEqual(all.find(s => s.id === 'st_aaaaaaaaaaaa')!.tags, ['收到', '明白']);
  assert.deepEqual(all.find(s => s.id === 'st_bbbbbbbbbbbb')!.tags, ['哼'], 'a sticker without tags is labelled by its name');
  assert.equal((await importLegacyStickers(legacy, library)).imported, 0, 'a second run adds nothing');
  assert.equal((await library.list()).length, 2);
});
