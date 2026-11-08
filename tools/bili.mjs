#!/usr/bin/env node
// dsh-world B站工具链总入口。
// 结构仿 dsh-bili-whale / dsh-feiyu 的 bili.mjs / feiyu.mjs：
//   命令分发到 tools/commands/*.mjs（外部）
//   nav / deps / selftest 内置在入口里（不占 commands 目录，且依赖最少）
//
//   node bili.mjs <命令> [参数]
//   node bili.mjs deps          # 依赖体检（装完立刻跑）
//   node bili.mjs nav           # 登录验证 / 我是谁
//   node bili.mjs feed [--n 10] [--json]       # 选题
//   node bili.mjs debrief --bvid BV1xx [--json] # 看懂一条
//   node bili.mjs act dyn --text "…" --go       # 发动态（默认干跑）
//   node bili.mjs act like --bvid BV1xx --go    # 点赞
//   node bili.mjs act coin --bvid BV1xx --num 1 --go
//   node bili.mjs act danmaku --bvid BV1xx --text "…" [--at 秒] --go
//   node bili.mjs act pic --bvid BV1xx --message "…" --image <路径> --go
//   node bili.mjs act follow --bvid BV1xx --go
//   node bili.mjs quota show                     # 今日额度
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const VERSION = '0.1.0'

// 外部命令（commands/*.mjs）—— 这些文件 import lib/ 模块，不依赖 world 宿主
const COMMANDS = {
  feed: '选题：热门+搜索，偏好加权',
  debrief: '看懂一条视频（元信息+字幕+热评+简介）',
  act: 'B站活人感动作：dyn（转发视频/纯文字动态，默认干跑，--go 真发）',
  comment: '给视频发一条顶层评论（默认干跑，--go 真发；--force 跳过概率抽签）',
  quota: '额度账本（check/record/show：每天 ≤shareDaily、同一视频 sameVideoDays 天只发一次）',
  focus: '她决定"接下来这一段时间干什么"：focus bilibili --min 40 ｜focus rest ｜focus off ｜focus（看现在在干什么）',

}

// ─── 内置命令（不走 commands/，依赖最少，方便 agent 自检）───────────────

async function builtinDeps() {
  const green = (s) => console.log('  ✓ ' + s)
  const red = (s) => console.log('  ✗ ' + s)
  console.log('── 依赖体检 ──')

  // ① node 版本
  const nv = process.versions.node
  const [major] = nv.split('.').map(Number)
  if (major >= 18) green(`Node ${nv}（Fetch + ESM 原生支持）`)
  else red(`Node ${nv}（需要 ≥ 18，fetch 缺失）`)

  // ② 凭据文件
  const { getCredentialsPath } = await import('./lib/paths.mjs')
  const { loadCred } = await import('./lib/cred.mjs')
  let cred
  try {
    cred = loadCred()
    green(`凭据 OK（${getCredentialsPath()}）`)
  } catch (e) {
    red(String(e.message ?? e))
    console.log('    → 浏览器 F12 复制 cookie 里的 SESSDATA / bili_jct / buvid3，JSON 三字段写入上面路径')
  }

  // ③ config 文件
  const { getConfigPath } = await import('./lib/paths.mjs')
  const { config } = await import('./lib/config.mjs')
  try {
    const cfg = config()
    green(`config OK（${getConfigPath()}）`)
  } catch (e) {
    red(`config 读失败：${String(e.message ?? e).slice(0, 80)}`)
  }

  // ④ API 连通性 + 登录态（nav 接口）
  if (cred) {
    const { apiGet, makeHeaders, apiState } = await import('./lib/bili-api.mjs')
    const H = makeHeaders(cred)
    const r = await apiGet('https://api.bilibili.com/x/web-interface/nav', H, { noCache: true })
    if (Number(r?.code) === 0 && r?.data?.mid) {
      green(`登录态 OK：mid=${r.data.mid}，nick=${r.data.uname}`)
    } else {
      red(`登录态失效：code=${r?.code} msg=${r?.message ?? ''}`)
    }
    const state = apiState()
    if (state.banned) red(`API 熔断中：剩 ${state.banMinutesLeft} 分钟（${state.banWhy ?? ''}）`)
    else green(`API 正常（缓存 ${state.cacheEntries} 条）`)
  }

  // ⑤ guard 状态
  const guard = (await import('./lib/guard.mjs'))
  if (guard.dryBlocked()) console.log('  ⚠ DRY_RUN 开着 —— 所有写操作默认干跑，确认无误后把 bili.config.json 的 guard.dryRun 改 false')
  else green('DRY_RUN 已关')
}

