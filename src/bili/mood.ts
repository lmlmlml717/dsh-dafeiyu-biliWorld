// B 站心情与饥饿度：给控制台提供读取/设置心情、喂饭三个入口，状态落在 data/mood.json。
//
// 导出：getBiliMood / setBiliMood / feedBili（状态类型 BiliMood 由 console/routes.ts 定义，本文件只消费）。
// 被谁调用：index.ts 组装出 ConsoleActions，控制台 GET/POST /console/bili-mood 经 routes.ts 调到这里。
// 依赖：tools/lib/paths.mjs（dataPath）、tools/lib/config.mjs（config）、tools/lib/mood.mjs（mood/fed）。
// 坑：喂饭必须走工具链的 fed()，否则宿主和工具链各自维护一份饥饿度会分叉；配置或状态文件损坏时静默退回默认值，
//     心情是展示数据，不能让它把世界或控制台拖死。
//
// 【链路位置】控制台心情卡的后端：GET/POST /console/bili-mood 经 console/routes.ts 分派到
// index.ts 的 ConsoleSources.biliMood 回调（读）与 ConsoleActions.setBiliMood / feedBili（写），再进本文件。
// 上游：index.ts（GET 走 biliMood 回调，POST 走 setBiliMood / feedBili 动作）。
// 下游：tools/lib/paths.mjs 的 dataPath()、tools/lib/config.mjs 的 config()，
//       以及 tools/lib/mood.mjs 的 mood() / fed()（状态机在工具链里，宿主不再写一份）。
// 读写：<world>/bili/mood.json（读心情与饥饿度；set 写、feed 由 fed() 写），bili.config.json 只读不写。
// 与唤醒链路的关系：dailyBili.fire() 里也调 mood.mjs 的 tickMood / stateBlock 把心情写进 prompt，
// 两边必须共用同一份状态文件，否则宿主面板与 prompt 会各说一套。
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from '../../tools/lib/paths.mjs'
import { config } from '../../tools/lib/config.mjs'
import { mood as libMood, fed as libFed } from '../../tools/lib/mood.mjs'
import type { BiliMood } from '../console/routes.ts'

// 默认参数与工具链 mood.mjs 的初始值保持一致；bili.config.json 的 mood 段可逐项覆盖。
const DEFAULTS = { hungerCap: 70, mealGain: 7, decayPerTick: 6, moodBase: 62, hungryMoodPenalty: 1 }
function moodFile() { return dataPath('mood.json') }

// 读配置失败就用默认值：心情是展示数据，配置坏了也不该让面板 500。
function opts(): typeof DEFAULTS {
  try { return { ...DEFAULTS, ...((config() as any)?.mood || {}) } } catch { return { ...DEFAULTS } }
}

// 读不到或解析失败按初始状态处理（心情 62、不饿）；62 与 DEFAULTS.moodBase 对齐。
function readState() {
  try { return JSON.parse(fs.readFileSync(moodFile(), 'utf8')) } catch { return { value: 62, hunger: 0, updatedAt: null, day: '' } }
}

// 写失败静默：下一次读到的还是旧状态，但不影响世界继续跑。
function writeState(st: any) {
  try {
    fs.mkdirSync(path.dirname(moodFile()), { recursive: true })
    fs.writeFileSync(moodFile(), JSON.stringify(st, null, 2) + '\n')
  } catch {}
}

// 本地日键与账本、额度用同一个 sv-SE 写法。
function dayKey(d = new Date()): string { return d.toLocaleDateString('sv-SE') }

// 调用方：index.ts 的 `biliMood: () => { try { return getBiliMood() } catch { return undefined } }`；
// snapshot 汇总成快照字段，routes 的 GET /console/bili-mood 下发（不可用时 404）。
// 参数：无。返回：{ value, hunger, updatedAt, day, opts }，opts 是默认值与 bili.config.json 的 mood 段合并结果。
// 失败/空值：mood.json 缺失或损坏按初始状态（心情 62、饥饿 0）返回；配置读不到只用默认值。
/**
 * 读取当前心情状态；文件缺失或损坏时按初始值（心情 62、饥饿 0）返回。
 * @returns 面板用的 BiliMood，`opts` 是默认值与配置合并后的当前参数。
 */
export function getBiliMood(): BiliMood {
  const st = readState()
  return {
    value: st.value ?? 62,
    hunger: st.hunger ?? 0,
    updatedAt: st.updatedAt ?? null,
    day: st.day ?? '',
    opts: opts(),
  }
}

// 调用方：控制台心情卡提交 { value } → routes → index.ts 的 setBiliMood 动作，改完顺手让快照失效。
// 参数：value 为 0–100，越界夹到边界、小数四舍五入；完全不合法的值由 routes 层先挡掉。
// 返回：写盘后重新读出的 BiliMood（写失败时仍是旧值）。
// 失败：写盘异常被 writeState 吞掉，所以返回值可能没变；读状态失败退回初始值。
/**
 * 手动设置心情值，饥饿度保持不变。
 * @param value 目标心情；会四舍五入并夹到 0–100，越界值不报错而是取边界
 * @returns 写入后重新读出的 BiliMood（写盘失败时可能仍是旧值）
 */
export function setBiliMood(value: number): BiliMood {
  const st = readState()
  // 夹到 0–100：面板可能传来越界值，存进去会让后续计算失真。
  st.value = Math.max(0, Math.min(100, Math.round(value)))
  st.updatedAt = new Date().toISOString()
  st.day = st.day || dayKey()
  writeState(st)
  return getBiliMood()
}

// 调用方：控制台「喂饭」按钮 POST { feed: true | level } → routes → index.ts 的 feedBili 动作。
// 参数：level 是目标饥饿度，不传用 fed() 的默认 20；非数字由 routes 层转成默认。
// 返回：喂饭后的 BiliMood（value / hunger / updatedAt / day 来自 fed() 的返回值）。
// 失败：fed() 抛错就往上抛，宿主层把它包成 { error } 回给面板，这里不吞。
// 【上游参考】饥饿度衰减与心情加成都在 dsh-feiyu 的 mood 状态机（tools/lib/mood.mjs）里；
// 宿主只做展示与三个入口，避免出现第二套算法。
/**
 * 喂饭：降低饥饿度并提升心情，具体算法在工具链 mood.mjs 的 fed() 里。
 * @param level 目标饥饿度；不传时由 fed() 用默认值（20）
 * @returns 喂饭后的 BiliMood；错误由 fed() 抛出，本函数不吞
 */
export function feedBili(level?: number): BiliMood {
  // 喂饭交给工具链：饥饿度衰减、心情加成都在 mood.mjs 里，宿主不重复实现一份。
  const st = libFed(level)
  return {
    value: st.value,
    hunger: st.hunger,
    updatedAt: st.updatedAt,
    day: st.day,
    opts: opts(),
  }
}
