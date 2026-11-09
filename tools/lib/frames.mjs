// frames —— 抽帧看画面：取播放直链 → 下载 → ffmpeg 找画面变化点 → 抽 N 帧拼成一张九宫格。
//
// 为什么要有这一路：字幕/热评/简介都是文字，遇到"没有官方字幕、靠画面和界面"的视频就瞎了。
// 抽帧把"长什么样"变成一张图，再交给 read_image 看——脚本只负责备素材，判断留给模型。
//
// 【上游参考】直链取法与"等间隔骨架 + 吸附画面变化点"的取帧策略来自 dsh-bili-whale 的
//   tools/commands/bili-watch.mjs（MIT）；本文件把它的 CLI 外壳去掉，改成 debrief 可复用的函数。
//
// 坑（沿用 whale 的实测结论）：
//   · qn=80 + platform=pc 才是 720p；html5 会被压到 360p，画面小字全糊。
//   · 下载必须流式写盘：两小时 720p 视频用 arrayBuffer 会有一两个 GB 的内存峰值。
//   · 视频越长抽帧越久，超时按"120s + 每秒视频 1.5s"算，否则 25 分钟的片子会 ETIMEDOUT。
//
// 【模块卡片】
// 职责：debrief 第⑥路 —— 取直链、流式下载、ffmpeg 抽帧拼图，并在收尾时清理缓存目录。
// 导出：captureFrames / pruneFrames / pruneCacheDir / FRAME_CACHE_MAX_BYTES / FRAME_CACHE_MAX_AGE_MS。
// 调用方：tools/commands/debrief.mjs（六路里的「画面」）；宿主 src/index.ts 的「现在清理」按钮（pruneCacheDir）；
//        各测试（pruneFrames / pruneCacheDir 用临时目录）。
// 数据文件：<bili 根>/cache/frames/<BV>-<stamp>.mp4|jpg（本次产物 + 历史缓存，按上限淘汰）。
// 坑：一次 debrief 会留下 mp4 + 九宫格 + 字幕带三个文件，长片的 mp4 很大 —— 所以每次抽帧结束都要 prune。
// 【链路位置】
//   环节：debrief 的 ⑥ 画面路；没有 ffmpeg / 拿不到直链 / 超时都只丢这一路，不影响其余五路。
//   上游调用：debrief.mjs（captureFrames、pruneCacheDir）、src/index.ts 的 cleanBiliCache。
//   下游调用：lib/bili-api.mjs（playurl）、lib/ffmpeg.mjs（找 ffmpeg）、lib/media.mjs（pickFrameTimes）、lib/paths.mjs。
//   读写文件：写 cache/frames（下载的 mp4、拼图、字幕带），读/删同一个目录做清理。
//   退出码：库不设；抓不到直链、下载失败、ffmpeg 失败都 throw，由 debrief 降级成「这一路缺失」。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { apiGet } from './bili-api.mjs'
import { ffmpegPath } from './ffmpeg.mjs'
import { fmtClock, pickFrameTimes } from './media.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 抽帧缓存上限：超过就按最旧删。一次 debrief 会留下 mp4 + 九宫格 + 字幕带三个文件，长片 mp4 很大。 */
export const FRAME_CACHE_MAX_BYTES = 300 * 1024 * 1024
/** 抽帧缓存最长保留时间：再久也不会回头重看同一批帧。 */
export const FRAME_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000

/**
 * 清理抽帧缓存目录：先删过期文件，再按“最旧优先”删到总大小不超限。
 * 只删这个目录下的普通文件，失败不抛错（清理失败不该让 debrief 失败）。
 * @param {string} dir dataPath('cache','frames') 或测试里的临时目录
 * @param {{maxBytes?:number, maxAgeMs?:number, now?:number}} [opts]
 * @returns {{removed:number, keptBytes:number}}
 */
export function pruneFrames(dir, opts = {}) {
  const maxBytes = Math.max(0, Number(opts.maxBytes ?? FRAME_CACHE_MAX_BYTES) || 0)
  const maxAgeMs = Math.max(0, Number(opts.maxAgeMs ?? FRAME_CACHE_MAX_AGE_MS) || 0)
  const now = Number(opts.now ?? Date.now())
  let removed = 0
  let kept = []
  try {
    kept = fs.readdirSync(dir)
      .map((name) => {
        const file = path.join(dir, name)
        const stat = fs.statSync(file)
        return stat.isFile() ? { file, size: stat.size, mtimeMs: stat.mtimeMs } : null
      })
      .filter(Boolean)
  } catch { return { removed: 0, keptBytes: 0 } }
  kept.sort((a, b) => a.mtimeMs - b.mtimeMs)
  // ① 过期先删；② 再从最旧的开始删，直到总大小回到上限内。
  const survivors = []
  for (const item of kept) {
    if (maxAgeMs > 0 && now - item.mtimeMs > maxAgeMs) { fs.rmSync(item.file, { force: true }); removed++ } else survivors.push(item)
  }
  let total = survivors.reduce((n, item) => n + item.size, 0)
  for (const item of survivors) {
    if (total <= maxBytes) break
    fs.rmSync(item.file, { force: true }); removed++; total -= item.size
  }
  return { removed, keptBytes: total }
}

/**
 * cache 目录的通用清理入口：同一套「先删过期、再按最旧删到上限内」的规则。
 * 抽帧之外还有别的缓存目录（比如 debrief 的 cache/covers），别再各写一份。
 * @param {string} dir 要清理的目录
 * @param {{maxBytes?:number, maxAgeMs?:number, now?:number}} [opts] 不传就用抽帧那套上限
 * @returns {{removed:number, keptBytes:number}}
 */
export function pruneCacheDir(dir, opts = {}) {
  return pruneFrames(dir, opts)
}

