import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupBeside, replaceAtomically } from './install/profileFile.ts';

export type CompactionSwap =
  | { status: 'swapped'; backup: string; preset?: string; migrated?: boolean }
  | { status: 'already' }
  | { status: 'unchanged'; reason: string };

/** 换压缩时一并写进压缩行的选项。 */
export interface CompactionSwapOptions {
  /** 只有这些目录（她的房间）下的会话才剔除工具调用；其它会话按原版方式摘要。留空＝不写，保持旧行为。 */
  toolFreeFor?: readonly string[];
}

/** 宿主原版压缩的模块说明符：只改这一行，其余原样保留。 */
const STOCK = '@deepseek-ai/dsh-compaction-basic';
/** 我们自己的压缩入口。包名是 `dsh-world-bili`，`package.json` 里 `exports["./compaction"]` 指向 lib/compaction.js。 */
const OURS = 'dsh-world-bili/compaction';
/**
 * 0.7–0.8.0 写进 profile 的旧说明符。那时包还叫 `dsh-world`，改名之后这一行指向一个不存在的包：宿主解析它
 * 抛 `ERR_MODULE_NOT_FOUND`，会话初始化停在 `compaction-basic (dsh-world/compaction): never started`。
 * 所以认到旧名不是“已经换过”，而是“换错了，要迁移”（见 docs/FIXES-0.8.1.md）。
 */
const LEGACY = 'dsh-world/compaction';

