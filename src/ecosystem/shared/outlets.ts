import { readFileSync } from 'node:fs';

/**
 * Outlets: where her words go outside DSH. dsh-world knows no app by name; each outlet is a URL from the
 * config that receives the documented push below. Any local app (a desktop pet, a tray app) can be one.
 */
export type PushKind = 'reply' | 'busy' | 'reach';
const PUSH_KINDS: readonly PushKind[] = ['reply', 'busy', 'reach'];
/** The body every outlet receives as JSON. `images` are picture URLs from her markdown; `image` is the expression name reach_out was given. */
export interface Push { text: string; kind: PushKind; name: string; images?: string[]; image?: string }
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
export interface Outlet { name: string; kinds: readonly PushKind[]; send(push: Push): Promise<void> }
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
  return { text: text || (alts.length ? alts.filter(Boolean).join(' ') || '（表情包）' : ''), images };
}
export function pushOf(markdown: string, kind: PushKind, name: string, origin?: string, image?: string): Push {
  const { text, images } = plainMessage(markdown, origin);
  return { text, kind, name, ...(images.length ? { images } : {}), ...(image ? { image } : {}) };
}
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
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(push), signal: AbortSignal.timeout(5000),
      });
      const result = await response.json().catch(() => undefined) as { ok?: boolean; message?: string } | undefined;
      if (!response.ok || result?.ok === false) throw new Error(result?.message ?? `HTTP ${response.status}`);
    },
  };
}
