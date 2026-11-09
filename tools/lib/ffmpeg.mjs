// ffmpeg 定位 —— 抽帧看画面要用它；本文件只负责"找到并调用"，不打包 ffmpeg。
//
// 为什么单独一个文件：旧实现把 ffmpeg 路径写死在抽帧脚本里（作者本机剪映自带那一份），
// 换台机器没有剪映、或版本号不同，抽帧就直接报错。这里按顺序找，找不到就给一段能照做的提示。
//
// 查找顺序（找到即用）：
//   ① 环境变量 FFMPEG          —— 用户明确指定，优先级最高
//   ② PATH 里的 ffmpeg(.exe)   —— winget/scoop/brew 装完就是这个
//   ③ <仓库>/bin/ffmpeg(.exe)  —— 想随包带一份静态构建时放这里（⚠️ 只放 LGPL 变体并附 LICENSE）
//   ④ ~/.dsh/worlds/<world>/bili/bin/ —— 用户自己丢进来的那一份
//   ⑤ 本机剪映自带 —— 只作"本机便利"，不能当发布依赖
//
// 【上游参考】定位顺序与提示文案沿用 dsh-bili-whale 的 tools/lib/ffmpeg.mjs（MIT）；这里改成跟着 world 数据目录走。
//
// 【模块卡片】
// 职责：按固定顺序找到可用的 ffmpeg，并回答「装在哪、能不能用」—— 不打包 ffmpeg，也不替人安装。
// 导出：ffmpegPath（找不到返回 null）/ requireFfmpeg（找不到抛中文原因）/ ffmpegInfo（路径 + 版本）。
// 调用方：tools/lib/frames.mjs 的 captureFrames（只用 ffmpegPath）；requireFfmpeg / ffmpegInfo 目前**没有调用点**，
//        留给排障与以后的面板（写在这里是为了下次找的时候不用猜）。
// 数据文件：只读文件系统 / PATH / 剪映安装目录，不写盘。
// 坑：路径里带空格时必须给 execFileSync 传数组参数，拼成一整条命令会被拆开；Windows 上只认 .exe。
// 【链路位置】
//   环节：debrief 第⑥路（抽帧）的前置条件 —— 找不到 ffmpeg 就只丢这一路，其余五路照常。
//   上游调用：frames.mjs 的 captureFrames。
//   下游调用：node:fs / node:path / node:child_process / lib/paths.mjs（dataPath）。
//   读写文件：只读。退出码：库不设；找不到时由调用方决定降级成「这一路缺失」。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dataPath } from './paths.mjs'

const EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
// tools/lib → 仓库根；只用于 ③ 的 <仓库>/bin。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOME = process.env.USERPROFILE || process.env.HOME || '.'

const exists = (file) => {
  if (!file) return false
  try { return fs.statSync(file).isFile() } catch { return false }
}

/** PATH 里逐个目录找 ffmpeg；找不到返回 null。 */
function onPath() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const file = path.join(dir, EXE)
    if (exists(file)) return file
  }
  return null
}

/** 剪映自带的 ffmpeg（仅 Windows）：版本号在路径里，所以要扫目录。 */
function jianyingCopies() {
  if (process.platform !== 'win32') return []
  const base = path.join(process.env.LOCALAPPDATA || '', 'JianyingPro', 'Apps')
  try {
    return fs.readdirSync(base).map((v) => path.join(base, v, 'ffmpeg.exe')).filter(exists)
  } catch { return [] }
}

/**
 * 找 ffmpeg：找到返回绝对路径，找不到返回 null（调用方自己决定降级还是报错）。
 * @returns {string | null}
 */
export function ffmpegPath() {
  const candidates = [
    process.env.FFMPEG,
    onPath(),
    path.join(ROOT, 'bin', EXE),
    dataPath('bin', EXE),
    ...jianyingCopies(),
  ]
  return candidates.find(exists) ?? null
}

/**
 * 找 ffmpeg，缺失时抛一段可照做的错误（抽帧那一路要它）。
 * @throws {Error} 找不到时，message 里列出三种安装/指定方式
 */
export function requireFfmpeg() {
  const found = ffmpegPath()
  if (found) return found
  throw new Error([
    '找不到 ffmpeg（抽帧看画面需要它）。任选一种解决：',
    '  ① 装一个：winget install ffmpeg（或 scoop install ffmpeg / brew install ffmpeg / apt install ffmpeg）',
    '  ② 用环境变量指定：set FFMPEG=D:\\path\\to\\ffmpeg.exe',
    `  ③ 放到 ${path.join(ROOT, 'bin', EXE)} 或 ${dataPath('bin', EXE)}`,
  ].join('\n'))
}

/**
 * 依赖体检用：返回 { ok, path, version }；找不到或跑不起来都不抛错。
 * @returns {{ ok: boolean, path: string | null, version: string | null, error?: string }}
 */
export function ffmpegInfo() {
  const file = ffmpegPath()
  if (!file) return { ok: false, path: null, version: null }
  try {
    const out = execFileSync(file, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 15_000 })
    return { ok: true, path: file, version: (out.split('\n')[0] || '').trim() }
  } catch (e) {
    return { ok: false, path: file, version: null, error: String(e.message).slice(0, 120) }
  }
}
