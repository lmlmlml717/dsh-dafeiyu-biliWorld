import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBlock, appendVerdict, hasRow, insertBlock, removeOwnInsertText, repairLegacyInsert, repairLegacyInsertText } from '../src/install/profilePatch.ts';
import { ensureSelfRegistered } from '../src/install/selfRegister.ts';

const ID = 'dsh-world-bili';
const logger = { info: () => {}, warn: () => {} };

function scratch(t: import('node:test').TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'dw-install-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    write: (name: string, text: string) => writeFileSync(join(dir, name), text, 'utf8'),
    read: (name: string) => readFileSync(join(dir, name), 'utf8'),
    backups: () => readdirSync(dir).filter(name => name.endsWith('.bak')),
    temps: () => readdirSync(dir).filter(name => name.endsWith('.tmp')),
  };
}

test('hasRow recognises the two ways DSH names a row, and nothing else', () => {
  assert.equal(hasRow('- id: dsh-world-bili\n  name: dsh-world-bili\n', ID), true);
  assert.equal(hasRow('  - id: dsh-world-bili\n', ID), true);
  assert.equal(hasRow("      name: 'dsh-world-bili'\n", ID), true);
  assert.equal(hasRow('name: "dsh-world-bili"\n', ID), true);
  assert.equal(hasRow('- id: dsh-world-bili-extra\n', ID), false, 'a longer id is a different plugin');
  assert.equal(hasRow('- id: dsh-world\n  name: dsh-world\n', ID), false);
});

test('a list, an empty document and an empty flow sequence may be appended to; a mapping and a multi-document file may not', () => {
  for (const text of ['', '\n', '# 只有注释\n', '[]\n', '{}\n', '- id: a\n  name: b\n', '---\n- id: a\n']) {
    assert.deepEqual(appendVerdict(text), { ok: true }, JSON.stringify(text));
  }
  for (const text of ['name: value\n', 'dsh: {profile: {}}\n', '- id: a\n---\n- id: b\n', '- id: a\n...\n']) {
    const verdict = appendVerdict(text);
    assert.equal(verdict.ok, false, JSON.stringify(text));
  }
});

test('appending keeps every original byte and only adds the insert block at the end', t => {
  const s = scratch(t);
  const before = '# 宿主写的覆盖文件\n- id: ui-settings\n  name: "@deepseek-ai/dsh-client-ui-settings"\n  config:\n    enabled: false\n';
  s.write('cordis.patch.yml', before);
  const edit = appendBlock(join(s.dir, 'cordis.patch.yml'), insertBlock(ID));
  assert.equal(edit.status, 'written');
  assert.equal(s.read('cordis.patch.yml'), `${before}${insertBlock(ID)}`);
  assert.equal(s.backups().length, 1);
  assert.equal(s.temps().length, 0, 'no temporary file is left behind');
  assert.equal(readFileSync(join(s.dir, s.backups()[0]!), 'utf8'), before, 'the backup is the original');
});

test('an empty flow sequence is replaced, not appended to: `[]` followed by `- insert:` is not YAML', t => {
  const s = scratch(t);
  s.write('cordis.patch.yml', '[]\n');
  assert.equal(appendBlock(join(s.dir, 'cordis.patch.yml'), insertBlock(ID)).status, 'written');
  const after = s.read('cordis.patch.yml');
  assert.equal(after, insertBlock(ID));
  assert.doesNotMatch(after, /\[\]/);
});

test('CRLF and a byte order mark survive the append', t => {
  const s = scratch(t);
  s.write('crlf.yml', '- id: a\r\n  name: b\r\n');
  appendBlock(join(s.dir, 'crlf.yml'), insertBlock(ID));
  const crlf = s.read('crlf.yml');
  assert.equal(crlf, `- id: a\r\n  name: b\r\n${insertBlock(ID).replace(/\n/g, '\r\n')}`);
  assert.doesNotMatch(crlf.replace(/\r\n/g, ''), /\n/, 'no bare LF is introduced');

  s.write('bom.yml', '﻿- id: a\n');
  appendBlock(join(s.dir, 'bom.yml'), insertBlock(ID));
  assert.equal(s.read('bom.yml'), `﻿- id: a\n${insertBlock(ID)}`);
});

