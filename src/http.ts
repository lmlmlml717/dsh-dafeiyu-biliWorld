/**
 * 控制台、桥接与渠道路由共用的几个 HTTP 小工具：读请求体、解析 JSON、回 JSON、校验 Host。
 *
 * 导出：JsonResult（回包形状）、readBody、jsonObject、sendJson、knownHost。
 * 调用方：console/routes.ts、ecosystem/bridge/route.ts、ecosystem/qq/route.ts 等所有挂到 webServer 的处理函数。
 * 依赖：只用 node:http 的类型，不引框架；状态码与响应头由各路由自己决定。
 *
 * 坑：readBody 超限后仍要把请求读干净，否则客户端拿不到回包；knownHost 拦的是 DNS rebinding，
 * 「页面同源」不等于「这是本机的人」，只有本机名与 allowedHosts 里的名字算数。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 一条路由要回的东西：状态码、可 JSON 序列化的包体，以及可选的额外响应头。 */
export interface JsonResult { status: number; body: unknown; headers?: Record<string, string> }

/** The request body as text, or undefined past `limit` bytes (still drained, so the client sees the answer). */
export async function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    // 超限后不再攒数据，但仍继续把流读完：不读完连接会挂着，前端连错误回包都收不到。
    if (size <= limit) chunks.push(buffer);
  }
  return size > limit ? undefined : Buffer.concat(chunks).toString('utf8');
}
/** The parsed JSON object of a body, or undefined when it is not one. */
export function jsonObject(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  try { const value = JSON.parse(raw); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; } catch { return undefined; }
}
/** JSON, never cached, no CORS headers. */
export function sendJson(res: ServerResponse, result: JsonResult): void {
  // no-store：这些回包里带的是世界状态，不能让浏览器或中间代理缓存住后再拿旧值骗人。
  res.writeHead(result.status, { ...result.headers, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(result.body));
}
// 本机可能出现的三种写法；比较前统一去端口、转小写，避免被大小写和端口绕过去。
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
/**
 * Whether DSH is reached by a name its owner knows: this machine, or one listed in `allowedHosts` (a LAN
 * address or domain behind a reverse proxy). A page of another site that has its name resolve to this machine
 * (DNS rebinding) is same-origin to the browser but still sends its own name here, so it is refused.
 */
export function knownHost(host: string | undefined, allowed: readonly string[] = []): boolean {
  // 端口不参与判断：同一个名字在反向代理后面会带不同的端口进来。
  const name = host?.replace(/:\d+$/, '').toLowerCase();
  return name !== undefined && [...LOOPBACK, ...allowed.map(entry => entry.toLowerCase())].includes(name);
}
