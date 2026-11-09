/**
 * 她的「我是谁」：每个会话读进系统提示的固定字数，并在改动之前留一份历史副本。
 *
 * 导出：SELF_CAP（每个会话读入的字符上限）、renderSelf（渲染成 {{self}} 的正文）、keepSelfCopy（留历史副本）。
 * 调用方：promptSection.ts 装配世界提示时调 renderSelf；生活线在她写文件时调 keepSelfCopy。
 * 依赖：node:fs 的同步读写与路径处理，不依赖世界配置。
 *
 * 坑：renderSelf 永不抛错 —— 读不到时给一句「这次没读到」，因为系统提示缺一段也不能让会话建不出来；
 * 超出上限按字符截断并明说还剩多少字，让她自己决定删什么，而不是程序替她删。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

/** Characters of her self-description read per session; she is asked to keep it to what matters. */
export const SELF_CAP = 4000;

/**
 * Her 我是谁 file as it goes into `{{self}}`: only what she wrote, tagged so her own headings do not read as
 * sections of the world prompt. What the file is and that she may rewrite it is the template's to say.
 * Empty when she has not written it. Never throws: an unreadable file becomes a short note.
 */
export function renderSelf(selfFile: string): string {
  let text: string;
  // trim() also drops a leading BOM.
  try { text = existsSync(selfFile) ? readFileSync(selfFile, 'utf8').trim() : ''; }
  catch (error) { return `（这次没能读到我是谁.md：${error instanceof Error ? error.message : String(error)}。它还在，下次会再试。）`; }
  if (!text) return '';
  const chars = Array.from(text);
  // 按字符数而不是 UTF-16 码元截断：汉字与 emoji 不会被切成半个。
  const capped = chars.length > SELF_CAP;
  const body = `<我是谁.md>\n${capped ? chars.slice(0, SELF_CAP).join('') : text}\n</我是谁.md>`;
  return capped ? `${body}\n（后面还有 ${chars.length - SELF_CAP} 字没读进来；挑最要紧的留下吧。）` : body;
}
/** Keeps her 我是谁 as it is today beside it, in `<name>.history/<day><ext>`, so every change she makes can be seen and undone. Undefined when she has not written one. */
export function keepSelfCopy(selfFile: string, day: string): string | undefined {
  if (!existsSync(selfFile)) return undefined;
  const ext = extname(selfFile);
  const dir = join(dirname(selfFile), `${basename(selfFile, ext)}.history`);
  mkdirSync(dir, { recursive: true });
  // 副本按天命名：同一天改多次只留最后一次，历史目录不会无限膨胀。
  const copy = join(dir, `${day}${ext}`);
  copyFileSync(selfFile, copy);
  return copy;
}
