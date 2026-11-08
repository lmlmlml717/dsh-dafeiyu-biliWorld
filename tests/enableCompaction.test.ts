import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const OURS = 'dsh-world-bili/compaction';
const LEGACY = 'dsh-world/compaction';
const run = (root: string) => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('scripts/enable-tool-free-compaction.ps1'), '-profilePath', root], { encoding: 'utf8' });

// 这条跑的是 scripts/enable-tool-free-compaction.ps1，要 PowerShell。
test('enable script changes only the compaction plugin, backs up and remains idempotent', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-world-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  const before = "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n- id: compaction-basic\n  name: '@deepseek-ai/dsh-compaction-basic'\n- id: command-compact\n  name: '@deepseek-ai/dsh-command-compact'\n";
  await writeFile(join(root, 'package.json'), '{"dependencies":{"dsh-world-bili":"file:example"}}');
  await writeFile(join(root, 'cordis.patch.yml'), before);
  run(root);
  assert.equal(await readFile(join(root, 'cordis.patch.yml'), 'utf8'), before.replace("'@deepseek-ai/dsh-compaction-basic'", `'${OURS}'`));
  const backup = (await readdir(root)).find(name => name.endsWith('.bak'))!;
  assert.equal(await readFile(join(root, backup), 'utf8'), before);
  run(root); assert.equal((await readdir(root)).filter(name => name.endsWith('.bak')).length, 1);
});

test('enable script migrates the old package name instead of treating it as already configured', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-world-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  const before = `- id: compaction-basic\n  name: '${LEGACY}'\n`;
  await writeFile(join(root, 'package.json'), '{"dependencies":{"dsh-world-bili":"file:example"}}');
  await writeFile(join(root, 'cordis.patch.yml'), before);
  run(root);
  assert.equal(await readFile(join(root, 'cordis.patch.yml'), 'utf8'), before.replace(LEGACY, OURS));
  const backup = (await readdir(root)).find(name => name.endsWith('.bak'))!;
  assert.equal(await readFile(join(root, backup), 'utf8'), before);
});
