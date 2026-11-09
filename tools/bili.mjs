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
//   node bili.mjs share --bvid BV1xx --say "…"   # 想给他看这条（进队列，宿主 QQ 通道发）
// 【文件头】B站工具链的命令行总入口：按 argv[2] 分发到内置命令（deps/selftest/nav），
// 其余命令动态 import tools/commands/<命令>.mjs。入口本身不碰网络、不读配置。
// 参数：node bili.mjs <命令> [命令自己的参数]；--go / --json / --bvid 等一律由子命令自己解析，入口只透传。
// 读写：只读命令模块与 lib 模块；凭据、配置、账本都由 lib 层按 env 解析，入口不做路径决策。
// 输出：帮助与命令结果打到 stdout，命令说明打到 stderr。
// 退出码：0 成功或正常退出；1 未知命令/加载失败/子命令报告失败；2 部分子命令参数缺失（由子命令设置）。
// 坑：全程只设 process.exitCode，绝不在有 fetch 连接时 process.exit()，否则 Windows + Node 24 会崩在 libuv 断言。
// 【链路位置】
//   环节：整条 B站 链路的命令行入口；宿主 src/bili/dailyBili.ts 投递的 prompt 里写的每一步都是 `node tools/bili.mjs <命令>`。
//   上游调用：宿主定时器算到点后投递 prompt，她按 feed → debrief → act dyn → quota 的顺序逐条执行，每条都是新进程。
//   下游调用：内置命令（deps/selftest/nav）留在本文件；其余命令动态 import tools/commands/<命令>.mjs，命令再 import tools/lib/*。
//   读写文件：入口自己不读写文件，数据目录与配置路径全部由 lib/paths.mjs 按 WORLD_ID / WORLD_BILI_DATA_DIR 解析。
//   退出码：0 成功或只打印用法；1 未知命令、命令加载失败或子命令自报失败；2 子命令参数缺失（由子命令设置）。
//   上游参考：结构与 dsh-bili-whale 的 tools/bili.mjs 同构（内置命令 + commands/*.mjs 动态分发、只设退出码）。
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// 只用无参时打印的用法横幅。0.9.0 起直接从 package.json 读 —— 以前这里写死 '0.1.0'，
// 发到 0.8.x 之后横幅还报 0.1.0，看日志时很容易以为是旧版本在跑。
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version } catch { return '?' }
})()

// 外部命令（commands/*.mjs）—— 这些文件 import lib/ 模块，不依赖 world 宿主
// 这张表同时是分发白名单和无参帮助的唯一来源：新增命令必须在这里补一行，
// 只放文件不加表，命令会被当成未知命令拒掉。
const COMMANDS = {
  feed: '选题：热门+搜索，偏好加权',
  debrief: '看懂一条视频（元信息+字幕+热评+简介）',
  act: 'B站活人感动作：dyn（转发视频/纯文字动态，默认干跑，--go 真发）',
  comment: '给视频发一条顶层评论（默认干跑，--go 真发；--force 跳过概率抽签）',
  quota: '额度账本（check/record/show：每天 ≤shareDaily、同一视频 sameVideoDays 天只发一次）',
  focus: '她决定"接下来这一段时间干什么"：focus bilibili --min 40 ｜focus rest ｜focus off ｜focus（看现在在干什么）',
  share: '想给主人看这条视频：share --bvid BV1xx --say "…"（进队列，宿主 QQ 通道发出去）｜share --list',

}

// ─── 内置命令（不走 commands/，依赖最少，方便 agent 自检）───────────────

// 【补充】调用方：prompt 第 1 步的 `node bili.mjs deps`（selftest 是别名），人工排障也直接跑它。
//   参数：无。逐项检查 Node 版本、凭据、配置、nav 登录态与熔断、guard.dryRun，某一项失败只影响那一项。
//   返回：无返回值，结果打 stdout；不改退出码 —— 体检红了由 agent 自己决定只做读。
/**
 * 依赖体检：node 版本 → 凭据 → 配置 → 登录态/熔断 → 干跑开关，逐项打勾。
 * 只读不写；某一项失败只影响那一项，后面的检查继续跑。
 * @returns {Promise<void>}
 */
