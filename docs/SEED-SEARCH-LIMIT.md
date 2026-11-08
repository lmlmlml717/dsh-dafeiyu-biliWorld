# 搜索种子只取前 2 个：现状、原因与后续方案

> 状态：**行为暂不改**（0.8.11 起只在控制台把"实际会搜的"标出来）。
> 相关代码：[`tools/commands/feed.mjs`](../tools/commands/feed.mjs) 的 `run()`、[`client/index.js`](../client/index.js) 的 `BiliSeedsCard`。
> 时间：2026-11-08。

---

## 1. 结论

控制台「搜索种子 keywords」里保存的种子，**只有前 2 个参与每轮选题搜索**；第 3 个及以后既不报错也不提示，等于存着不用。

```js
// tools/commands/feed.mjs:93
const kws = [...new Set([...(cfg.preferences?.keywords ?? []).slice(0, 2), ...randLikes])]
```

`git blame` 显示这行从初始提交 `6838310`（2026-11-06）就在，不是后来改坏的。

---

## 2. 每轮实际会搜什么

`feed` 一轮的搜索词由三部分组成：

| 来源 | 数量 | 说明 |
| --- | --- | --- |
| `preferences.keywords` | 最多 2 个 | 硬编码 `slice(0, 2)`，**按保存顺序取前两个** |
| `preferences.like` | 每轮随机 2 个 | 口味话题，轮换用，`sort(() => Math.random() - 0.5).slice(0, 2)` |
| `bilibili.fishCircle.enabled` | +1（`大肥鱼`） | 鱼圈社交打开时才加 |

三者用 `Set` 去重，所以一轮最多 5 次搜索请求（2 种子 + 2 口味 + 大肥鱼），常见 4 次。搜索出来的候选再和热门榜合并、按 `like` 命中打分、按 `sameVideoDays` 剔除最近发过的，最后取 `n` 条。

---

## 3. 当初为什么这么写

`feed.mjs:89` 的注释是原话：

> 固定 keywords + 每轮随机抽 1-2 个偏好词（like 池轮换）—— 内容源源不断，候选不枯竭

拆开看是三个约束：

1. **请求预算**：B站搜索接口要 WBI 签名，每轮多一个词就多一次请求，还容易被风控；固定 4 次左右是刻意的。
2. **候选不枯竭**：如果每轮把所有种子都搜一遍，同一批视频会在候选池里反复出现，`sameVideoDays` 一剔就没得选了；靠 `like` 随机轮换才能持续冒出新候选。
3. **种子是"起点"不是"清单"**：种子的语义是"从哪找"，不是"每天必须覆盖这些词"。

所以这是**设计取舍**，不是漏写循环。

---

## 4. 问题在哪

取舍本身没问题，问题是**不可见**：UI 只说"feed 每次拿前 2 个"，但用户存了 5 个种子时，界面不会指出哪 2 个在用、其余 3 个没生效，也没有任何日志能看出来。于是"我加了 5 个种子，为什么搜来搜去就那几个方向"变成了隐性困惑。

0.8.11 的处理：**逻辑不动**，`BiliSeedsCard` 在已保存列表下面多一行——

- 种子 ≤ 2：`每轮都搜：asmr、手工（共 2 个）`
- 种子 > 2：`每轮只搜前 2 个：asmr、手工；暂不参与：露营、开箱（共 4 个）`

同时把 `BiliSeedsCard` 导出到 `__test`，补了 4 条渲染用例（3 个/2 个/1 个/0 个）。

---

## 5. 后面这些种子怎么办（四选一）

| 方案 | 行为 | 每轮请求 | 代价 |
| --- | --- | --- | --- |
| **A 轮换（推荐，未实施）** | 每轮仍然只搜 2 个，但按日期/轮次偏移窗口，n 个种子在 ⌈n/2⌉ 天内全部轮到 | 4 次不变 | 约 15 行 + 2 条测试；需要定"按天"还是"按次"轮换 |
| B 可配上限 | 新增 `preferences.seedLimit`（默认 2，0 = 全部），UI 加数字框 | 随配置增长 | 改 schema、控制台卡片、`config.d.mts`，改动最大 |
| C 全用 | 直接去掉 `slice(0, 2)` | n + 2 次 | 一轮变慢、风控风险上升、候选重复率上升 |
| D 维持 | 种子库自己压到 2 个有效词，多样性交给 `like` 随机 | 4 次 | 0 改动；但种子多于 2 个就是误导 |

**推荐 A**：它同时满足"后面的种子真的会被用"和"每轮请求数不变"。按天偏移比按次偏移更可预期——同一天里多轮触发的搜索范围一致，第二天整体平移，不会出现一天内同一组种子被反复搜。

### A 的改法草案

```js
// tools/commands/feed.mjs，替换 slice(0, 2)
const seedPool = (cfg.preferences?.keywords ?? []).filter(Boolean)
const SEED_PER_ROUND = 2
const dayIndex = Math.floor((Date.now() + 8 * 3600_000) / 86400_000)  // 按本地日（+8h）平移
const offset = seedPool.length ? (dayIndex * SEED_PER_ROUND) % seedPool.length : 0
const pickedSeeds = Array.from({ length: Math.min(SEED_PER_ROUND, seedPool.length) },
  (_, i) => seedPool[(offset + i) % seedPool.length])
const kws = [...new Set([...pickedSeeds, ...randLikes])]
```

边界：

- `seedPool.length === 0`：行为与现在一致（只搜口味词）。
- `seedPool.length <= 2`：取全部，不产生重复。
- 与 `randLikes` 去重仍靠外层 `Set`；`大肥鱼` 照旧 push。
- 测试：同一 `Date.now()` 下取到的 2 个稳定；连续 n 天并集覆盖全部种子；种子 1 个/0 个不崩。

实施前建议先跟主人确认"按天轮换"是否可接受（会出现"今天没搜我关心的那个词"的观感）。

---

## 6. 怎么验证现在到底搜了什么

- 命令行：`node tools/bili.mjs feed --json`，每条候选的 `source` 是 `popular` / `search:<词>` / `fish:大肥鱼`，能直接看出这轮用了哪几个词。
- 控制台：B站页「搜索种子 keywords」卡片，已保存列表下面那行就是本轮会搜的种子（取前 2 个）。
- 日志：`feed` 的"已剔除 N 条 N 天内发过的"走 stderr，不进 JSON。

---

## 7. 相关文件

- `tools/commands/feed.mjs` — 种子取用与打分、去重
- `client/index.js` — `BiliSeedsCard`（UI 标注）、同义词卡与导入导出
- `tools/lib/config.mjs` — `preferences.keywords` 默认值
- `docs/CONFIG-EDIT-DESIGN.md` — 种子/同义词的编辑模型（追加保存、逐条删除）设计
