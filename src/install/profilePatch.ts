import { backupBeside, readTextIfExists, replaceAtomically } from './profileFile.ts';

/**
 * `cordis.patch.yml`（profile 覆盖文件）的语义层：**只判断、只追加，不重排、不重写**。
 *
 * 这个文件是 YAML 的顶层序列：`- id: <插件>` 是一行配置，`- insert:` 是往插件树里插一条新行。宿主自己也写
 * 它（设置页保存、bundle 开关、换压缩），所以这里的每个动作都要求「不碰别人写的行」：
 *
 *   1. `hasRow`：文件里是否已经有这个 id；
 *   2. `appendBlock`：原文一个字不改，只在末尾接一块新列表项；结构不对就放弃。
 *
 * 为什么不「解析 → 改 → 序列化」：仓库不引入 YAML 解析器，手写解析器遇到块标量、锚点、多行 flow 集合就会把
 * 别的插件的配置整段丢掉。追加法最坏的结果是「没加进去（返回 skipped 并记日志）」，不会写坏文件。
 */

/** 文件开头的 BOM 原样保留，避免宿主把它当成内容的一部分。 */
const BOM = '\uFEFF';

/** 一次追加的结果：written 带备份路径，repaired 表示就地修好了旧写法（同样带备份），skipped 带理由。 */
export type OverlayEdit =
  | { status: 'written'; backup: string }
  | { status: 'repaired'; backup: string }
  | { status: 'unchanged' }
  | { status: 'skipped'; reason: string };

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 这个 id 是否已经有一行。两种写法都认：显式的 `- id: x`（宿主/插件管理器写的那行），以及 `- insert:` 块里
 * 的 `- id: x`；`name: x` 也认，因为 `name` 就是模块说明符，跟 id 同名。
 */
export function hasRow(text: string, id: string): boolean {
  const pattern = new RegExp(`^\\s*-?\\s*(?:id|name):\\s*['"]?${escapeRegExp(id)}['"]?\\s*$`, 'm');
  return pattern.test(text);
}

/** 文件里的有效行（去掉空行与整行注释）。 */
function contentLines(text: string): string[] {
  return text.replace(BOM, '').split(/\r?\n/).filter(line => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith('#');
  });
}

/** 空文档：空文件、`[]`、`{}`。这三种可以整份换成我们的块，不算「改写别人的内容」。 */
function isEmptyDocument(text: string): boolean {
  const lines = contentLines(text);
  if (lines.length === 0) return true;
  return lines.length === 1 && (lines[0]!.trim() === '[]' || lines[0]!.trim() === '{}');
}

/** 顶层是不是列表：`- ` 或单独的 `-`，`-id` 这种是标量，不算。 */
const startsSequenceEntry = (line: string): boolean => /^-\s|^-$/.test(line.trim());

/**
 * 末尾追加一个顶层列表项是否安全。不安全就给出理由，调用方宁可不加也不写坏。
 *
 * 判据只有三条，都是为了「追加后仍是同一个、顶层为序列的 YAML 文档」：
 *   - 顶层第一个有效行是序列项（或文件是空文档）；
 *   - 没有第二个 `---` / `...`（否则追加会变成多文档，宿主按单文档解析会直接抛 YAMLException）；
 *   - 剩下所有情况（块标量、嵌套映射、多行 flow）在末尾接一个列 0 的列表项都是合法的。
 */
export function appendVerdict(text: string): { ok: true } | { ok: false; reason: string } {
  if (isEmptyDocument(text)) return { ok: true };
  const lines = contentLines(text);
  // 允许文件以一个 `---` 开头，那是同一个文档的开始标记。
  const body = lines[0]!.trim() === '---' ? lines.slice(1) : lines;
  if (body.length === 0) return { ok: true };
  if (!startsSequenceEntry(body[0]!)) return { ok: false, reason: '顶层不是列表（文件可能被别的工具改写成了映射）' };
  if (body.slice(1).some(line => /^(---|\.\.\.)$/.test(line.trim()))) {
    return { ok: false, reason: '文件里有第二个文档分隔符，追加会变成多文档 YAML' };
  }
  return { ok: true };
}

