/**
 * 出口：她的回复、忙碌提示和「找 TA」的话，按配置 POST 给本机的其他程序。
 *
 * 导出：PushKind、Push、OutletConfig、Outlet、busyText、plainMessage、pushOf、readBaseUrl、
 * outletUrl、createOutlet。
 * 调用方：life/tools.ts 的 reach_out、bridge.ts 的回复推送、控制台的出口配置。
 * 依赖：node:fs；fetch 由参数注入，测试可以替换。
 * 坑：出口是 URL 而不是内置应用，{origin} 和 urlFile 每次推送前现读，端口变了也能跟上；
 * 只有 2xx 且返回 JSON 不是 ok:false 才算送到；贴纸路径要换成绝对 URL，外部程序才取得到。
 */
import { readFileSync } from 'node:fs';

/**
 * Outlets: where her words go outside DSH. dsh-world knows no app by name; each outlet is a URL from the
 * config that receives the documented push below. Any local app (a desktop pet, a tray app) can be one.
 */
/** 推送的三种用途：回复、忙、主动找。 */
export type PushKind = 'reply' | 'busy' | 'reach';
/** 出口没写 kinds 时默认全收。 */
const PUSH_KINDS: readonly PushKind[] = ['reply', 'busy', 'reach'];
/** The body every outlet receives as JSON. `images` are picture URLs from her markdown; `image` is the expression name reach_out was given. */
export interface Push { text: string; kind: PushKind; name: string; images?: string[]; image?: string }
/** 一个出口的配置：固定 URL，或从 urlFile 读 baseUrl 再拼 path。 */
export interface OutletConfig {
  name: string;
  /** The full URL; `{origin}` is the DSH web server's own origin. */
  url?: string;
  /** A JSON file holding `baseUrl` (read before every push, so a new port is picked up), joined with `path`. */
  urlFile?: string;
  path?: string;
  /** What it receives; all kinds when absent. */
  kinds?: PushKind[];
}
/** 配置展开后的出口；send 失败要抛错，调用方才知道这条没送到。 */
export interface Outlet { name: string; kinds: readonly PushKind[]; send(push: Push): Promise<void> }
/** 「在忙」时替她说的一句话。 */
export const busyText = (name: string) => `${name}在忙，忙完会在家里回你`;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** `![alt](url)` or `![alt](<url> "title")`; one level of parentheses inside the URL is kept. */
const imagePattern = /!\[([^\]]*)\]\(\s*(<[^>]*>|(?:[^\s()]|\([^\s()]*\))+)(?:\s+"[^"]*")?\s*\)/g;
function imageUrl(raw: string, origin?: string): string | undefined {
  const url = raw.startsWith('<') ? raw.slice(1, -1).trim() : raw;
  // A sticker without an origin points at the DSH web server, which an outside app cannot reach by path alone.
  const absolute = url.startsWith('/') && !url.startsWith('//') ? (origin ? new URL(url, origin).href : undefined) : url;
  return absolute && /^https?:\/\//i.test(absolute) ? absolute : undefined;
}
/**
 * Her markdown as an outlet shows it: sticker images apart, the text plain with its line breaks.
 * A reply that is only stickers keeps their alt text, because an outlet may drop a push without text.
 */
export function plainMessage(markdown: string, origin?: string): { text: string; images: string[] } {
  const images: string[] = [], alts: string[] = [];
  const stripped = markdown.replace(imagePattern, (_match, alt: string, raw: string) => { const url = imageUrl(raw, origin); if (url) images.push(url); alts.push(alt.trim()); return ''; });
  const text = stripped.replace(/\r\n?/g, '\n').replace(/\*\*|__|`/g, '').split('\n').map(line => line.replace(/^\s*#{1,6}\s+/, '').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // 正文空了也不能丢贴纸：只有贴纸的回复用 alt 文本兜底，出口才不至于推一条空消息。
  return { text: text || (alts.length ? alts.filter(Boolean).join(' ') || '（表情包）' : ''), images };
}
/** 把一段 markdown 回复变成一次推送；kind 决定它去哪类通道。 */
export function pushOf(markdown: string, kind: PushKind, name: string, origin?: string, image?: string): Push {
  const { text, images } = plainMessage(markdown, origin);
  return { text, kind, name, ...(images.length ? { images } : {}), ...(image ? { image } : {}) };
}
/** 读 urlFile 里的 baseUrl；文件不存在、不是 JSON、或没有 http(s) 地址都抛错。 */
export function readBaseUrl(file: string): string {
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); } catch (error) { throw new Error(`${file} 读不到：${message(error)}`); }
  let parsed: { baseUrl?: unknown };
  // PowerShell's UTF-8 writer puts a BOM in front.
  try { parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); } catch { throw new Error(`${file} 不是有效的 JSON`); }
  const baseUrl = typeof parsed?.baseUrl === 'string' ? parsed.baseUrl.trim() : '';
  if (!/^https?:\/\/[^/]/i.test(baseUrl)) throw new Error(`${file} 里没有可用的 baseUrl`);
  return baseUrl.replace(/\/+$/, '');
}
/** Resolved before every push: the DSH origin and an app's port can both change between runs. */
export function outletUrl(config: OutletConfig, origin: () => string): string {
  if (config.url) return config.url.replace('{origin}', () => origin());
  if (config.urlFile) return `${readBaseUrl(config.urlFile)}${config.path ?? ''}`;
  throw new Error(`推送目标「${config.name}」没有 url 也没有 urlFile`);
}
/** A push counts as delivered on a 2xx whose JSON, if any, does not say `ok: false`. */
export function createOutlet(config: OutletConfig, origin: () => string, fetchImpl: typeof fetch = fetch): Outlet {
  return {
    name: config.name, kinds: config.kinds?.length ? config.kinds : PUSH_KINDS,
    async send(push) {
      const response = await fetchImpl(outletUrl(config, origin), {
        // 5 秒超时：出口挂掉不能拖住她的一轮回复。
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(push), signal: AbortSignal.timeout(5000),
      });
      const result = await response.json().catch(() => undefined) as { ok?: boolean; message?: string } | undefined;
      if (!response.ok || result?.ok === false) throw new Error(result?.message ?? `HTTP ${response.status}`);
    },
  };
}
