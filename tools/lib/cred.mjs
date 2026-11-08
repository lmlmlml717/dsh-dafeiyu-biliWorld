// 凭据的共用层。
// 复用 dsh-bili-whale 的 tools/lib/cred.mjs（MIT）的设计与错误码翻译，路径改为 ~/.feiyu-ai。
// ① 读凭据统一 trim ② 缺字段说缺哪个 ③ 把常见错误码翻译成人话（-101/-111/12015/10031/12051/-352）
import fs from 'node:fs'
import { dirname } from 'node:path'
import { getCredentialsPath } from './paths.mjs'
function credPath() { return getCredentialsPath() }

/** 读凭据：统一 trim，容忍 BOM / 首尾空白。 */
export function loadCred() {
  let raw
  try {
    raw = fs.readFileSync(credPath(), 'utf8')
  } catch {
    throw new Error(`没有凭据文件：${credPath()}\n  先在浏览器 F12 复制 SESSDATA / bili_jct / buvid3，写入这个文件（JSON 三个字段）`)
  }
  let cred
  try { cred = JSON.parse(raw.replace(/^\uFEFF/, '').trim()) }
  catch (e) {
    throw new Error(`凭据文件不是合法 JSON：${credPath()}\n  ${String(e.message).slice(0, 80)}`)
  }
  if (!cred || typeof cred !== 'object') throw new Error('凭据 JSON 顶层必须是对象')
  const missing = ['SESSDATA', 'bili_jct', 'buvid3'].filter(k => !String(cred[k] || '').trim())
  if (missing.length) throw new Error(`凭据缺字段：${missing.join(', ')}（去浏览器 F12 复制）`)
  return cred
}

/** 写凭据（只改这三个字段，保留可能的其他字段比如 bili_jct2）。0600。 */
export function saveCred(next) {
  const prev = (() => {
    try { return JSON.parse(fs.readFileSync(credPath(), 'utf8')) } catch { return {} }
  })()
  const merged = { ...prev, ...next }
  fs.mkdirSync(dirname(credPath()), { recursive: true })
  fs.writeFileSync(credPath(), JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 })
}

/** 把 B站 OpenAPI 错误码翻译成人话。 */
export function humanize(code, msg = '') {
  const n = Number(code)
  if (!Number.isFinite(n)) return msg || String(code)
  const MAP = {
    0: 'OK',
    '-101': '账号未登录（凭据过期了，浏览器 F12 重新复制 SESSDATA 等）',
    '-111': 'CSRF 校验失败（bili_jct 过期，重新复制）',
    10031: '账号被风控 / 禁言 / 小黑屋',
    12015: '投稿被限流（歇会再发）',
    12051: 'API 频率太高（requests.log 里应该能看到限流日志）',
    '-352': '账号被冻结（bilibili 手机 app 登录看通知）',
    65: 'API 下线 / 需要 appkey 更新（工具链版本太老）',
  }
  return MAP[n] || (msg || `B站错误码 ${n}`)
}