/** 只匹配「整行就是一个 name:」的写法，引号可有可无，行尾注释与 CRLF 原样保留。 */
function nameRow(specifier: string): RegExp {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(\\s*name:\\s*)(['"]?)${escaped}\\2([ \\t]*(?:#.*)?\\r?)$`, 'gm');
}

const rowsOf = (text: string, specifier: string): RegExpMatchArray[] => [...text.matchAll(nameRow(specifier))];

/** 迁移旧包名时保留原来的引号风格，尽量少动用户的文件。 */
function renameKeepingQuote(text: string, from: string, to: string): string {
  return text.replace(nameRow(from), (_match: string, lead: string, quote: string, tail: string) => `${lead}${quote}${to}${quote}${tail}`);
}

/** 把 profile 里所有旧包名的行改成新包名；返回是否改过。 */
function migrateRows(file: string, text: string): string | undefined {
  if (rowsOf(text, LEGACY).length === 0) return undefined;
  const backup = backupBeside(file);
  const migrated = renameKeepingQuote(text, LEGACY, OURS);
  replaceAtomically(file, migrated);
  return backup;
}

/**
 * 只修旧包名，不动压缩的选择。给「已经换过」和「replaceCompaction: false」的启动用：那一行是坏的，
 * 修它不属于“换压缩”，但必须修，否则会话仍然起不来。
 */
export function migrateLegacyCompaction(profileDir: string): CompactionSwap {
  const file = join(profileDir, 'cordis.patch.yml');
  if (!existsSync(file)) return { status: 'unchanged', reason: 'profile 里没有 cordis.patch.yml' };
  const backup = migrateRows(file, readFileSync(file, 'utf8'));
  return backup ? { status: 'swapped', backup, migrated: true } : { status: 'already' };
}

/**
 * 把 profile 的 `cordis.patch.yml` 里那行压缩换成我们的（与 scripts/enable-tool-free-compaction.ps1 同一件事）。
 * 只认唯一一条原版行：找不到或多于一条就什么都不动，避免猜错。
 */
export function swapStockCompaction(profileDir: string): CompactionSwap {
  const file = join(profileDir, 'cordis.patch.yml');
  if (!existsSync(file)) return { status: 'unchanged', reason: 'profile 里没有 cordis.patch.yml' };
  const text = readFileSync(file, 'utf8');
  // 旧包名先修：它是坏的，和“要不要换压缩”无关，迁移一次就不再命中。
  const migrated = migrateRows(file, text);
  if (migrated) return { status: 'swapped', backup: migrated, migrated: true };
  if (rowsOf(text, OURS).length > 0) return { status: 'already' };
  const rows = rowsOf(text, STOCK);
  if (rows.length !== 1) {
    return { status: 'unchanged', reason: rows.length ? `找到 ${rows.length} 条原版压缩配置，无法确定改哪一条` : '没有找到原版压缩那一行（可能已换成别的压缩，或写法不同）' };
  }
  const backup = backupBeside(file);
  replaceAtomically(file, text.replace(nameRow(STOCK), `$1'${OURS}'$3`));
  return { status: 'swapped', backup };
}

interface Row { name?: unknown; group?: unknown; config?: unknown }
/** The compaction rows in a preset's plugin list, including those nested in groups (where DSH's Web host isolates it). */
function compactionRows(rows: unknown, found: Row[] = []): Row[] {
  if (!Array.isArray(rows)) return found;
  for (const row of rows as Row[]) {
    if (row?.name === STOCK || row?.name === OURS || row?.name === LEGACY) found.push(row);
    if (row?.group) compactionRows(row.config, found);
  }
  return found;
}
/**
 * 预设里压缩那一行改名。旧包名同样按迁移处理：认到 `dsh-world/compaction` 就换成新名，而不是当成“已经换过”。
 * 输入不被修改，返回新对象。
 */
/**
 * 预设里压缩那一行改名。旧包名同样按迁移处理：认到 `dsh-world/compaction` 就换成新名，而不是当成“已经换过”。
 * 输入不被修改，返回新对象。
 *
 * `options.toolFreeFor` 会一并写进压缩行的 `config`：只有这些目录下的会话才剔除工具调用，其它会话按原版方式摘要。
 * 不传（或空数组）＝不写这个键，压缩引擎退回「所有会话都剔除」的旧行为。
 */
export function swapPresetConfig(config: unknown, options: CompactionSwapOptions = {}): { status: 'swapped'; config: unknown; migrated?: boolean } | Exclude<CompactionSwap, { status: 'swapped' }> {
  const next = structuredClone(config) as { plugins?: unknown };
  const rows = compactionRows(next?.plugins);
  if (rows.some(row => row.name === OURS)) return { status: 'already' };
  if (rows.length === 1) {
    const row = rows[0]!;
    const migrated = row.name === LEGACY;
    row.name = OURS;
    if (options.toolFreeFor !== undefined && options.toolFreeFor.length > 0) {
      const current = row.config;
      const base = typeof current === 'object' && current !== null && !Array.isArray(current) ? current as Record<string, unknown> : {};
      row.config = { ...base, toolFreeFor: [...options.toolFreeFor] };
    }
    return { status: 'swapped', config: next, ...(migrated ? { migrated: true } : {}) };
  }
  return { status: 'unchanged', reason: rows.length ? `预设里有 ${rows.length} 条压缩配置，无法确定改哪一条` : '预设里没有原版压缩那一行' };
}

/** DSH's own editor for profile rows: the one its settings pages save through, which also reloads the row. */
export interface ConfigEditor {
  entries(): ConfigEntry[];
  edit(entry: ConfigEntry, change: (raw: unknown, inherited: unknown) => unknown): Promise<void>;
}
interface ConfigEntry { options: { id?: string; name?: string; config?: unknown } }
/**
 * DSH's Web host composes the stock compaction inside each preset, so the profile has no row to rename. The host's
 * preset editor writes the whole preset into the profile when a partner edits it; this does the same for her preset
 * with only the compaction row changed. That copy no longer follows later DSH updates to the preset.
 */
export async function swapPresetCompaction(editor: ConfigEditor, presetId: string, profileDir: string, options: CompactionSwapOptions = {}): Promise<CompactionSwap> {
  const entry = editor.entries().find(row => row.options.name === '@deepseek-ai/dsh-agent-preset' && (row.options.config as { id?: unknown } | undefined)?.id === presetId);
  if (!entry) return { status: 'unchanged', reason: `没有找到预设 ${presetId}` };
  const first = swapPresetConfig(entry.options.config, options);
  if (first.status !== 'swapped') return first;
  const file = join(profileDir, 'cordis.patch.yml');
  const backup = existsSync(file) ? backupBeside(file) : undefined;
  await editor.edit(entry, raw => {
    const result = swapPresetConfig(raw, options);
    if (result.status !== 'swapped') throw new Error(`预设 ${presetId} 在写入前变了：${result.status === 'unchanged' ? result.reason : '已经换过'}`);
    return result.config;
  });
  return { status: 'swapped', backup: backup ?? '（原来没有 cordis.patch.yml）', preset: presetId, ...(first.migrated ? { migrated: true } : {}) };
}

/**
 * 只试一次：每个世界第一次启动时，把 profile 的压缩换成我们的。
 *
 * 旧的 `dsh-world/compaction` 行是坏的（解析不到包），所以迁移不归 `enabled` 管：不管要不要换压缩，看到就修。
 * 交换本身仍按 `replaceCompaction` 与“每个世界只试一次”的约定走，成功或本来就是我们的才记住。
 */
export async function swapCompactionOnce(deps: { enabled: boolean; profileDir: string | undefined; done(): boolean; markDone(): void; report(message: string): void; swap?: (profileDir: string) => CompactionSwap | Promise<CompactionSwap> }): Promise<void> {
  if (!deps.profileDir) return;
  if (!deps.enabled || deps.done()) {
    // 不换压缩时也可能要修旧包名：那是坏的，和“换不换”无关。失败不阻断启动，下次还会看到。
    try { migrateLegacyCompaction(deps.profileDir); } catch { /* 这一次没修成，下次启动继续 */ }
    return;
  }
  const swap = deps.swap ?? swapStockCompaction;
  let result: CompactionSwap;
  try { result = await swap(deps.profileDir); }
  catch (error) { deps.report(`没能把压缩换成 dsh-world 的“只留对话”压缩：${error instanceof Error ? error.message : String(error)}`); return; }
  if (result.status === 'unchanged') { deps.report(`没有换成 dsh-world 的“只留对话”压缩（${result.reason}）：自动压缩仍由预设自带的压缩负责，dsh-world 的 75% 触发线不生效；控制台的“应用并压缩”和回顾后压缩照常可用。`); return; }
  deps.markDone();
  if (result.status !== 'swapped') return;
  const migrated = result.migrated ? '（顺带把旧包名 dsh-world/compaction 改成 dsh-world-bili/compaction：旧名解析不到包，会让会话起不来）' : '';
  const copied = result.preset ? `预设 ${result.preset} 已整份写进 profile，之后 DSH 升级对这个预设的改动不会自动进来；` : '';
  deps.report(`已把 profile 的压缩换成 dsh-world 的“只留对话”压缩，重启 DSH 后生效（原文件备份在 ${result.backup}）。${copied}不想换：恢复备份，并在 dsh-world 配置里写 replaceCompaction: false。${migrated}`);
}
