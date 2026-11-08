// focus —— 她「此刻在做的那一件事」的命令行入口（world 精简版：bilibili / rest / off）。
// 库实现复用 dsh-feiyu 的 tools/lib/focus.mjs（MIT，LOOP_ACTIVITIES 只留 bilibili）。
//
//   node bili.mjs focus bilibili --min 40 --note "今天想看看什么"
//   node bili.mjs focus rest
//   node bili.mjs focus        # 看现在在干什么
import * as f from '../lib/focus.mjs'

function arg(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

export function run(argv = []) {
  const a = argv[0]

  if (a === undefined || a === '--show') {
    const s = f.focusSnapshot()
    if (!s.activity) { console.log('现在没在做什么（free）。'); return }
    const tail = [s.remainMin ? `还剩 ${s.remainMin} 分钟` : '', s.expired ? '已到点' : '', s.note ? `—— ${s.note}` : ''].filter(Boolean).join('，')
    console.log(`${s.label}${tail ? `（${tail}）` : ''}`)
    return
  }

  const norm = f.normActivity(a)
  if (norm === 'off') { f.clearFocus(); console.log('收工。'); return }
  if (norm !== 'bilibili' && norm !== 'rest') {
    console.error(`不认识的活动：${a}（可用 bilibili / rest / off，或直接 focus 看现状）`)
    process.exit(2)
  }
  const min = Math.max(0, Math.round(Number(arg(argv, '--min') ?? 0) || 0))
  const note = arg(argv, '--note') ?? ''
  const obj = f.writeFocus(norm, min, note)
  console.log(`已记下：${f.labelOf(norm)}${obj.min ? `，干 ${obj.min} 分钟` : ''}${note ? ` —— ${note}` : ''}`)
}
