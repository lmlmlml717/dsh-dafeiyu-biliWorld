import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyCompaction, swapCompactionOnce, swapPresetCompaction, swapStockCompaction, type ConfigEditor } from '../src/compactionSwap.ts';

// 包名是 dsh-world-bili：压缩入口的模块说明符就是 dsh-world-bili/compaction。
const OURS = 'dsh-world-bili/compaction';
// 0.8.0 及以前写错的名字，包改名后它指向不存在的包，会话一开就报 never started。
const LEGACY = 'dsh-world/compaction';
const stockRow = (quote = "'") => `      - id: compaction-basic\n        name: ${quote}@deepseek-ai/dsh-compaction-basic${quote}\n`;
const patch = (rows: string) => `- id: compaction\n  name: cordis:group\n  config:\n${rows}      - id: command-compact\n        name: '@deepseek-ai/dsh-command-compact'\n`;
function profile(t: import('node:test').TestContext, text?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'dw-swap-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (text !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), text, 'utf8');
  return { dir, file: join(dir, 'cordis.patch.yml'), read: () => readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), backups: () => readdirSync(dir).filter(name => name.endsWith('.bak')) };
}

test('the one stock compaction row is replaced, with a backup of the whole file, whatever the quoting or line endings', t => {
  for (const [name, text] of [['single quotes', patch(stockRow("'"))], ['double quotes', patch(stockRow('"'))], ['bare', patch(stockRow(''))], ['CRLF', patch(stockRow()).replace(/\n/g, '\r\n')], ['BOM', '﻿' + patch(stockRow())]] as const) {
    const p = profile(t, text);
    const result = swapStockCompaction(p.dir);
    assert.equal(result.status, 'swapped', name);
    const swapped = p.read();
    assert.match(swapped, new RegExp(`name: '${OURS}'`), name);
    assert.doesNotMatch(swapped, /dsh-compaction-basic/, name);
    assert.equal(swapped.replace(`'${OURS}'`, 'X').replace(/\r/g, ''), text.replace(/@deepseek-ai\/dsh-compaction-basic/, 'X').replace(/['"]X['"]|X/, 'X').replace(/\r/g, '').replace(/name: ['"]?X['"]?/, 'name: X'), `${name}: nothing else in the file changed`);
    assert.equal(swapped.startsWith('﻿'), text.startsWith('﻿'), `${name}: the byte order mark is kept`);
    assert.equal(p.backups().length, 1); assert.equal(readFileSync(join(p.dir, p.backups()[0]!), 'utf8'), text, `${name}: the backup is the original`);
    assert.equal(readdirSync(p.dir).filter(file => file.endsWith('.tmp')).length, 0);
    assert.equal((result as { backup: string }).backup, join(p.dir, p.backups()[0]!));
  }
});

test('a row written with the old package name is migrated instead of being taken for done', t => {
  for (const [name, text] of [['single quotes', patch(`      - id: compaction-basic\n        name: '${LEGACY}'\n`)], ['double quotes', patch(`      - id: compaction-basic\n        name: "${LEGACY}"\n`)]] as const) {
    const p = profile(t, text);
    const result = swapStockCompaction(p.dir);
    assert.equal(result.status, 'swapped', name);
    assert.equal((result as { migrated?: boolean }).migrated, true, `${name}: it reports the migration`);
    const migrated = p.read();
    assert.match(migrated, /name: ['"]dsh-world-bili\/compaction['"]/, name);
    assert.doesNotMatch(migrated, /dsh-world\/compaction/, name);
    assert.equal(migrated.replace(OURS, 'X'), text.replace(LEGACY, 'X'), `${name}: only the specifier changed, quoting kept`);
    assert.equal(p.backups().length, 1);
    // 迁移完再跑一次：现在它真的是“已经换过”。
    assert.deepEqual(swapStockCompaction(p.dir), { status: 'already' });
  }
});

test('migration alone repairs the row without deciding anything about the compression backend', t => {
  const p = profile(t, patch(`      - id: compaction-basic\n        name: '${LEGACY}'\n`));
  const result = migrateLegacyCompaction(p.dir);
  assert.equal(result.status, 'swapped');
  assert.match(p.read(), new RegExp(`name: '${OURS.replace('/', '\\/')}'`));
  assert.deepEqual(migrateLegacyCompaction(p.dir), { status: 'already' }, 'second call is a no-op');
  assert.deepEqual(migrateLegacyCompaction(join(p.dir, 'missing')), { status: 'unchanged', reason: 'profile 里没有 cordis.patch.yml' });
});

test('a profile that already uses it, has none to swap, or is ambiguous is left exactly as it is', t => {
  const already = profile(t, patch(`      - id: compaction-basic\n        name: '${OURS}'\n`));
  assert.deepEqual(swapStockCompaction(already.dir), { status: 'already' });
  const none = profile(t, patch(''));
  assert.equal(swapStockCompaction(none.dir).status, 'unchanged'); assert.match((swapStockCompaction(none.dir) as { reason: string }).reason, /没有找到/);
  const two = profile(t, patch(stockRow() + stockRow()));
  const before = two.read();
  assert.match((swapStockCompaction(two.dir) as { reason: string }).reason, /2 条/);
  const missing = profile(t);
  assert.equal(swapStockCompaction(missing.dir).status, 'unchanged');
  for (const p of [already, none, two]) assert.equal(p.backups().length, 0, 'no backup when nothing changed');
  assert.equal(two.read(), before);
});

test('it is tried once: a swap or an existing one is remembered, a profile it could not read is looked at again, and it can be switched off', async t => {
  const run = async (p: ReturnType<typeof profile>, overrides: Partial<Parameters<typeof swapCompactionOnce>[0]> = {}) => {
    let done = false; const reports: string[] = [];
    const deps = { enabled: true, profileDir: p.dir, done: () => done, markDone: () => { done = true; }, report: (message: string) => { reports.push(message); }, ...overrides };
    await swapCompactionOnce(deps);
    return { done: () => done, reports, again: () => swapCompactionOnce(deps) };
  };
  const fresh = profile(t, patch(stockRow()));
  const first = await run(fresh);
  assert.equal(first.done(), true); assert.equal(first.reports.length, 1); assert.match(first.reports[0]!, /重启 DSH 后生效[\s\S]*备份在[\s\S]*replaceCompaction: false/);
  await first.again(); assert.equal(fresh.backups().length, 1, 'the second start does nothing');
  // The partner puts the stock row back by hand: it is not swapped again once it has been done.
  writeFileSync(fresh.file, patch(stockRow()), 'utf8');
  await first.again(); assert.match(fresh.read(), /dsh-compaction-basic/);

  const existing = await run(profile(t, patch(`      - id: compaction-basic\n        name: '${OURS}'\n`)));
  assert.equal(existing.done(), true); assert.deepEqual(existing.reports, [], 'nothing to say when it was already so');
  const unreadable = await run(profile(t, patch('')));
  assert.equal(unreadable.done(), false, 'not remembered, so a later start looks again');
  assert.match(unreadable.reports[0]!, /没有找到原版压缩那一行[\s\S]*75% 触发线不生效/, 'a skipped swap says what is still in effect');
  assert.equal((await run(profile(t, patch(stockRow())), { enabled: false })).done(), false);
  assert.equal((await run(profile(t, patch(stockRow())), { profileDir: undefined })).done(), false);
  const failing = await run(profile(t, patch(stockRow())), { swap: () => { throw new Error('EPERM: locked'); } });
  assert.equal(failing.done(), false); assert.match(failing.reports[0]!, /没能把压缩换成[\s\S]*EPERM: locked/);
});

test('the old specifier is repaired even when the swap is switched off or already done', async t => {
  const attempt = async (p: ReturnType<typeof profile>, enabled: boolean, done: boolean) => {
    await swapCompactionOnce({ enabled, profileDir: p.dir, done: () => done, markDone: () => {}, report: () => {} });
    return p.read();
  };
  const off = profile(t, patch(`      - id: compaction-basic\n        name: '${LEGACY}'\n`));
  assert.match(await attempt(off, false, false), new RegExp(OURS.replace('/', '\\/')));
  const done = profile(t, patch(`      - id: compaction-basic\n        name: '${LEGACY}'\n`));
  assert.match(await attempt(done, true, true), new RegExp(OURS.replace('/', '\\/')));
});

// The shape of DSH's Web standard preset: compaction sits in an isolated group inside the preset's plugin list.
const webPreset = (compaction = '@deepseek-ai/dsh-compaction-basic') => ({
  id: 'standard', order: 1,
  plugins: [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'You are a coding agent.' } },
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', config: { disabled: { __jsExpr: "process.platform === 'win32'" } } },
    { id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true }, config: [
      { id: 'compaction-basic', name: compaction },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
    ] },
  ],
});
function fakeEditor(config: unknown, options: { changeBeforeWrite?: unknown } = {}) {
  const entry = { options: { id: 'preset-standard', name: '@deepseek-ai/dsh-agent-preset', config } };
  const written: unknown[] = [];
  const editor: ConfigEditor = {
    entries: () => [{ options: { id: 'dsh-world', name: 'dsh-world', config: {} } }, entry],
    edit: async (target, change) => { assert.equal(target, entry); written.push(change(options.changeBeforeWrite ?? structuredClone(config), {})); },
  };
  return { editor, written };
}

test('on the Web host the preset is written into the profile through the host editor, with only its compaction row changed', async t => {
  const p = profile(t, '- id: dsh-world\n  name: dsh-world\n');
  const { editor, written } = fakeEditor(webPreset());
  const result = await swapPresetCompaction(editor, 'standard', p.dir);
  assert.equal(result.status, 'swapped');
  assert.deepEqual(written, [webPreset(OURS)], 'everything else, an unevaluated !!js expression included, is kept as it was');
  assert.equal(p.backups().length, 1, 'the profile patch is backed up first');
  assert.equal((result as { preset?: string }).preset, 'standard');
});

test('the preset swap records which session directories keep the tool-free summary', async t => {
  const p = profile(t, '');
  const { editor, written } = fakeEditor(webPreset());
  const room = 'C:\\Users\\me\\.dsh\\worlds\\default\\room';
  const result = await swapPresetCompaction(editor, 'standard', p.dir, { toolFreeFor: [room] });
  assert.equal(result.status, 'swapped');
  const preset = written[0] as { plugins: { id: string; config: { id: string; name: string; config?: unknown }[] }[] };
  const row = preset.plugins.find(plugin => plugin.id === 'compaction')!.config.find(plugin => plugin.id === 'compaction-basic')!;
  assert.equal(row.name, OURS);
  assert.deepEqual(row.config, { toolFreeFor: [room] }, 'only the room directory keeps the tool-free summary');
  // 不传选项时不写这个键：压缩引擎退回「所有会话都剔除」的旧行为。
  const plain = fakeEditor(webPreset());
  await swapPresetCompaction(plain.editor, 'standard', p.dir);
  assert.deepEqual(plain.written, [webPreset(OURS)]);
});

test('a preset that still names the old package is migrated, and the migration is reported', async t => {
  const p = profile(t, '');
  const { editor, written } = fakeEditor(webPreset(LEGACY));
  const result = await swapPresetCompaction(editor, 'standard', p.dir);
  assert.equal(result.status, 'swapped');
  assert.equal((result as { migrated?: boolean }).migrated, true);
  assert.deepEqual(written, [webPreset(OURS)]);

  let done = false; const reports: string[] = [];
  await swapCompactionOnce({ enabled: true, profileDir: p.dir, done: () => done, markDone: () => { done = true; }, report: message => { reports.push(message); },
    swap: () => swapPresetCompaction(fakeEditor(webPreset(LEGACY)).editor, 'standard', p.dir) });
  assert.match(reports[0]!, /旧包名 dsh-world\/compaction/);
});

test('the preset is left alone when it already uses ours, has no single stock row, is missing, or changed before the write', async t => {
  const p = profile(t, '');
  for (const [config, status] of [[webPreset(OURS), 'already'], [{ ...webPreset(), plugins: [] }, 'unchanged']] as const) {
    const { editor, written } = fakeEditor(config);
    assert.equal((await swapPresetCompaction(editor, 'standard', p.dir)).status, status);
    assert.deepEqual(written, []);
  }
  assert.match((await swapPresetCompaction(fakeEditor(webPreset()).editor, 'ptc', p.dir) as { reason: string }).reason, /没有找到预设 ptc/);
  await assert.rejects(swapPresetCompaction(fakeEditor(webPreset(), { changeBeforeWrite: webPreset(OURS) }).editor, 'standard', p.dir), /写入前变了/);
});

test('a swap through the preset says the copy no longer follows DSH updates to that preset', async t => {
  const p = profile(t, '');
  let done = false; const reports: string[] = [];
  await swapCompactionOnce({ enabled: true, profileDir: p.dir, done: () => done, markDone: () => { done = true; }, report: message => { reports.push(message); },
    swap: () => swapPresetCompaction(fakeEditor(webPreset()).editor, 'standard', p.dir) });
  assert.equal(done, true);
  assert.match(reports[0]!, /重启 DSH 后生效[\s\S]*预设 standard 已整份写进 profile/);
});
