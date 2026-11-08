# 搜索种子：每轮取 2 个到底搜哪两个

> 状态：**0.8.12 起按本地日期轮换**——每轮仍只搜 2 个，但窗口每天平移 2，n 个种子在 ⌈n/2⌉ 天内全部轮到。
> 相关代码：[`tools/lib/seed-rotation.mjs`](../tools/lib/seed-rotation.mjs)、[`tools/commands/feed.mjs`](../tools/commands/feed.mjs) 的 `run()`、[`client/index.js`](../client/index.js) 的 `BiliSeedsCard`。
> 时间：2026-11-08（0.8.11 只做标注，0.8.12 改为轮换）。

---

## 1. 结论

控制台「搜索种子 keywords」里保存的种子，**每轮只搜 2 个**，但**不是永远只搜保存顺序的前 2 个**：

- 旧版（≤ 0.8.11）：`keywords.slice(0, 2)`，第 3 个及以后永远不生效；
- 现在（≥ 0.8.12）：按本地日期算窗口偏移，n 个种子在 ⌈n/2⌉ 天内全部轮到，同一天里多轮用同一对。

---

## 2. 每轮实际会搜什么

`feed` 一轮的搜索词由三部分组成：

| 来源 | 数量 | 说明 |
| --- | --- | --- |
| `preferences.keywords` | 2 个（种子不足 2 个时取全部） | 按本地日轮换，见下节公式 |
| `preferences.like` | 每轮随机 2 个 | 口味话题，`sort(() => Math.random() - 0.5).slice(0, 2)` |
| `bilibili.fishCircle.enabled` | +1（`大肥鱼`） | 鱼圈社交打开时才加 |

三者用 `Set` 去重，所以一轮最多 5 次搜索请求（2 种子 + 2 口味 + 大肥鱼），常见 4 次。搜索出来的候选再和热门榜合并、按 `like` 命中打分、按 `sameVideoDays` 剔除最近发过的，最后取 `n` 条。

`feed --json` 的输出新增 `seeds` 字段，直接给出本轮用的种子；纯文本输出会先打一行「本轮种子（按本地日轮换）：…」。

---

## 3. 当初为什么只取 2 个

`feed.mjs` 的注释是原话：

> 固定 keywords + 每轮随机抽 1-2 个偏好词（like 池轮换）—— 内容源源不断，候选不枯竭

拆开看是三个约束：

1. **请求预算**：B站搜索接口要 WBI 签名，每轮多一个词就多一次请求，还容易被风控；固定 4 次左右是刻意的。
2. **候选不枯竭**：如果每轮把所有种子都搜一遍，同一批视频会在候选池里反复出现，`sameVideoDays` 一剔就没得选了；靠 `like` 随机轮换才能持续冒出新候选。
3. **种子是"起点"不是"清单"**：种子的语义是"从哪找"，不是"每天必须覆盖这些词"。

所以"每轮 2 个"是设计取舍；问题只在旧版**永远取前 2 个**，后面的种子成了摆设。

---

## 4. 现在的轮换规则

```js
// tools/lib/seed-rotation.mjs
export const SEEDS_PER_ROUND = 2

export function localDayIndex(date = new Date()) {
  const offsetMs = date.getTimezoneOffset() * 60_000
  return Math.floor((date.getTime() - offsetMs) / 86_400_000)   // 本地日历日序号
}

export function pickSeeds(seeds, dayIndex = localDayIndex()) {
  const list = [...new Set(seeds.map(s => String(s).trim()).filter(Boolean))]
  if (!list.length) return { picked: [], offset: 0, daysToCover: 0 }
  const per = Math.min(SEEDS_PER_ROUND, list.length)
  const offset = ((dayIndex % list.length) + list.length) % list.length * SEEDS_PER_ROUND % list.length
  const picked = Array.from({ length: per }, (_, i) => list[(offset + i) % list.length])
  return { picked, offset, daysToCover: Math.ceil(list.length / SEEDS_PER_ROUND) }
}
```

- **按天，不按轮次**：同一天里多次触发（`night.wakesPerDay` > 1）用同一对种子，晚上对账时「今天搜了什么」是确定的；第二天整体平移 2。
- **覆盖保证**：offset 每次加 2，模 n 的窗口在 ⌈n/2⌉ 天内并集覆盖全部种子（n 为奇数时最后一天会和第 1 个种子重叠，正好补齐）。
- **边界**：种子 0 个 → 只搜口味词；1 个 → 每天都搜它；2 个 → 每天都是这两个；重复词先去重，不会同一轮搜两遍同一个词。
- **没有新增配置**：每轮 2 个是写死的（`SEEDS_PER_ROUND`）。如果以后要让它可调，必须做成控制台上的可见项（不是藏在 JSON 里的隐藏开关）。

控制台「搜索种子 keywords」卡下方会直接显示：`按天轮换：今天搜 asmr、手工（共 4 个，2 天轮完）`；种子 ≤ 2 个时显示 `每轮都搜：…`。前端用同一套公式（`seedDayIndex` / `seedWindowToday`）算，注释里标了必须与 `tools/lib/seed-rotation.mjs` 保持一致。

---

## 5. 备选方案（没采用）

| 方案 | 行为 | 每轮请求 | 为什么没选 |
| --- | --- | --- | --- |
| 可配上限 `seedLimit` | 每轮搜 N 个，0 = 全部 | 随配置增长 | 要动 schema、控制台卡片、`config.d.mts`；而且 N 大了就是变相"全搜" |
| 全部搜 | 每轮把所有种子搜一遍 | n + 2 次 | 一轮变慢、风控风险上升、候选重复率上升，和 `sameVideoDays` 去重打架 |
| 维持现状 | 只搜前 2 个 | 4 次 | 后面的种子永远不生效，等于误导 |

轮换是唯一同时满足「后面的种子真的会被用」和「每轮请求数不变」的做法。

---

## 6. 怎么验证

- 命令行：`node tools/bili.mjs feed --json`，顶层 `seeds` 是本轮种子，每条候选的 `source` 是 `popular` / `search:<词>` / `fish:大肥鱼`。
- 控制台：B站页「搜索种子 keywords」卡片，已保存列表下面那行就是今天会搜的两个。
- 单测：`tests/seedRotation.test.mjs`（同一天同一对、n=1..9 在 ⌈n/2⌉ 天内覆盖、跨天窗口移动、空/重复种子、本地日序号）；`tests/consoleClient.test.ts` 的种子卡渲染用例。
- 日期边界：以**本地日历日**切，不是 UTC；`localDayIndex` 用 `getTimezoneOffset()` 换算，夏令时切换日按本地 0 点。

---

## 7. 相关文件

- `tools/lib/seed-rotation.mjs` / `seed-rotation.d.mts` — 轮换规则（唯一实现）
- `tools/commands/feed.mjs` — 取种子、拼搜索词、输出本轮种子
- `client/index.js` — `BiliSeedsCard`（显示今天搜哪两个）
- `tools/lib/config.mjs` — `preferences.keywords` 默认值
- `docs/CONFIG-EDIT-DESIGN.md` — 种子/同义词的编辑模型（追加保存、逐条删除）设计
