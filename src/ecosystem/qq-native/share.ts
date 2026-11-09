import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 她想给主人看的那条视频。写进来的是 `tools/lib/owner-share.mjs`（CLI 的 `share` 命令），
 * 这里只负责把它变成一条 QQ 私聊发出去 —— 她不用自己跑 shell 去 POST 任何东西。
 *
 * 为什么不复用「整轮转发」：那一轮她说的话可能有三件事，视频混在中间；也可能只说「刷到一个视频」，
 * 链接就丢了。分享这条线要的是确定性：标题、BV、她的话，一次给全。
 */
export interface ShareRecord {
  /** 队列里的唯一 id；通道按它去重，重启后不会把同一条再发一遍。 */
  id: string;
  /** 写进来的时刻（ISO）。 */
  at?: string;
  /** 视频号；给了 bvid 或 url 之一就能发。 */
  bvid?: string;
  title?: string;
  /** 她附在链接上的那句话；可以没有。 */
  say?: string;
  /** 完整链接；缺省时按 bvid 拼。 */
  url?: string;
}

/**
 * 一条分享在 QQ 里长什么样：标题、BV、她的话，各占一行，中间不留空行。
 *
 * 只给 BV，不给长链接：主人要的是能自己贴进 B站 的号，一条 `https://…` 太长、也不方便转述。
 * 空行在 QQ 通道里是「分条」的意思（`replies.ts` 按空行拆消息），留空行会让一次分享变成三条消息。
 * @param record 队列里的一条记录
 * @returns 要发出去的正文；什么内容都没有时返回空串（调用方应跳过）
 */
export function formatShareText(record: ShareRecord): string {
  const lines: string[] = [];
  const title = String(record.title ?? '').trim();
  if (title) lines.push(`《${title}》`);
  // BV 是主格式；只有早期手写的记录没带 bvid 时才退回链接，别让那条发不出去。
  const bvid = String(record.bvid ?? '').trim();
  if (bvid) lines.push(bvid);
  else {
    const url = String(record.url ?? '').trim();
    if (url) lines.push(url);
  }
  const say = String(record.say ?? '').trim();
  if (say) lines.push(say);
  return lines.join('\n');
}

/**
 * 把一个 JSONL 文本读成记录数组。坏行跳过 —— 手改坏一行不该让整条分享线停摆。
 * @param raw 文件全文（可能为空）
 * @returns 有效记录，保持文件里的先后顺序
 */
export function parseShares(raw: string): ShareRecord[] {
  const out: ShareRecord[] = [];
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      const record = JSON.parse(text) as Partial<ShareRecord> | null;
      // 没有 id 就没法记账，发出去等于每次都重发；没有 bvid/url 就只是个空壳。两种都当坏行。
      if (!record || typeof record.id !== 'string' || !record.id) continue;
      if (!record.bvid && !record.url) continue;
      out.push({ ...record, bvid: String(record.bvid ?? '') } as ShareRecord);
    } catch { /* 坏行跳过 */ }
  }
  return out;
}

export interface ShareOutboxOptions {
  /** 队列文件（`<world>/bili/owner-outbox.jsonl`）；不存在就是还没有人分享过。 */
  file: string;
  /** 已经发出去的 id 存这儿；缺省是 `<file>.sent.json`，与 CLI 的 `share --list` 用同一条规则。 */
  stateFile?: string;
  /** 真正发一条；抛错表示这次没发出去，下一轮再试。 */
  send(text: string, record: ShareRecord): Promise<void>;
  /**
   * 现在是不是能发。返回 false 时这一轮直接跳过、**不算一次失败** —— 静默中、通道还没建起来
   * 都属于「等一等」，不是「发不出去」，不能把它们耗成放弃。
   */
  ready?(): boolean;
  intervalMs?: number;
  /** 同一条最多试几次就放弃（放弃会留在状态里，重启也不会再发）。 */
  maxTries?: number;
  logger?: { warn(...args: unknown[]): void; info?(...args: unknown[]): void };
}