async function builtinDeps() {
  const green = (s) => console.log('  ✓ ' + s)
  const red = (s) => console.log('  ✗ ' + s)
  console.log('── 依赖体检 ──')

  // ① node 版本
  const nv = process.versions.node
  const [major] = nv.split('.').map(Number)
  // 18 是 fetch 进标准库的那条线：低于它 lib 里直接调全局 fetch 会抛 ReferenceError，看上去像"接口挂了"。
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
  // 默认就是干跑：这里只提醒，不替人改配置 —— 什么时候关闸是人的决定，不是脚本的决定。
  if (guard.dryBlocked()) console.log('  ⚠ DRY_RUN 开着 —— 所有写操作默认干跑，确认无误后把 bili.config.json 的 guard.dryRun 改 false')
  else green('DRY_RUN 已关')
}

// 【补充】调用方：prompt 里的自检之外，人工用 `node bili.mjs nav` 确认「我是谁」。
//   参数：无；读 lib/cred.mjs 与 lib/bili-api.mjs，打一次 nav 接口（noCache）。
//   返回：mid/nick/等级/VIP/头像/金币；登录态失效时设 process.exitCode = 1 后直接返回。
/**
 * 登录验证 / 我是谁：单独打一次 nav 接口，读 mid、昵称、等级、VIP 与金币。
 * @returns {Promise<void>} 登录态失效时设 process.exitCode = 1，其余情况不改退出码。
 */
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

// 【补充】分发：先查内置表，再查 COMMANDS 白名单，都没有就报未知命令；COMMANDS 同时是无参帮助的唯一来源。
//   外部命令用 pathToFileURL 拼 file:// 再 import（Windows 绝对路径不能直接进动态 import）。
//   退出码只在这里与子命令里设置：加载失败 1、没有 run 导出 1、未知命令 1。
// 内置命令优先
const BUILTIN = {
  deps: builtinDeps,
  selftest: builtinDeps,
  nav: builtinNav,
}

// argv[0] 是 node、argv[1] 是本文件，命令名在 argv[2]；子命令参数从 argv[3] 起，原样透传。
const cmd = process.argv[2]

// 注意：这里一律不调用 process.exit()。
// Windows + Node 24 下，fetch（undici）刚结束就 process.exit() 会触发 libuv 断言
// （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)，退出码 -1073740791），
// deps / selftest / nav 因此每次必崩。改为「设置退出码 + 让进程自然退出」。
// 外部命令（act / comment / debrief …）同理，见 tools/commands/*.mjs。
// 不带命令只打用法并正常退出（退出码 0）：人先看一眼有哪些命令，这不是错误。
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
  console.log('  node bili.mjs share --bvid BV1xx --say "…" # 想给他看这条（宿主 QQ 通道发）')
} else if (BUILTIN[cmd]) {
  await BUILTIN[cmd]()
} else if (!(cmd in COMMANDS)) {
  // 外部命令 → 动态 import commands/<cmd>.mjs
  // 先查白名单再 import：打错字要报"未知命令"，而不是一段 import 不存在文件的堆栈。
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
    // 历史命令文件有的导出 run、有的 default，两种都认；都没有就当这个命令没实现。
    const run = mod.run ?? mod.default
    if (typeof run !== 'function') {
      console.error(`命令 ${cmd} 没有 run 导出`)
      process.exitCode = 1
    } else {
      // 命令名之后的全部参数原样交给命令自己解析：入口不解释任何业务参数，也就不会与子命令口径打架。
      // 0.9.0：命令里抛出来的异常在这里收尾。以前它会变成未处理的 Promise rejection ——
      // 她看到的是一屏堆栈，而不是"这条为什么没发出去"。
      try {
        await run(process.argv.slice(3))
      } catch (e) {
        console.error(`命令 ${cmd} 出错了：${String(e?.message ?? e).slice(0, 160)}`)
        process.exitCode = 1
      }
    }
  }
}
