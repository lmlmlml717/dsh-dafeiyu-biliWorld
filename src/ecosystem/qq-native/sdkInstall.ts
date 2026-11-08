import { readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const SDK = '@snowluma/sdk';
const range: string = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).peerDependencies[SDK];
export interface QqSdkProfile { dir: string; name: string; packageManager?: { command: string; args?: readonly string[]; env?: Record<string, string> }; [key: string]: unknown }
export interface HostInstaller {
  withFileLock<T>(file: string, work: () => Promise<T>, options?: { signal: AbortSignal }): Promise<T>;
  writeFileAtomic(file: string, bytes: Uint8Array, options: { mode: number }): Promise<unknown>;
  runProfilePnpm(profile: QqSdkProfile, args: string[], options: Record<string, unknown>): Promise<{ exitCode: number; output: string; timedOut?: boolean; incompatible?: unknown[] }>;
}
export async function hostSdkInstaller(): Promise<HostInstaller> {
  const operations = '@deepseek-ai/dsh-plugin-manager/operations', atomic = '@deepseek-ai/dsh-atomic-write';
  const [manager, files] = await Promise.all([import(operations), import(atomic)]);
  if (typeof manager.runProfilePnpm !== 'function' || typeof files.withFileLock !== 'function' || typeof files.writeFileAtomic !== 'function') throw new Error('宿主未提供按需依赖安装能力，请在当前 profile 手动安装 SnowLuma SDK');
  return { runProfilePnpm: manager.runProfilePnpm, withFileLock: files.withFileLock, writeFileAtomic: files.writeFileAtomic };
}

/** Invoked by an explicit QQ enable action; startup and ordinary turns never install packages. */
export function createQqSdkInstaller(deps: { available(): boolean; profile(): QqSdkProfile | undefined; signal: AbortSignal; loadHost?: () => Promise<HostInstaller> }) {
  let installed = false, pending: Promise<boolean> | undefined;
  async function install(): Promise<boolean> {
    const profile = deps.profile();
    if (!profile || !isAbsolute(profile.dir) || !profile.packageManager?.command) throw new Error('宿主未提供当前 profile 的包管理器，请手动安装 SnowLuma SDK');
    const host = await (deps.loadHost ?? hostSdkInstaller)();
    return host.withFileLock(join(profile.dir, 'package.json'), async () => {
      deps.signal.throwIfAborted();
      const context = { ...profile, profile: profile.name };
      const options = { ...profile.packageManager, env: { ...profile.packageManager?.env, npm_config_ignore_scripts: 'true' }, execution: 'service', signal: deps.signal, activateNewBundles: false, outputBytes: 4096, idleTimeoutMs: 120_000, lookupTimeoutMs: 20_000 };
      // Let the host reject an earlier surviving package process before taking a rollback snapshot.
      const probe = await host.runProfilePnpm(context, ['--version'], options);
      if (probe.exitCode !== 0 || probe.timedOut || probe.incompatible?.length) throw new Error(probe.output || '宿主包管理器当前不可用，请稍后重试');
      deps.signal.throwIfAborted();
      const saved = await Promise.all(['package.json', 'pnpm-lock.yaml'].map(async name => {
        const path = join(profile.dir, name);
        try { return { path, bytes: await readFile(path) }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, bytes: undefined }; throw error; }
      }));
      try {
        const result = await host.runProfilePnpm(context, ['add', `${SDK}@${range}`, '--ignore-scripts', '--config.engine-strict=true'], options);
        deps.signal.throwIfAborted();
        if (result.exitCode !== 0 || result.timedOut || result.incompatible?.length) throw new Error(result.output || 'SnowLuma SDK 安装失败，请检查网络和 SDK 的 Node 要求');
        installed = true; return true;
      } catch (error) {
        for (const file of saved) {
          if (file.bytes === undefined) await rm(file.path, { force: true });
          else await host.writeFileAtomic(file.path, file.bytes, { mode: 0o600 });
        }
        throw error;
      }
    }, { signal: deps.signal });
  }
  return {
    needsRestart: () => installed,
    async ensure(): Promise<boolean> {
      deps.signal.throwIfAborted();
      if (installed) return true;
      if (deps.available()) return false;
      return pending ??= install().finally(() => { pending = undefined; });
    },
  };
}