/** 跑 ffmpeg 抽一帧（或做一次拼图），失败时把 stderr 尾部带出来，方便判断是解码还是参数问题。 */function runFfmpeg(ffmpeg, args, timeout = 120_000) {
  try {
    execFileSync(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout, maxBuffer: 8 * 1024 * 1024 })
  } catch (e) {
    const err = String(e.stderr ?? e.message ?? '')
    throw new Error(`ffmpeg 失败：${err.slice(-300) || e.message}`)
  }
}

/**
 * 用场景过滤器找出画面变化点；检出不够时逐级放宽阈值（录屏/讲解类画面变化平缓）。
 * @returns {number[]} 变化点秒数（去重、去掉开头 0.2 秒内的抖动）
 */
function sceneTimes(ffmpeg, file, threshold, timeout) {
  try {
    const out = execFileSync(ffmpeg, ['-hide_banner', '-i', file, '-vf', `select='gt(scene,${threshold})',metadata=print:file=-`, '-an', '-f', 'null', '-'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout, maxBuffer: 16 * 1024 * 1024,
    })
    return [...new Set([...out.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number(m[1])))].filter((t) => t > 0.2)
  } catch { return [] }
}

/**
 * 抽帧并拼图。
 * @param {{ bvid:string, cid:number|string, duration:number, headers:Record<string,string>, outDir:string, grid?:string, tile?:number,
 *   cache?:{maxBytes?:number, maxAgeMs?:number} }} input
 *   outDir 通常是 dataPath('cache','frames')；headers 用 makeHeaders(cred) 的结果。
 *   cache 是清理阈值（面板/配置可调）；不传就用 FRAME_CACHE_* 的默认值。
 * @returns {Promise<{ sheet:string, subs:string|null, mp4:string, quality:number|string, how:string, times:number[] }>}
 * @throws {Error} 缺 ffmpeg、拿不到直链、下载失败或抽帧失败时抛错（调用方降级成"这一路缺失"）
 */
export async function captureFrames({ bvid, cid, duration, headers, outDir, grid = '3x3', tile = 720, cache = {} }) {
  const ffmpeg = ffmpegPath()
  if (!ffmpeg) throw new Error('没有 ffmpeg（抽帧看画面需要它；装好后重试，或加 --no-frames 跳过这一路）')
  const [cols, rows] = String(grid).split('x').map(Number)
  if (!cols || !rows) throw new Error(`--grid 应形如 3x3，收到 ${grid}`)
  const count = cols * rows

  // ① 播放直链：qn=80 是 1080P 档，platform=pc 才不会被打回 360p。
  const play = await apiGet(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=80&fnval=1&platform=pc&high_quality=1`, headers)
  const url = play?.data?.durl?.[0]?.url
  if (!url) throw new Error(`没拿到播放直链（code=${play?.code} ${play?.message ?? ''}）——这条可能要登录或只有 dash 流`)

  // ② 流式下载：内存占用恒定，长视频也不会把进程撑爆。
  fs.mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const mp4 = path.join(outDir, `${bvid}-${stamp}.mp4`)
  const res = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', range: 'bytes=0-' } })
  if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(mp4))

  // ③ 取帧方式：等间隔骨架 + 吸附画面变化点（阈值阶梯：0.3 → 0.15 → 0.08）。
  const timeout = 120_000 + Math.round((Number(duration) || 0) * 1.5) * 1000
  let scenes = []
  for (const threshold of [0.3, 0.15, 0.08]) {
    scenes = sceneTimes(ffmpeg, mp4, threshold, timeout)
    if (scenes.length >= count) break
  }
  const { times, how } = pickFrameTimes({ duration, count, sceneTimes: scenes })

  // ④ 逐帧抽到临时目录，再拼成一张图；临时目录无论成败都清掉。
  const tmp = path.join(outDir, `.frames-${stamp}`)
  fs.mkdirSync(tmp, { recursive: true })
  const sheet = path.join(outDir, `${bvid}-${stamp}-${cols}x${rows}.jpg`)
  let subs = null
  try {
    times.forEach((t, i) => {
      runFfmpeg(ffmpeg, ['-y', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', mp4, '-frames:v', '1', '-q:v', '2', path.join(tmp, `f${String(i).padStart(2, '0')}.jpg`)])
    })
    runFfmpeg(ffmpeg, ['-y', '-loglevel', 'error', '-i', path.join(tmp, 'f%02d.jpg'), '-vf', `scale=${tile}:-1,tile=${cols}x${rows}`, '-frames:v', '1', sheet])
    if (!fs.existsSync(sheet)) throw new Error('九宫格没生成')

    // ⑤ 字幕带（可选）：把同一批帧裁成"画面下方字幕条"竖排——硬字幕视频靠它读台词最省。
    //    用同一批帧，不额外解码；失败只丢这一张，不影响九宫格。
    try {
      const strip = path.join(outDir, `${bvid}-${stamp}-subs.jpg`)
      runFfmpeg(ffmpeg, ['-y', '-loglevel', 'error', '-i', path.join(tmp, 'f%02d.jpg'), '-vf', `crop=iw:ih*0.17:0:ih*0.83,scale=1280:-1,tile=1x${count}`, '-frames:v', '1', strip])
      if (fs.existsSync(strip)) subs = strip
    } catch { subs = null }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  // ⑥ 缓存清理：只保留最近的帧素材，避免长跑把盘吃满（失败不影响这次结果）。
  try { pruneFrames(outDir, cache) } catch { /* 清理失败不算抽帧失败 */ }

  console.log(`[frames] 时间点：${times.map((t, i) => `${i + 1}=${fmtClock(t)}`).join('  ')}`)
  return { sheet, subs, mp4, quality: play?.data?.quality ?? '?', how, times }
}