test('a file the append would break is left alone, with a reason and without a backup', t => {
  const s = scratch(t);
  s.write('mapping.yml', 'dsh:\n  profile:\n    bundles: []\n');
  const edit = appendBlock(join(s.dir, 'mapping.yml'), insertBlock(ID));
  assert.equal(edit.status, 'skipped');
  assert.match((edit as { reason: string }).reason, /顶层不是列表/);
  assert.equal(s.read('mapping.yml'), 'dsh:\n  profile:\n    bundles: []\n');
  assert.equal(s.backups().length, 0);
  assert.deepEqual(appendBlock(join(s.dir, 'missing.yml'), insertBlock(ID)), { status: 'skipped', reason: 'profile 里没有 cordis.patch.yml' });
});

/**
 * 造一个宿主主目录：`<root>/profiles/desktop/` 下放插件要读写的两个文件，`dir` 就是传给 ensureSelfRegistered
 * 的 dshHome。放在子目录里是刻意的 —— 自注册只认这个位置，测不到就等于没测。
 */
function profileRoot(t: import('node:test').TestContext, files: Record<string, string>) {
  const s = scratch(t);
  const profileDir = join(s.dir, 'profiles', 'desktop');
  mkdirSync(profileDir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const file = join(profileDir, name);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text, 'utf8');
  }
  return {
    dir: s.dir,
    profileDir,
    read: (name: string) => readFileSync(join(profileDir, name), 'utf8'),
    backups: () => readdirSync(profileDir).filter(name => name.endsWith('.bak')),
  };
}

test('a resolvable plugin registers as a bundle only: the bundle patch inserts the row, so no duplicate insert is written', t => {
  const p = profileRoot(t, {
    'package.json': '{"name":"dsh-profile-desktop","dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"]}}}',
    'cordis.patch.yml': '# 宿主写的\n- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n',
  });
  const first = ensureSelfRegistered({ dshHome: p.dir, packageName: ID, logger, resolvable: () => true });
  assert.equal(first[0]!.bundles, 'added');
  assert.equal(first[0]!.patch, 'present', 'the bundle patch already inserts the row');
  assert.deepEqual(JSON.parse(p.read('package.json')).dsh.profile.bundles, ['@deepseek-ai/dsh-base', ID]);
  assert.equal(p.read('cordis.patch.yml'), '# 宿主写的\n- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n', 'the patch file is left alone');
  assert.equal(p.backups().length, 0);

  const second = ensureSelfRegistered({ dshHome: p.dir, packageName: ID, logger, resolvable: () => true });
  assert.equal(second[0]!.bundles, 'present');
  assert.equal(second[0]!.patch, 'present');
  assert.equal(p.read('cordis.patch.yml'), '# 宿主写的\n- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n');
  assert.equal(p.backups().length, 0);
});

test('a duplicate self-registration insert is removed while the config row stays', t => {
  const config = '- id: dsh-world-bili\n  name: dsh-world-bili\n  config:\n    companionName: x\n';
  const p = profileRoot(t, {
    'package.json': '{"name":"p","dsh":{"profile":{"bundles":["dsh-world-bili"]}}}',
    'cordis.patch.yml': `${insertBlock(ID)}${config}`,
  });
  const result = ensureSelfRegistered({ dshHome: p.dir, packageName: ID, logger, resolvable: () => true });
  assert.equal(result[0]!.bundles, 'present');
  assert.equal(result[0]!.patch, 'repaired');
  assert.equal(p.read('cordis.patch.yml'), config, 'only the redundant insert goes');
  assert.equal(p.backups().length, 1);

  const second = ensureSelfRegistered({ dshHome: p.dir, packageName: ID, logger, resolvable: () => true });
  assert.equal(second[0]!.patch, 'present');
  assert.equal(p.backups().length, 1, 'second run writes nothing');
});

