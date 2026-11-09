// 凭据的共用层。
// 复用 dsh-bili-whale 的 tools/lib/cred.mjs（MIT）的设计与错误码翻译，路径改为 ~/.feiyu-ai。
// ① 读凭据统一 trim ② 缺字段说缺哪个 ③ 把常见错误码翻译成人话（-101/-111/12015/10031/12051/-352）
//
// 【模块卡片】
// 职责：读写 B站 凭据，并把 OpenAPI 错误码翻译成她能看懂的人话。
// 导出：loadCred（读并校验）、saveCred（合并写回）、humanize（错误码转人话）。
// 调用方：tools/bili.mjs（deps/nav）、tools/commands/feed.mjs、debrief.mjs、lib/bili-write.mjs。
// 数据文件：<bili 根>/credentials.json（SESSDATA / bili_jct / buvid3 三个字段）。
// 坑：凭据永不回显到日志；saveCred 只合并不覆盖其它字段；写盘权限必须是 0600。
// 【链路位置】
//   环节：凭据的唯一读口 —— feed/debrief/act/comment 与 tools/bili.mjs 的 deps/nav 都靠 loadCred 拿 SESSDATA / bili_jct / buvid3。
//   上游调用：lib/bili-api.mjs 的调用方（makeHeaders 与 reportWatch 的 cred 都从命令层传进来）、lib/bili-write.mjs、tools/bili.mjs 与各 commands。
//   下游调用：只读 lib/paths.mjs 的 getCredentialsPath；不联网、不读配置。
//   读写文件：<bili 根>/credentials.json；saveCred 合并写回并以 0600 落盘。
//   退出码：库不设退出码；缺文件/坏 JSON/缺字段一律抛 Error（中文原因），由命令决定退出码。
//   上游参考：错误码翻译沿用 dsh-bili-whale 的 tools/lib/cred.mjs（-101 / -111 / 12015 / 10031 / 12051 / -352）。
import fs from 'node:fs'
import { dirname } from 'node:path'
import { getCredentialsPath } from './paths.mjs'
function credPath() { return getCredentialsPath() }

// 【补充】调用方：feed/debrief/act/comment 与 tools/bili.mjs 的 deps/nav。
//   参数：无（路径由 paths.mjs 解析）。返回：解析后的凭据对象（含至少三个必需字段）。
//   失败：文件不存在、JSON 坏、顶层不是对象、缺任一字段都 throw —— 消息里直接写清楚要补什么。
/** 读凭据：统一 trim，容忍 BOM / 首尾空白。 */
export function loadCred() {
  let raw
  // 读不到就当「没配凭据」，把人话指引直接拼进错误里，省得再去翻文档。
  try {
    raw = fs.readFileSync(credPath(), 'utf8')
  } catch {
    throw new Error(`没有凭据文件：${credPath()}\n  先在浏览器 F12 复制 SESSDATA / bili_jct / buvid3，写入这个文件（JSON 三个字段）`)
  }
  let cred
  // BOM 与首尾空白都容忍：浏览器复制、记事本另存经常带上这两样。
  try { cred = JSON.parse(raw.replace(/^\uFEFF/, '').trim()) }
  catch (e) {
    throw new Error(`凭据文件不是合法 JSON：${credPath()}\n  ${String(e.message).slice(0, 80)}`)
  }
  if (!cred || typeof cred !== 'object') throw new Error('凭据 JSON 顶层必须是对象')
  // 三个字段各有分工：SESSDATA 是登录态、bili_jct 是写接口的 csrf、buvid3 参与风控标识。
  const missing = ['SESSDATA', 'bili_jct', 'buvid3'].filter(k => !String(cred[k] || '').trim())
  if (missing.length) throw new Error(`凭据缺字段：${missing.join(', ')}（去浏览器 F12 复制）`)
  return cred
}

// 【补充】调用方：控制台 saveBiliCred（src/index.ts）实际写的是同一份文件；本函数供工具链/测试写回。
//   参数：next 只放要更新的字段（通常是三个凭据字段）；旧文件里其它字段会保留。
//   返回：无返回值；目录不存在会自动建。
//   失败：写盘失败会 throw（权限/占用）；不吞，交给调用方报错。
/** 写凭据（只改这三个字段，保留可能的其他字段比如 bili_jct2）。0600。 */
export function saveCred(next) {
  // 先读旧文件再合并：主人手写的额外字段（比如 bili_jct2）不能因为一次更新就丢掉。
  const prev = (() => {
    try { return JSON.parse(fs.readFileSync(credPath(), 'utf8')) } catch { return {} }
  })()
  const merged = { ...prev, ...next }
  fs.mkdirSync(dirname(credPath()), { recursive: true })
  // 0600 仅属主可读写：凭据等同账号密码，不能让同机其他用户读到。
  fs.writeFileSync(credPath(), JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 })
}

// 【补充】调用方：目前仓库内没有调用点；排障时人工 import 它把接口错误码翻成人话。
//   参数：code 接口返回码；msg 原始 message（未知码时优先返回它）。
//   返回：一句中文说明；未知码且没有 msg 时返回 "B站错误码 N"。
//   失败：不抛错；非数字 code 原样返回 msg 或 code 字符串。
/** 把 B站 OpenAPI 错误码翻译成人话。 */
export function humanize(code, msg = '') {
  const n = Number(code)
  if (!Number.isFinite(n)) return msg || String(code)
  // 只翻译已知的高频码；未知码保留原始 message，宁可不翻译也别把人话编错。
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
