/**
 * 世界提示词：默认模板的位置、变量替换、名字与家/房间标题，以及「模板缺了哪几段」的体检。
 *
 * 导出：DEFAULT_TEMPLATE_FILE、MEMORY_SNIPPET_FILE、memoryTemplateGaps、WorldNames、worldNames、homeTitle、
 * roomTitle、WorldPrompt / TemplateRead 类型、readTemplate、renderTemplate、renderWorldPrompt。
 * 调用方：promptSection.ts 装配系统提示、index.ts 的控制台提示词页、history.ts 与 worldSwitch 取名字。
 * 依赖：templates/ 下随包发布的两份模板，以及生活线的 LifeOptions 类型。
 *
 * 坑：模板读不到时退回随包默认模板并带回原因，绝不抛错；renderTemplate 先展开成对的条件段、最后只替换一次变量，
 * 所以她写的正文里出现 {{...}} 也照原样留下，不会被当成标签再扫一遍。
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { LifeOptions } from './life/types.ts';

/** The template shipped with the plugin; a `world-prompt.md` in the world directory replaces it. */
export const DEFAULT_TEMPLATE_FILE = fileURLToPath(new URL('../templates/world-prompt.md', import.meta.url));

/** The sections an older custom template lacks; she can paste them in (see README). */
export const MEMORY_SNIPPET_FILE = fileURLToPath(new URL('../templates/world-prompt-memory.md', import.meta.url));
/** Which of the memory variables a template does not use, so the console can say what her prompt does not mention. */
/**
 * 模板里没用到的记忆变量，给控制台提示她补一段。
 * @param template 模板全文。
 * @returns 缺失的变量名（目前只有 memoryTools）；模板写全时是空数组。
 */
export function memoryTemplateGaps(template: string): string[] {
  return ['memoryTools'].filter(name => !new RegExp(String.raw`\{\{[#^]?${name}\}\}`).test(template));
}

/** 她与对方在这份提示词里的称呼；没有配置名字时用中性称呼，不替对方假设名字。 */
export interface WorldNames { companion: string; partner: string }
/** No name is assumed for anyone's companion: an unnamed one is the neutral TA. */
export function worldNames(config: { companionName?: string; partnerName?: string }): WorldNames {
  return { companion: config.companionName?.trim() || 'TA', partner: config.partnerName?.trim() || '伙伴' };
}
/** 家会话的标题，也是面板上「家」的名字。 */
export const homeTitle = (names: WorldNames) => `${names.companion}的家`;
// 房间工作区在宿主侧边栏里的标题。
/** Her room as a workspace in the host's sidebar. */
export const roomTitle = (names: WorldNames) => `${names.companion}的房间`;

/** 渲染世界提示需要的一切：模板路径、人格、导出目录、名字，以及生活线与记忆工具的开关。 */
export interface WorldPrompt {
  /** Her template, when present; the shipped default otherwise. */
  file?: string;
  /** Her layered persona (`persona.md`), placed above the world prompt when written. */
  persona?: string;
  /** Where the daily exports of her archive are (`<world>/conversations`). */
  conversationsDir?: string;
  names: WorldNames;
  /** Present when the life line runs: room, diary, world line, ask-first rules. */
  life?: LifeOptions;
  /** The memory_find and memory_read tools are on her sessions. */
  memoryTools?: boolean;
}
/** 读模板的结果：正文，以及退回默认模板时的原因。 */
export interface TemplateRead { text: string; error?: string }
/** Never throws: a template that cannot be read falls back to the shipped one and says why. */
export function readTemplate(file: string | undefined): TemplateRead {
  // 她自己的模板存在就用它；读不了再退回随包默认模板，并把原因带回控制台。
  if (file && existsSync(file)) {
    try { return { text: readFileSync(file, 'utf8').trim() }; }
    catch (error) { return { text: readFileSync(DEFAULT_TEMPLATE_FILE, 'utf8'), error: `世界提示词模板 ${file} 读不了，先用默认模板：${error instanceof Error ? error.message : String(error)}` }; }
  }
  return { text: readFileSync(DEFAULT_TEMPLATE_FILE, 'utf8') };
}

// 成对的条件段：{{#flag}}…{{/flag}} 与 {{^flag}}…{{/flag}}，非贪婪匹配到最近的同名结束标签，便于由内向外展开。
const section = /\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/;
/**
 * A small Mustache subset: `{{#flag}}…{{/flag}}` keeps its body when the flag is on, `{{^flag}}…{{/flag}}`
 * when it is off (different flags may nest), and `{{name}}` is replaced in one pass, so values such as her
 * 我是谁 are never scanned for tags themselves. Unknown names stay as written.
 */
export function renderTemplate(template: string, flags: Record<string, boolean>, values: Record<string, string>): string {
  let text = template.replace(/\r\n?/g, '\n');
  for (let match = section.exec(text); match; match = section.exec(text)) {
    // 每次只替换当前最内层的一段再重扫：嵌套的段由内向外逐层展开，一次扫完会把括号配错。
    const [whole, kind, flag, body] = match as unknown as [string, '#' | '^', string, string];
    text = text.replace(whole, () => (kind === '#') === Boolean(flags[flag]) ? body : '');
  }
  return text.replace(/\{\{(\w+)\}\}/g, (tag, name: string) => values[name] ?? tag).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The one world prompt every world session carries in its system prompt. `template` and `self` are read at
 * session start, after compaction or on explicit console application, so ordinary saves keep the cached prefix. The world
 * line's tools live in the home alone; the template tells other sessions where to find them.
 */
export function renderWorldPrompt(prompt: WorldPrompt, template: string, self: { file: string; text: string } | undefined, home: boolean): string {
  const { life, names } = prompt;
  // home 决定 {{#home}} 段：世界线那套工具只在家的会话里有，别的会话只能按模板里的指引去家里说。
  return renderTemplate(template, { life: Boolean(life), home, selfFile: Boolean(self), conversationsDir: Boolean(prompt.conversationsDir), memoryTools: Boolean(prompt.memoryTools) }, {
    name: names.companion, partner: names.partner, homeTitle: homeTitle(names), selfFile: self?.file ?? '', self: self?.text ?? '', conversationsDir: prompt.conversationsDir ?? '',
    ...(life ? { roomDir: life.roomDir, diaryDir: life.diaryDir, fallbackWakeTime: life.schedule().wake } : {}),
  });
}