/** 把一块新内容接到文件末尾；空文档（含 `[]`）整份换成这一块。除末尾多余空行外，原有内容逐字节保留。 */
function joined(text: string, block: string): string {
  const bom = text.startsWith(BOM) ? BOM : '';
  const body = bom ? text.slice(BOM.length) : text;
  if (isEmptyDocument(body)) return bom + block;
  const newline = body.includes('\r\n') ? '\r\n' : '\n';
  const head = body.replace(/\s+$/, '');
  const tail = block.replace(/\n/g, newline);
  return `${bom}${head}${newline}${tail.endsWith(newline) ? tail : tail + newline}`;
}

/**
 * 往文件末尾追加一块顶层列表项。已经空文档时整份替换，否则原文保持原样、只接尾巴。
 * 不负责「是不是已经有这一行」—— 那是调用方用 `hasRow` 判断的事。
 */
export function appendBlock(file: string, block: string): OverlayEdit {
  const text = readTextIfExists(file);
  if (text === undefined) return { status: 'skipped', reason: 'profile 里没有 cordis.patch.yml' };
  const verdict = appendVerdict(text);
  if (!verdict.ok) return { status: 'skipped', reason: verdict.reason };
  const next = joined(text, block);
  if (next === text) return { status: 'unchanged' };
  const backup = backupBeside(file);
  replaceAtomically(file, next);
  return { status: 'written', backup };
}

/**
 * 自注册用的 `- insert:` 块。缩进（4 空格）与插件自带的 `cordis.patch.yml` 一致：宿主按 YAML 解析，
 * 缩进只影响可读性，但两处写成一样，出问题时对比起来快。
 */
export function insertBlock(id: string, name = id): string {
  return `- insert:\n    - id: ${id}\n      name: ${name}\n`;
}

/**
 * 旧版（0.8.0/0.8.1）自注册把 `- insert:` 写成了映射：
 *
 *     - insert:
 *         id: dsh-world-bili
 *         name: dsh-world-bili
 *
 * 0.2.2-rc.1 的宿主把 `insert` 当数组用（`patch.insert?.forEach`），读到映射会在启动阶段直接抛
 * `patch.insert?.forEach is not a function`。这条错误发生在加载插件之前，插件自己来不及修自己，所以修复
 * 既能被自注册调用，也能从命令行单独跑（`scripts/repair-profile-patch.mjs`）。
 *
 * 改法只动这一块：原来映射的第一行前面补 `- `，其余行整体右移两格，`config:` 之类嵌套字段的相对结构不变；
 * 文件里别的行、注释、行尾符、BOM 一律逐字节保留。
 */
