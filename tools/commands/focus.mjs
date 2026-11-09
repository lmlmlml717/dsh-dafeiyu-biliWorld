// focus —— 她「此刻在做的那一件事」的命令行入口（world 精简版：bilibili / rest / off）。
// 库实现复用 dsh-feiyu 的 tools/lib/focus.mjs（MIT，LOOP_ACTIVITIES 只留 bilibili）。
//
//   node bili.mjs focus bilibili --min 40 --note "今天想看看什么"
//   node bili.mjs focus rest
//   node bili.mjs focus        # 看现在在干什么
// 【文件头】focus 的 CLI：读写「此刻在做的那一件事」，world 精简版只认 bilibili / rest / off。
// 参数：位置参数是活动名（别名见 lib/focus.mjs 的 normActivity）；--min 打算干多久（分钟，0 = 不设时限）、
//       --note 一句话由头；不带活动或给 --show 表示只看现状。
// 读写：只动 focus.json（路径由 lib/paths.mjs 的 dataPath 解析）；不联网、不碰凭据。
// 输出：一行中文说明打到 stdout；不认识的活动打 stderr。
// 退出码：0 正常（没在做什么也是 0）；2 活动名不认识。
// 坑：这里用 process.exit(2) 而不是 exitCode —— 本命令不联网、没有挂起的 fetch，不会踩到 bili.mjs 里那个 libuv 断言。
// 【链路位置】
//   环节：链路最前面的「她决定现在干什么」，prompt 第一段就让她 `focus bilibili --min 40` 或 `focus rest`。
//   上游调用：宿主 src/bili/dailyBili.ts 生成 prompt 时读快照拼 focusLine；她自己在会话里调 CLI 写下此刻的活动。
//   下游调用：lib/focus.mjs 的 focusSnapshot/writeFocus/clearFocus/labelOf；不联网、不碰凭据。
//   读写文件：<数据根>/focus.json（activity/until/setAt/min/note），路径由 lib/paths.mjs 的 dataPath 解析。
//   输出与退出码：一行中文说明打 stdout，不认识的活动打 stderr；0 正常（没在做什么也是 0），2 活动名不认识。
//   上游参考：库实现复用 dsh-feiyu 的 tools/lib/focus.mjs，world 版只保留 bilibili / rest 两种活动。
import * as f from '../lib/focus.mjs'

// 【补充】调用方：run() 解析 --min / --note；只取「--name value」，缺值返回 undefined。
//   参数：argv 全文、name 参数名。
//   返回：字符串值，或 undefined（参数不存在 / 后面没有值）。
//   失败：不抛错；--min 的 NaN 由 run() 归 0。
function arg(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

// 【补充】调用方：tools/bili.mjs 动态 import 后调 run(process.argv.slice(3))。
//   参数：位置参数 argv[0] = 活动名（bilibili/rest/off 或别名），--min 分钟、--note 由头、--show 等价于不带参数。
//   返回：无返回值；结果打 stdout，不认识的活动打 stderr 并退出 2。
//   失败：用 process.exit(2)（本命令无网络句柄）；其余情况不设退出码。
/**
 * focus 入口：看现状 / 写现状 / 收工，三件事共用一条命令。
 * @param {string[]} argv 位置参数是活动名，可选 --min / --note
 * @returns {void} 结果直接打印，不返回数据。
 */
export function run(argv = []) {
  const a = argv[0]

  // 不带参数与 --show 等价：都是"我只想知道现在在干什么"，不改任何状态。
  if (a === undefined || a === '--show') {
    const s = f.focusSnapshot()
    if (!s.activity) { console.log('现在没在做什么（free）。'); return }
    const tail = [s.remainMin ? `还剩 ${s.remainMin} 分钟` : '', s.expired ? '已到点' : '', s.note ? `—— ${s.note}` : ''].filter(Boolean).join('，')
    console.log(`${s.label}${tail ? `（${tail}）` : ''}`)
    return
  }

  // normActivity 认不出时把原字符串原样退回，所以这里必须再白名单一遍，不能把任意输入写进 focus.json。
  const norm = f.normActivity(a)
  if (norm === 'off') { f.clearFocus(); console.log('收工。'); return }
  if (norm !== 'bilibili' && norm !== 'rest') {
    console.error(`不认识的活动：${a}（可用 bilibili / rest / off，或直接 focus 看现状）`)
    process.exit(2)
  }
  // 负数与非数字一律当 0（不设时限）：否则 --min abc 会把 NaN 写进 focus.json，之后算剩余时间全是 NaN。
  const min = Math.max(0, Math.round(Number(arg(argv, '--min') ?? 0) || 0))
  const note = arg(argv, '--note') ?? ''
  const obj = f.writeFocus(norm, min, note)
  console.log(`已记下：${f.labelOf(norm)}${obj.min ? `，干 ${obj.min} 分钟` : ''}${note ? ` —— ${note}` : ''}`)
}
