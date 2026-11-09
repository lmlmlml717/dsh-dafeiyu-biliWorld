// 分享队列的宿主侧视图（面板用）：她「想给你看这条」现在排着几条、发没发出去、还能重发一次。
//
// 与 tools/lib/owner-share.mjs 是同一份文件的两个读法：
//   · 工具链（CLI）负责**写**，它那边是 node 侧、不能 import 这里的 TS；
//   · 宿主（面板/控制台）负责**看**与两个小动作（重发、清空已发）。
// 字段口径必须一致：`owner-outbox.jsonl` 一行一条 `{id, at, bvid, title, say}`，
// `owner-outbox.jsonl.sent.json` 是通道写回的 `{ids: [...]}`。
//
// 【模块卡片】
// 职责：读分享队列、读已发 id；重发一条（追加新 id）、清空已发的记录。
// 导出：ShareView / readShares / requeueShare / clearDeliveredShares / sharePaths。
// 调用方：src/index.ts（快照 biliShares 与三个 action）、src/console/routes.ts 的两条写路由。
// 数据文件：<world>/bili/owner-outbox.jsonl（读 + 追加 + 重写）；owner-outbox.jsonl.sent.json（只读）。
// 坑：清空**只删已发**（按 .sent.json 的 id 过滤），不看时间 —— 刚进来还没发的绝不能被删。
// 【链路位置】
//   环节：面板「分享给我」卡的数据源与两个动作；B 站写通道只负责写文件，不经过这里。
//   上游调用：src/index.ts（快照的 biliShares、retryBiliShare、clearBiliShares）、src/console/routes.ts（三个路由）。
//   下游调用：lib/paths 的同一套目录规则（这里自己拼 `bili/owner-outbox*`）；不联网。
//   读写文件：owner-outbox.jsonl（读、追加、清空已发时重写）、owner-outbox.jsonl.sent.json（只读）。
//   失败：读坏了返回空视图，不抛错；写失败由 requeueShare 返回原因、clearDeliveredShares 返回 0。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 队列里的一条分享。bvid/title/say 都可能缺（早期手写的记录只带 url）。 */
export interface ShareRecord {
  id: string;
  at?: string;
  bvid?: string;
  title?: string;
  say?: string;
  url?: string;
  /** 从哪条重发出来（只在面板重发时写）。 */
  requeuedFrom?: string;
}

/** 面板要的一次性视图。 */
export interface ShareView {
  /** 还没发出去的条数。 */
  pending: number;
  /** 已经发出去的条数（按 .sent.json 的 id 计数，队列被压实过就只算还在文件里的）。 */
  sent: number;
  /** 最近若干条（新的在前），带 delivered 标记。 */
  records: (ShareRecord & { delivered: boolean })[];
  /** 分享推送开着没有（bili.config.json 的 share.push，缺省 true）。 */
  push: boolean;
}

/**
 * 队列与记账文件的位置（与工具链 `tools/lib/owner-share.mjs` 的 `dataPath()` 同一条规则）。
 * @param worldDir 世界目录（`~/.dsh/worlds/<id>`）
 * @returns `{ outbox: 队列, state: 已发 id }` 两个绝对路径
 */
export function sharePaths(worldDir: string): { outbox: string; state: string } {
  return {
    outbox: join(worldDir, 'bili', 'owner-outbox.jsonl'),
    state: join(worldDir, 'bili', 'owner-outbox.jsonl.sent.json'),
  };
}

/**
 * 读队列里的全部记录。
 *
 * 坏行跳过（手改坏一行不该让整张卡打不开）；没有 `id` 或没有视频信息的行也跳过 —— 前者没法去重/重发，后者发出去是空的。
 * @param outbox 队列文件路径
 * @returns 有效记录，保持文件里的先后顺序；文件不存在返回空数组
 */
export function readRecords(outbox: string): ShareRecord[] {
  let raw = '';
  try { raw = readFileSync(outbox, 'utf8'); } catch { return []; }
  const out: ShareRecord[] = [];
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      const record = JSON.parse(text) as ShareRecord;
      // 没有 id 没法去重，也没法重发；没有视频信息的记录发出去是空的。
      if (record && typeof record.id === 'string' && record.id && (record.bvid || record.url)) out.push(record);
    } catch { /* 坏行跳过 */ }
  }
  return out;
}