test('without a readable bundle list the insert row is still written', t => {
  const p = profileRoot(t, { 'package.json': '{"name":"p","dsh":{}}', 'cordis.patch.yml': '[]\n' });
  const result = ensureSelfRegistered({ dshHome: p.dir, packageName: ID, logger, resolvable: () => true });
  assert.equal(result[0]!.bundles, 'not-a-list');
  assert.equal(result[0]!.patch, 'inserted');
  assert.equal(p.read('cordis.patch.yml'), insertBlock(ID));
});

test('a plugin the profile cannot resolve is not written into the profile at all', t => {
  const manifest = '{"name":"dsh-profile-desktop","dsh":{"profile":{"bundles":[]}}}';
  const patch = '[]\n';
  const p = profileRoot(t, { 'package.json': manifest, 'cordis.patch.yml': patch });
  const result = ensureSelfRegistered({ dshHome: p.dir, packageName: ID, logger, resolvable: () => false });
  assert.equal(result[0]!.bundles, 'unresolvable');
  assert.equal(result[0]!.patch, 'skipped');
  assert.equal(p.read('package.json'), manifest);
  assert.equal(p.read('cordis.patch.yml'), patch);
  assert.equal(p.backups().length, 0);
});

test('a profile without the two files, or with a broken manifest, is reported and left alone', t => {
  const missing = profileRoot(t, {});
  const empty = ensureSelfRegistered({ dshHome: missing.dir, packageName: ID, logger, resolvable: () => true });
  assert.equal(empty[0]!.bundles, 'no-manifest');
  assert.equal(empty[0]!.patch, 'no-file');

  const broken = profileRoot(t, { 'package.json': '{not json', 'cordis.patch.yml': '[]\n' });
  const result = ensureSelfRegistered({ dshHome: broken.dir, packageName: ID, logger, resolvable: () => true });
  assert.equal(result[0]!.bundles, 'no-manifest');
  assert.equal(broken.read('package.json'), '{not json');

  const noPatch = profileRoot(t, { 'package.json': '{"dsh":{"profile":{"bundles":[]}}}' });
  const onlyManifest = ensureSelfRegistered({ dshHome: noPatch.dir, packageName: ID, logger, resolvable: () => true });
  assert.equal(onlyManifest[0]!.bundles, 'added');
  assert.equal(onlyManifest[0]!.patch, 'no-file', 'no patch file is created from nothing');
});

test('the default check resolves the package through the profile node_modules', t => {
  const p = profileRoot(t, {
    'package.json': '{"name":"dsh-profile-desktop","dsh":{"profile":{"bundles":[]}}}',
    'cordis.patch.yml': '[]\n',
    'node_modules/dsh-world-bili/package.json': `{"name":"${ID}","version":"0.8.1"}`,
  });
  const result = ensureSelfRegistered({ dshHome: p.dir, packageName: ID, logger });
  assert.equal(result[0]!.bundles, 'added');
  assert.equal(result[0]!.patch, 'present', 'the bundle patch inserts the row');
  assert.deepEqual(JSON.parse(p.read('package.json')).dsh.profile.bundles, [ID]);
  assert.equal(p.read('cordis.patch.yml'), '[]\n');
});

test('a profile without the plugin installed is not registered even when the default check is used', t => {
  const p = profileRoot(t, { 'package.json': '{"name":"dsh-profile-desktop","dsh":{"profile":{"bundles":[]}}}', 'cordis.patch.yml': '[]\n' });
  assert.equal(ensureSelfRegistered({ dshHome: p.dir, packageName: ID, logger })[0]!.bundles, 'unresolvable');
  assert.deepEqual(JSON.parse(p.read('package.json')).dsh.profile.bundles, []);
  assert.equal(p.read('cordis.patch.yml'), '[]\n');
});