async function builtinNav() {
  const { loadCred } = await import('./lib/cred.mjs')
  const { apiGet, makeHeaders } = await import('./lib/bili-api.mjs')
  const cred = loadCred()
  const H = makeHeaders(cred)
  const r = await apiGet('https://api.bilibili.com/x/web-interface/nav', H, { noCache: true })
  if (Number(r?.code) !== 0 || !r?.data) {
    console.log(`登录态失效：${r?.message ?? '接口不可达'}（code=${r?.code}）`)
    process.exitCode = 1
    return
  }
  const d = r.data
  console.log(`mid=${d.mid}  nick=${d.uname}  level=${d.level_info?.current_level ?? '?'}  VIP=${d.vipStatus}`)
  console.log(`头像：${d.face}`)
  console.log(`金币：${d.money}`)
}

// ─── 主入口 ────────────────────────────────────────────────────────────────

// 内置命令优先
const BUILTIN = {
  deps: builtinDeps,
  selftest: builtinDeps,
  nav: builtinNav,
}

const cmd = process.argv[2]

// 注意：这里一律不调用 process.exit()。
// Windows + Node 24 下，fetch（undici）刚结束就 process.exit() 会触发 libuv 断言
// （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)，退出码 -1073740791），
// deps / selftest / nav 因此每次必崩。改为「设置退出码 + 让进程自然退出」。
// 外部命令（act / comment / debrief …）同理，见 tools/commands/*.mjs。
if (!cmd) {
  console.log('dsh-world B站工具链 v' + VERSION)
  console.log('')
  console.log('用法：node bili.mjs <命令> [参数]')
  console.log('')
  console.log('内置命令：')
  console.log('  deps           依赖体检（装完立刻跑）')
  console.log('  selftest       同 deps（别名）')
  console.log('  nav            登录验证 / 我是谁')
  console.log('')
  console.log('外部命令（commands/*.mjs）：')
  for (const [name, desc] of Object.entries(COMMANDS)) console.log(`  ${name.padEnd(10)} ${desc}`)
  console.log('')
  console.log('常用：')
  console.log('  node bili.mjs feed --json                 # agent 用 --json 拿结构数据')
  console.log('  node bili.mjs debrief --bvid BV1xx        # 看懂一条视频')
  console.log('  node bili.mjs act dyn --text "…" --go     # 发动态（--go 才真发）')
  console.log('  node bili.mjs quota show                  # 今天额度/发过哪些视频')
} else if (BUILTIN[cmd]) {
  await BUILTIN[cmd]()
} else if (!(cmd in COMMANDS)) {
  // 外部命令 → 动态 import commands/<cmd>.mjs
  console.error(`未知命令：${cmd}`)
  console.log('可用：' + Object.keys({ ...BUILTIN, ...COMMANDS }).join(' | '))
  process.exitCode = 1
} else {
  // Windows 绝对路径不能直接进动态 import —— 必须 file:// URL
  const modPath = path.join(HERE, 'commands', `${cmd}.mjs`)
  const modUrl = pathToFileURL(modPath).href
  let mod
  try {
    mod = await import(modUrl)
  } catch (e) {
    console.error(`加载命令 ${cmd} 失败：${String(e.message ?? e).slice(0, 120)}`)
    console.error('  确认 tools/commands/ 下有对应的 .mjs 文件')
    process.exitCode = 1
  }
  if (mod) {
    const run = mod.run ?? mod.default
    if (typeof run !== 'function') {
      console.error(`命令 ${cmd} 没有 run 导出`)
      process.exitCode = 1
    } else {
      await run(process.argv.slice(3))
    }
  }
}