/**
 * 通道已经发出去的 id。
 *
 * 状态文件缺失或写坏了就当「一条都没发过」—— 最坏是重发一条，不能让整张卡打不开。
 * @param state `.sent.json` 的路径
 * @returns id 集合；读失败返回空集合
 */
export function readSentIds(state: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(state, 'utf8')) as { ids?: unknown };
    return new Set(Array.isArray(parsed?.ids) ? parsed.ids.map(String) : []);
  } catch { return new Set(); }
}

/**
 * 分享推送开着没有（`bili.config.json` 的 `share.push`，缺省开）。
 *
 * 读坏了也当开：宁可多推一条，也不悄悄把她的分享关掉。
 * @param worldDir 世界目录
 * @returns true = 开着
 */
export function readPush(worldDir: string): boolean {
  try {
    const file = join(worldDir, 'bili.config.json');
    if (!existsSync(file)) return true;
    const cfg = JSON.parse(readFileSync(file, 'utf8')) as { share?: { push?: unknown } };
    return cfg?.share?.push !== false;
  } catch { return true; }
}

/**
 * 面板的整份视图（一次读盘拼好，路由直接下发）。
 * @param worldDir 世界目录
 * @param limit 最近几条（新的在前），默认 20
 * @returns `{ pending, sent, records, push }`；队列不存在时是空视图（不是 null）
 */
export function readShares(worldDir: string, limit = 20): ShareView {
  const { outbox, state } = sharePaths(worldDir);
  const records = readRecords(outbox);
  const sent = readSentIds(state);
  const delivered = records.filter(record => sent.has(record.id));
  return {
    pending: records.length - delivered.length,
    sent: delivered.length,
    records: records.slice(-limit).reverse().map(record => ({ ...record, delivered: sent.has(record.id) })),
    push: readPush(worldDir),
  };
}

/**
 * 把一条已经发过的记录再递一次：追加一条新 id 的副本，通道会当成新记录发出去。
 *
 * 不删原记录：这样「重发」永远不会改变历史，最坏是多发一条。
 * @param worldDir 世界目录
 * @param id 要重发的那条记录的 id（面板列表里点「重发」传进来的）
 * @param now 测试可注入的时间（决定新 id 与 at）
 * @returns 失败原因（找不到/写盘失败）；成功返回 undefined
 */
export function requeueShare(worldDir: string, id: string, now = Date.now()): string | undefined {
  const { outbox } = sharePaths(worldDir);
  const record = readRecords(outbox).find(item => item.id === id);
  if (!record) return '队列里没有这条（可能已经被清空了）';
  const copy: ShareRecord = {
    ...record,
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date(now).toISOString(),
    requeuedFrom: record.id,
  };
  try {
    mkdirSync(dirname(outbox), { recursive: true });
    appendFileSync(outbox, JSON.stringify(copy) + '\n', 'utf8');
  } catch (error) {
    return `写队列失败：${String((error as Error).message ?? error).slice(0, 80)}`;
  }
  return undefined;
}

/**
 * 清掉已经发出去的记录（待发的永远不动）。
 *
 * 判定只看 `.sent.json` 里的 id、不看时间：刚进队列还没发的，哪怕时间戳很旧也留着。
 * @param worldDir 世界目录
 * @returns 删掉了几条；没有可删的、或写盘失败都返回 0
 */
export function clearDeliveredShares(worldDir: string): number {
  const { outbox, state } = sharePaths(worldDir);
  const records = readRecords(outbox);
  const sent = readSentIds(state);
  const keep = records.filter(record => !sent.has(record.id));
  const removed = records.length - keep.length;
  if (!removed) return 0;
  try { writeFileSync(outbox, keep.map(record => JSON.stringify(record)).join('\n') + (keep.length ? '\n' : ''), 'utf8'); }
  catch { return 0; }
  return removed;
}