test('the legacy mapping form of `- insert:` becomes a list, and no other byte changes', () => {
  const legacy = '# 宿主写的\n- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n- insert:\n    id: dsh-world-bili\n    name: dsh-world-bili\n    config:\n      enabled: true\n- id: preset-standard\n  name: "@deepseek-ai/dsh-agent-preset"\n';
  const repaired = repairLegacyInsertText(legacy, ID)!;
  assert.equal(repaired, '# 宿主写的\n- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n- insert:\n    - id: dsh-world-bili\n      name: dsh-world-bili\n      config:\n        enabled: true\n- id: preset-standard\n  name: "@deepseek-ai/dsh-agent-preset"\n');
  assert.equal(repairLegacyInsertText(legacy, 'dsh-world'), undefined, 'another plugin is left alone');
  assert.equal(repairLegacyInsertText(insertBlock(ID), ID), undefined, 'a list is already what 0.2.2-rc.1 wants');
  assert.equal(repairLegacyInsertText('- insert:\n    - id: other\n      name: other\n', ID), undefined, 'another plugin in list form is left alone');
});

test('the repair keeps CRLF, the byte order mark and a trailing newline-less file', () => {
  const crlf = '- insert:\r\n    id: dsh-world-bili\r\n    name: dsh-world-bili';
  assert.equal(repairLegacyInsertText(crlf, ID), '- insert:\r\n    - id: dsh-world-bili\r\n      name: dsh-world-bili');
  assert.equal(repairLegacyInsertText('﻿- insert:\n    id: dsh-world-bili\n', ID), '﻿- insert:\n    - id: dsh-world-bili\n');
});

test('the duplicate-insert cleanup only removes our exact self-registration block', () => {
  assert.equal(removeOwnInsertText(insertBlock(ID), ID), '');
  assert.equal(removeOwnInsertText(`# 注释\n${insertBlock(ID)}- id: x\n`, ID), '# 注释\n- id: x\n');
  assert.equal(removeOwnInsertText(`- insert:\r\n    - id: ${ID}\r\n      name: ${ID}\r\n`, ID), '');
  assert.equal(removeOwnInsertText(`- insert:\n    - id: ${ID}\n      name: ${ID}\n      config:\n        a: 1\n`, ID), undefined, 'a configured insert is not ours to delete');
  assert.equal(removeOwnInsertText('- insert:\n    - id: other\n      name: other\n', ID), undefined, 'another plugin is left alone');
  assert.equal(removeOwnInsertText(insertBlock(ID), 'other'), undefined, 'id must match');
});

test('self-registration repairs an old mapping row, then drops it because the bundle inserts the row', t => {
  const legacy = '- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n- insert:\n    id: dsh-world-bili\n    name: dsh-world-bili\n';
  const p = profileRoot(t, {
    'package.json': '{"name":"dsh-profile-desktop","dsh":{"profile":{"bundles":[]}}}',
    'cordis.patch.yml': legacy,
  });
  const result = ensureSelfRegistered({ dshHome: p.dir, packageName: ID, logger, resolvable: () => true });
  assert.equal(result[0]!.patch, 'repaired');
  assert.equal(p.read('cordis.patch.yml'), '- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n');
  assert.equal(p.backups().length, 2, 'the mapping repair and the duplicate removal each keep a backup');
  assert.ok(p.backups().some(name => readFileSync(join(p.profileDir, name), 'utf8') === legacy), 'the original is kept');

  const second = ensureSelfRegistered({ dshHome: p.dir, packageName: ID, logger, resolvable: () => true });
  assert.equal(second[0]!.patch, 'present', 'the repaired file is left as it is');
  assert.equal(p.backups().length, 2);
});
