/**
 * 本地桥的 HTTP 路由：/say 递一句话，/compact 请求压缩她的家。
 *
 * 导出：BRIDGE_PATH、COMPACT_PATH、bridgeRoute、compactRoute。
 * 调用方：插件的 webServer 路由表；路径是 exact，避免和 /dsh-world 前缀互相吞。
 * 依赖：http.ts 的 knownHost/readBody/sendJson、bridge.ts。
 * 坑：写操作要求 x-dsh-world-token，且拒绝跨站请求；世界停着时没有 bridge 可查口令，
 * 一律回 503；body 上限 32KB、正文 2000 字，超了回 400。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonObject, knownHost, readBody, sendJson, type JsonResult } from '../../http.ts';
import { HomeUnavailable, type Bridge } from './bridge.ts';

/** 递一句话进来的路径；exact 路由，避免被 /dsh-world 前缀吞掉。 */
export const BRIDGE_PATH = '/dsh-world/bridge/say';
/** 请求压缩她家的路径。 */
export const COMPACT_PATH = '/dsh-world/bridge/compact';
// 32KB 的请求体上限和 2000 字正文上限：够一句话，也挡住误发的大文件。
const MAX_BODY_BYTES = 32 * 1024;
const MAX_TEXT = 2000;
const bad: JsonResult = { status: 400, body: { error: 'bad request' } };
const unavailable: JsonResult = { status: 503, body: { error: 'home unavailable' } };

async function handleSay(bridge: Bridge | undefined, req: IncomingMessage, allowedHosts: readonly string[]): Promise<JsonResult> {
  if (req.method !== 'POST') return { status: 405, body: { error: 'method not allowed' }, headers: { allow: 'POST' } };
  const token = req.headers['x-dsh-world-token'];
  // 先验来源和口令，再解析 body：不要让未授权的请求消耗解析成本。
  if (req.headers['sec-fetch-site'] === 'cross-site' || !knownHost(req.headers.host, allowedHosts)) return { status: 403, body: { error: 'forbidden' } };
  // While her world is stopped there is no bridge and no token to check against.
  if (!bridge) return unavailable;
  if (!bridge.checkToken(Array.isArray(token) ? undefined : token)) return { status: 403, body: { error: 'forbidden' } };
  const body = jsonObject(await readBody(req, MAX_BODY_BYTES));
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  // 按码点算长度，避免一个汉字被算成三个字节而误判。
  const length = [...text].length;
  if (length < 1 || length > MAX_TEXT) return bad;
  try { return { status: 202, body: { accepted: true, id: (await bridge.say(text)).id } }; }
  catch (error) { return error instanceof HomeUnavailable ? unavailable : { status: 500, body: { error: 'internal error' } }; }
}
/** The one outside route that changes something: a local app hands her partner's words to her home. */
export function bridgeRoute(bridge: () => Bridge | undefined, allowedHosts: readonly string[] = []) {
  return {
    kind: 'exact' as const, path: BRIDGE_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      let result: JsonResult;
      try { result = await handleSay(bridge(), req, allowedHosts); } catch { result = { status: 500, body: { error: 'internal error' } }; }
      sendJson(res, result);
    },
  };
}

/** 压缩请求的校验与 /say 相同，只是不做正文解析。 */
async function handleCompact(bridge: Bridge | undefined, request: () => string | undefined, req: IncomingMessage, allowedHosts: readonly string[]): Promise<JsonResult> {
  if (req.method !== 'POST') return { status: 405, body: { error: 'method not allowed' }, headers: { allow: 'POST' } };
  const token = req.headers['x-dsh-world-token'];
  if (req.headers['sec-fetch-site'] === 'cross-site' || !knownHost(req.headers.host, allowedHosts)) return { status: 403, body: { error: 'forbidden' } };
  if (!bridge) return unavailable;
  if (!bridge.checkToken(Array.isArray(token) ? undefined : token)) return { status: 403, body: { error: 'forbidden' } };
  const refused = request();
  return refused ? { status: 409, body: { error: refused } } : { status: 202, body: { accepted: true } };
}
/** Asks for one compaction of her home, held behind her running turn; the same token as the words route. */
export function compactRoute(bridge: () => Bridge | undefined, request: () => string | undefined, allowedHosts: readonly string[] = []) {
  return {
    kind: 'exact' as const, path: COMPACT_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      let result: JsonResult;
      try { result = await handleCompact(bridge(), request, req, allowedHosts); } catch { result = { status: 500, body: { error: 'internal error' } }; }
      sendJson(res, result);
    },
  };
}