const INSERT_HEADER = /^-\s*insert\s*:\s*(?:#.*)?$/;

/** 一行是不是这个 id 的 `id`/`name` 字段（旧写法里靠它认出「这块是我们的」）。 */
function namesRow(line: string, id: string): boolean {
  return new RegExp(`^\\s*(?:id|name)\\s*:\\s*['"]?${escapeRegExp(id)}['"]?\\s*$`).test(line);
}

/** 块里第一行有内容的行（跳过空行和注释）；没有就说明这是个空块。 */
function firstContent(block: readonly string[]): string | undefined {
  return block.find(line => line.trim() !== '' && !line.trimStart().startsWith('#'));
}

/** 这个 insert 块是不是写成了映射：第一行有内容的行不是 `- ` 开头的列表项。 */
function isMappingInsert(block: readonly string[]): boolean {
  const first = firstContent(block);
  return first !== undefined && !/^\s*-/.test(first);
}

/** 把映射形状的 insert 块改写成数组形状；返回 undefined 表示这块已经是列表、不用改。 */
function asSequence(block: readonly string[]): string[] | undefined {
  if (!isMappingInsert(block)) return undefined;
  const base = Math.min(...block.filter(line => line.trim() !== '').map(line => line.length - line.trimStart().length));
  let first = true;
  return block.map(line => {
    if (line.trim() === '') return line;
    const indent = line.length - line.trimStart().length;
    const content = line.slice(indent);
    if (first && !content.startsWith('#')) { first = false; return `${' '.repeat(base)}- ${content}`; }
    return `${' '.repeat(indent + 2)}${content}`;
  });
}

/**
 * 纯函数：把 `text` 里本插件的旧写法 `- insert:` 映射改写成数组。返回 undefined 表示没有可修的块。
 * 只认顶层条目（行首 `- insert:`），块内必须出现这个 id 的 `id`/`name` 行。
 */
export function repairLegacyInsertText(text: string, id: string): string | undefined {
  const bom = text.startsWith(BOM) ? BOM : '';
  const body = bom ? text.slice(BOM.length) : text;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  let repaired = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!INSERT_HEADER.test(line)) { out.push(line); index += 1; continue; }
    // 顶层条目的子块：直到下一个行首非空的第 0 缩进行。空行留在块里，改写时原样保留。
    let end = index + 1;
    while (end < lines.length) {
      const next = lines[end]!;
      if (next.trim() !== '' && next.length === next.trimStart().length) break;
      end += 1;
    }
    const block = lines.slice(index + 1, end);
    const sequence = block.some(candidate => namesRow(candidate, id)) ? asSequence(block) : undefined;
    out.push(line, ...(sequence ?? block));
    if (sequence) repaired = true;
    index = end;
  }
  return repaired ? bom + out.join(eol) : undefined;
}

/** 文件版：改完先备份再原子替换；没有旧写法时不动文件。 */
export function repairLegacyInsert(file: string, id: string): OverlayEdit {
  const text = readTextIfExists(file);
  if (text === undefined) return { status: 'skipped', reason: 'profile 里没有 cordis.patch.yml' };
  const repaired = repairLegacyInsertText(text, id);
  if (repaired === undefined) return { status: 'unchanged' };
  const backup = backupBeside(file);
  replaceAtomically(file, repaired);
  return { status: 'repaired', backup };
}

/**
 * 自注册写的那条 `- insert:` 在「插件同时是 profile bundle」时是多余的：
 * bundle 自带的 `cordis.patch.yml` 已经会把这一行插进来。两处都写，宿主的配置组合会得到
 * 两条同 id 的行（第一条没有 config），配置编辑器保存时就会报
 * `Configuration for "<id>" is overridden by a home patch or command-line overlay`。
 *
 * 只认自注册的精确形状（`- insert:` + 4 空格 `- id:` + 6 空格 `name:`，行尾换行），且后面不能
 * 还挂着缩进更深的 config —— 那样可能是人写的，删了会丢数据，直接不动。
 */
export function removeOwnInsertText(text: string, id: string, name = id): string | undefined {
  const bom = text.startsWith(BOM) ? BOM : '';
  const body = bom ? text.slice(BOM.length) : text;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const block = `- insert:${eol}    - id: ${id}${eol}      name: ${name}${eol}`;
  const at = body.indexOf(block);
  if (at < 0) return undefined;
  if (at > 0 && !body.slice(0, at).endsWith(eol)) return undefined;
  if (body.indexOf(block, at + 1) >= 0) return undefined;
  if (/^[ \t]/.test(body.slice(at + block.length))) return undefined;
  return bom + body.slice(0, at) + body.slice(at + block.length);
}

/** 文件版：删掉自注册多余的 insert 块；不存在（或形状不完全是我们的）就什么都不做。 */
export function removeOwnInsert(file: string, id: string, name = id): OverlayEdit {
  const text = readTextIfExists(file);
  if (text === undefined) return { status: 'skipped', reason: 'profile 里没有 cordis.patch.yml' };
  const next = removeOwnInsertText(text, id, name);
  if (next === undefined) return { status: 'unchanged' };
  const backup = backupBeside(file);
  replaceAtomically(file, next);
  return { status: 'repaired', backup };
}
