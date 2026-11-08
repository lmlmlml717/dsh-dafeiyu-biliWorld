import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createQqSdkInstaller, type HostInstaller } from '../src/ecosystem/qq-native/sdkInstall.ts';

test('SDK availability needs no package operation, while a missing SDK is installed only once and needs restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qq-sdk-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{"dependencies":{"dsh-world":"1.0.0"}}');
  let exists = true, calls = 0; const args: string[][] = [];
  const host: HostInstaller = {
    withFileLock: async (_path, work) => work(), writeFileAtomic: async (file, bytes) => { await writeFile(file, bytes); },
    runProfilePnpm: async (_profile, values, options) => { calls++; args.push(values); assert.equal((options.env as Record<string, string>).npm_config_ignore_scripts, 'true'); return { exitCode: 0, output: '', incompatible: [] }; },
  };
  const sdk = createQqSdkInstaller({ available: () => exists, profile: () => ({ dir: root, name: 'test', packageManager: { command: 'host-node', args: ['host-pnpm.mjs'] } }), loadHost: async () => host, signal: new AbortController().signal });
  assert.equal(await sdk.ensure(), false); assert.equal(calls, 0);
  exists = false;
  const [a, b] = await Promise.all([sdk.ensure(), sdk.ensure()]);
  assert.equal(a, true); assert.equal(b, true); assert.equal(calls, 2); assert.equal(sdk.needsRestart(), true);
  assert.deepEqual(args[0], ['--version']);
  assert.deepEqual(args[1]!.slice(0, 2), ['add', '@snowluma/sdk@^2.2.1']);
  assert.ok(args[1]!.includes('--ignore-scripts')); assert.ok(args[1]!.includes('--config.engine-strict=true'));
});
test('a rejected or cancelled install restores the profile and does not mark QQ ready', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qq-sdk-fail-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'package.json'), original = '{"dependencies":{"dsh-world":"1.0.0"}}'; await writeFile(file, original);
  const host: HostInstaller = {
    withFileLock: async (_path, work) => work(), writeFileAtomic: async (path, bytes, options) => { assert.equal(options.mode, 0o600); await writeFile(path, bytes); },
    runProfilePnpm: async (_profile, args) => { if (args[0] === '--version') return { exitCode: 0, output: '10' }; await writeFile(file, '{}'); await writeFile(join(root, 'pnpm-lock.yaml'), 'failed'); return { exitCode: 1, output: 'SDK requires another Node runtime' }; },
  };
  const sdk = createQqSdkInstaller({ available: () => false, profile: () => ({ dir: root, name: 'test', packageManager: { command: 'host-node' } }), loadHost: async () => host, signal: new AbortController().signal });
  await assert.rejects(sdk.ensure(), /SDK requires another Node/);
  assert.equal(await readFile(file, 'utf8'), original); assert.equal(sdk.needsRestart(), false);
  await assert.rejects(readFile(join(root, 'pnpm-lock.yaml')), { code: 'ENOENT' });
  const cancelled = new AbortController(); cancelled.abort(new Error('disposed'));
  const stopped = createQqSdkInstaller({ available: () => false, profile: () => ({ dir: root, name: 'test' }), loadHost: async () => host, signal: cancelled.signal });
  await assert.rejects(stopped.ensure(), /disposed/);
});

test('cancellation after the package operation restores both manifest and existing lockfile', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qq-sdk-abort-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'package.json'), lock = join(root, 'pnpm-lock.yaml');
  await writeFile(file, '{"private":true}'); await writeFile(lock, 'original-lock');
  const controller = new AbortController();
  const host: HostInstaller = {
    withFileLock: async (_path, work) => work(),
    writeFileAtomic: async (path, bytes, options) => { assert.equal(options.mode, 0o600); await writeFile(path, bytes); },
    runProfilePnpm: async (_profile, args) => { if (args[0] === '--version') return { exitCode: 0, output: '10' }; await writeFile(file, '{}'); await writeFile(lock, 'changed'); controller.abort(new Error('disposed')); return { exitCode: 0, output: '' }; },
  };
  const sdk = createQqSdkInstaller({ available: () => false, profile: () => ({ dir: root, name: 'test', packageManager: { command: 'host-node' } }), loadHost: async () => host, signal: controller.signal });
  await assert.rejects(sdk.ensure(), /disposed/);
  assert.equal(await readFile(file, 'utf8'), '{"private":true}'); assert.equal(await readFile(lock, 'utf8'), 'original-lock');
  assert.equal(sdk.needsRestart(), false);
});

test('a prior active host package process is rejected before rollback files are read or written', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qq-sdk-busy-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'package.json'); await writeFile(file, '{"private":true}');
  const host: HostInstaller = {
    withFileLock: async (_path, work) => work(),
    writeFileAtomic: async () => { assert.fail('must not restore files while a previous process is still writing'); },
    runProfilePnpm: async (_profile, args) => { assert.deepEqual(args, ['--version']); await writeFile(file, '{"changedByPreviousRun":true}'); return { exitCode: 1, output: 'previous package run is still active' }; },
  };
  const sdk = createQqSdkInstaller({ available: () => false, profile: () => ({ dir: root, name: 'test', packageManager: { command: 'host-node' } }), loadHost: async () => host, signal: new AbortController().signal });
  await assert.rejects(sdk.ensure(), /previous package run/);
  assert.equal(await readFile(file, 'utf8'), '{"changedByPreviousRun":true}'); assert.equal(sdk.needsRestart(), false);
});
