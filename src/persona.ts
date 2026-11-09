/**
 * 她的分层人格：`<world>/persona.md` 里按 `## 层名` 分节，在世界控制台逐层编辑。
 *
 * 导出：PERSONA_LAYERS 与 PersonaLayer / Persona 类型、readPersona、writePersona、renderPersona。
 * 调用方：index.ts（读名字、给控制台读写）、promptSection.ts（放进系统提示）、runtime.ts 经提示源间接受影响。
 * 依赖：life/lifeStore.ts 的 durableWrite 与 life/messages.ts 的分节解析。
 *
 * 坑：缺文件或读不了都当成「还没写」，返回每层空串而不抛错；反过来，所有层都空时 writePersona 会删掉文件，
 * 免得多出一个空壳文件、下次读出一堆空节。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { durableWrite } from './life/lifeStore.ts';
import { parseSections } from './life/messages.ts';

/** Her persona in layers, each a `## 名字` section of `<world>/persona.md`, filled in the world console. */
export const PERSONA_LAYERS = ['名字', '她是谁', '性格', '说话方式', '愿景', '补充'] as const;
/** 人格的一层，取值就是 PERSONA_LAYERS 里的名字。 */
export type PersonaLayer = typeof PERSONA_LAYERS[number];
/** 一整个人格：每层一段文字，没写过的层是空串。 */
export type Persona = Record<PersonaLayer, string>;

/** Missing or unreadable means not written yet: every layer empty. */
export function readPersona(file: string): Persona {
  let sections = new Map<string, string>();
  // 解析失败只当没写过：控制台必须能打开，不能因为一个坏文件整页崩掉。
  try { if (existsSync(file)) sections = parseSections(readFileSync(file, 'utf8'), PERSONA_LAYERS); } catch { /* treated as not written */ }
  return Object.fromEntries(PERSONA_LAYERS.map(layer => [layer, sections.get(layer) ?? ''])) as Persona;
}
/** Only layers with text are kept; a persona with none removes the file. */
export function writePersona(file: string, persona: Partial<Persona>): void {
  // 只写有内容的层：空层不占位，下次读出来也还是空。
  const kept = PERSONA_LAYERS.flatMap(layer => { const text = persona[layer]?.trim(); return text ? [`## ${layer}\n${text}`] : []; });
  if (kept.length) durableWrite(file, `${kept.join('\n\n')}\n`); else rmSync(file, { force: true });
}
/** The persona as she reads it at the top of her system prompt, in her own voice; empty when nothing is written. */
export function renderPersona(persona: Persona): string {
  // 名字与「她是谁」并成一句开头，其余层各自成节：读起来像她自己写的，而不是一张填好的表单。
  const opening = [persona.名字 ? `我是${persona.名字}。` : '', persona.她是谁].filter(Boolean).join('');
  const layers = (['性格', '说话方式', '愿景'] as const).flatMap(layer => persona[layer] ? [`# ${layer}\n${persona[layer]}`] : []);
  return [opening, ...layers, persona.补充].filter(Boolean).join('\n\n');
}