const MAX_REMEMBERED = 400;

/**
 * 轮询「想给你看」队列，把新记录交给 QQ 通道发出去。
 *
 * 只认 id 去重：队列只追加、从不改写，所以同一个文件被反复读是安全的；已经发过的 id 记在
 * `<file>.sent.json` 里，DSH 重启、插件重载都不会重发。发不出去的留在原地等下一轮，
 * 试满 maxTries 才放弃（放弃也记下来，否则每次重启都要再试一遍）。
 */
export function createShareOutbox(options: ShareOutboxOptions) {
  const stateFile = options.stateFile ?? `${options.file}.sent.json`;
  const maxTries = options.maxTries ?? 30;
  const delivered = new Set<string>(loadIds());
  const tries = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let flushing = false;
  let sent = 0;

  function loadIds(): string[] {
    try {
      const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { ids?: unknown };
      // 状态文件只用于去重，读坏了就当没记过 —— 最坏是重发一条，不能因此打不开通道。
      return Array.isArray(state?.ids) ? state.ids.map(String) : [];
    } catch { return []; }
  }
  function saveIds(): void {
    try {
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ ids: [...delivered].slice(-MAX_REMEMBERED) }, null, 2) + '\n', 'utf8');
    } catch (error) { options.logger?.warn('分享队列的记账没写下去（重启后可能重发）', error); }
  }
  function giveUp(id: string): void {
    delivered.add(id);
    tries.delete(id);
    saveIds();
  }

  /** 读一遍队列，把欠的都补发。定时器与 start() 的立即补发都走这里。 */
  async function flush(): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
      // 静默中、没有主人 QQ、通道还没起来：留着，下一轮再看。这种「等一等」不消耗重试次数。
      if (options.ready && !options.ready()) return;
      let raw = '';
      try { raw = readFileSync(options.file, 'utf8'); } catch { return; }
      for (const record of parseShares(raw)) {
        if (delivered.has(record.id)) continue;
        const text = formatShareText(record);
        if (!text) { giveUp(record.id); continue; }
        const attempt = (tries.get(record.id) ?? 0) + 1;
        try {
          await options.send(text, record);
          delivered.add(record.id);
          tries.delete(record.id);
          saveIds();
          sent += 1;
          options.logger?.info?.(`分享已发出：${record.title || record.bvid}`);
        } catch (error) {
          tries.set(record.id, attempt);
          if (attempt >= maxTries) {
            options.logger?.warn(`分享《${record.title || record.bvid}》试了 ${attempt} 次都没发出去，放弃`);
            giveUp(record.id);
          } else {
            options.logger?.warn(`分享《${record.title || record.bvid}》没发出去（第 ${attempt} 次），下一轮再试`);
          }
          // 通道不通时后面的也发不出去：先停，下一轮从这条接着来。
          return;
        }
      }
    } finally { flushing = false; }
  }

  return {
    /** 启动轮询，并立刻补发一次（DSH 刚起来时队列里可能已经躺了几条）。 */
    start(): void {
      if (timer) return;
      void flush();
      timer = setInterval(() => { void flush(); }, options.intervalMs ?? 3_000);
      // 别因为这个定时器让进程退不出去。
      timer.unref?.();
    },
    stop(): void { if (timer) { clearInterval(timer); timer = undefined; } },
    /** 手动跑一轮（测试用；定时器也调它）。 */
    flush,
    /** 还没发出去的条数；状态面板/日志用。 */
    pending(): number {
      let raw = '';
      try { raw = readFileSync(options.file, 'utf8'); } catch { return 0; }
      return parseShares(raw).filter(record => !delivered.has(record.id)).length;
    },
    /** 这个实例一共发出去几条。 */
    sentTotal(): number { return sent; },
  };
}

export type ShareOutbox = ReturnType<typeof createShareOutbox>;
