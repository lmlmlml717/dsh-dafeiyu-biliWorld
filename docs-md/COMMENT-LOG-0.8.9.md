# 评论记录页 + 转发时同时评论（0.8.9）

> 适用版本：`dsh-world-bili@0.8.9`（2026-11-08）
> 需求来源：控制台要能看到「真实发出去的评论」，并且删除时连 B 站上的那条评论一起删；转发视频时可以顺手把同一段配文发到评论区（对齐 PiliPlus 的「同时评论」）。
> 相关代码：`src/bili/commentLog.ts`（新）、`src/console/routes.ts`、`src/index.ts`、`client/index.js`、`tools/lib/bili-write.mjs`、`tools/commands/act.mjs`
> 相关测试：`tests/commentLog.test.ts`（新）、`tests/console.test.ts`、`tests/consoleClient.test.ts`

---

## 0. 结论

五条要求全部落地：

| 要求 | 结果 |
| --- | --- |
| 删除本地记录时，连 B 站上的评论一起删 | 先 `POST /x/v2/reply/action`（`action=del`），成功或确认已不存在后才删本地行；B 站失败则本地保留并报原因 |
| 干跑、被闸门拦下的不进列表 | 只有真正发出 `reply/add` 的尝试才写 `bili-comments.jsonl`（成功 ✅ / 失败 ❌ 都写） |
| 新增 tab | 世界控制台新增「评论记录」，与「评论」并列 |
| 评论设置留在旧 tab | 旧「评论」页的设置卡原样保留 |
| 旧 tab 底部的「最近 5 条」去掉 | 已移除；列表统一到新页 |

验证：`tsc --noEmit` 0 error；全量 586 条测试 586 通过；打包 243 个文件、486.4 KB，装包冒烟通过。
**还没做**：没有拿真实账号执行「发评论 / 删评论」（只用假 fetch 验了协议和失败分支）；运行中的 DSH 仍是旧宿主进程，需要重启才会加载新 `lib/`、出现新 tab。

---

## 1. 数据结构：`bili-comments.jsonl` v2

位置：`<DSH_HOME>/worlds/<worldId>/bili/bili-comments.jsonl`，一行一条 JSON。

```json
{"v":2,"id":"8f0c…","kind":"share-comment","at":"2026-11-08T12:00:00.000Z","ok":true,"bvid":"BV1xx411c7mD","aid":123456,"title":"视频标题","rpid":"233333","text":"正文全文（≤1000 字）","code":0,"why":"0"}
```

| 字段 | 说明 |
| --- | --- |
| `v` | 2；旧行没有 |
| `id` | 删除时定位用；新记录是 UUID |
| `kind` | `comment`＝只评论；`share-comment`＝转发动态时同时评论 |
| `at` | ISO 时间；列表按它倒序、按天过滤 |
| `ok` | 这次 `reply/add` 是否成功 |
| `bvid` / `aid` / `title` | 视频信息；`aid` 是删 B 站评论的 `oid` |
| `rpid` | B 站返回的评论 id；失败时通常为空 |
| `text` | 正文，截 1000（旧版只存 200） |
| `code` / `why` | B 站返回码 / 原因 |

兼容旧行：没有 `id` 的用整行内容的 SHA-1 前 16 位补 `legacy-…`（每读一次都稳定，删除能定位）；没有 `kind` 的按 `comment`；没有 `v` 不影响读取。
容量：每次追加后检查，超过 2000 行就整体重写保留最后 2000 行；失败不影响本次记录。

### 哪些尝试会进列表

- ✅ 真发成功（`ok:true`，带 `rpid`）。
- ✅ 真发但 B 站拒绝（`ok:false`，带 `code/why`）；这是真实发生过的尝试，需要让她/你知道。
- ❌ 干跑（`go=false`）：在写记录之前就 return。
- ❌ 被闸门拦下：评论开关关、`dailyBili.allowWrite` 未开、`guard.dryRun`、最小间隔未到、日额度用完、风控闸门 —— 都在 `formPost` 之前 return，不写记录。
- ❌ 转发动态本身失败：不会走到同时评论。

> 因此「转发成功、但评论被闸门拦下」时，动态已发出、列表里没有这次评论；面板顶部开关卡下面有一行说明，CLI 输出也会写「评论未发：…」。

---

## 2. 删除流程（本地 + B 站）

入口：`POST /dsh-world/console/bili-comments/delete`，body `{ "id": "…" }`，必须带 `x-dsh-world: 1`。
实现：`deleteCommentLogEntry(worldDir, id)`。

1. 逐行解析，按 `id` 找到目标（旧行用 `legacy-…` 哈希 id）。
2. 记录没有 `rpid`：只删本地，返回「这条记录没有 rpid，只删了本地记录」。
3. 记录有 `rpid`：
   - 读 `<world>/bili/credentials.json`（`SESSDATA` / `bili_jct` / `buvid3`）；读不到就拒绝，本地保留。
   - `aid` 优先用记录里的；没有就用 `bvid` 调 `x/web-interface/view` 现查。查不到 → **拒绝删除，本地保留**（不假装删过）。
   - `POST https://api.bilibili.com/x/v2/reply/action`，form：`type=1`、`oid=<aid>`、`rpid=<rpid>`、`action=del`、`csrf=<bili_jct>`（同时带 `csrf_token`）。
   - `code=0`，或 `12002` / `-404` / 返回文案含「不存在 / 已删除」→ 视为 B 站侧已删；其它 code 或网络异常 → 拒绝，本地保留并回报原因。
4. 本地重写前再读一次文件，按 id 重新定位（避免覆盖期间新追加的记录），写临时文件再 `rename` 原子替换；删完不留备份。
5. 返回：B 站失败/查不到 → `400 { error: "…（本地记录保留）" }`；成功 → `200 {}`。

| 情况 | B 站评论 | 本地记录 | 面板 |
| --- | --- | --- | --- |
| 正常 | 删除 | 删除 | 已删除（本地 + B 站） |
| B 站 code 非 0（如 12015 风控） | 保留 | 保留 | 红色失败原因 |
| 网络异常 | 未知 | 保留 | 红色失败原因 |
| 没有 `rpid`（没发成功/旧记录） | — | 删除 | 已删除本地记录（这条没有 B 站评论） |
| 有 `rpid` 但查不到 `aid` | 无法删 | 保留 | 红色原因，可重试 |
| 读不到凭据 | 无法删 | 保留 | 红色原因 |
| id 不存在 | — | 不变 | 「记录不存在（可能已经被删掉）」 |

> 删除不做「批量」、不可恢复；删掉 `share-comment` 记录**不会**删对应的动态（B 站没有公开的撤销动态接口）。

---

## 3. 控制台「评论记录」页

- tab 顺序：概览 / 人设 / 世界提示词 / 记录 / 档案 / 相册 / QQ / 微信 / B站 / 评论 / **评论记录** / 配置。
- 顶部卡「转发时同时评论」：checkbox 直接写 `bili.config.json` 的 `bilibili.dynamic.alsoComment`；CLI 每次新进程读配置，所以保存后下一条命令就生效，不需要重启。
  - 文案明确：真发仍要评论开关 + `dailyBili.allowWrite` + 关干跑同时成立；任一没开只发动态。
- 时间范围：3 / 7 / 14 / 30 / 90 天（默认 7），另有「刷新」；GET `bili-comments?days=N&limit=200`。
- 每条一张卡：
  - 标题：✅/❌ + `转发+评论` / `只评论` + 本地时间；
  - 正文在最上面（`pre-wrap`，长文换行）；
  - 失败时正文下方一行红字（`why` 或 `code`）；
  - 最底层：BV 号（新窗口打开 B 站）→ 视频标题 → 「删除」按钮。
- 删除确认：第一下变「确认删除？」，3 秒内第二下才发请求；超时自动复位。删除中/成功/失败都有状态行。
- 旧「评论」页：只剩状态、总开关、`allowWrite`、每日条数、跳过概率；「最近 5 条」整卡移除。

> 后端 `readBiliComment()` 仍会返回 `recent`（最后 5 行）以兼容旧页面/旧客户端，但 0.8.9 的 UI 不再展示它。真正的新列表走 `readBiliCommentLog()`。

---

## 4. 转发时同时评论

### CLI

```bash
# 只看会发什么（干跑）：会多打印「同时评论：是/否」
node tools/bili.mjs act dyn --bvid BV1xx411c7mD --text "配文" --score 17

# 真发，并同时评论（覆盖配置）
node tools/bili.mjs act dyn --bvid BV1xx411c7mD --text "配文" --score 17 --go --also-comment

# 真发，只转发不评论（覆盖配置）
node tools/bili.mjs act dyn --bvid BV1xx411c7mD --text "配文" --score 17 --go --no-comment
```

- `--also-comment` / `--no-comment` 都不写时读 `bili.config.json`：`bilibili.dynamic.alsoComment`，默认 `false`。
- 流程：`create/dyn` 成功 → `postReply(bvid, text, { go:true, kind:'share-comment', info })`；`info` 复用刚查过的视频信息，不重复请求 view。
- 复用 `postReply` 的全部闸门（评论开关 / allowWrite / dryRun / 最小间隔 / 日额度 / 风控）；评论失败**不回滚动态**，输出里写原因，动态照常记账。
- 评论成功才记 `comment` 额度与 `sent-at`；记录 kind 为 `share-comment`。
- 纯文字动态（不带 `--bvid`）不受影响，也不会触发同时评论。

### 配置

```json
{
  "bilibili": {
    "dynamic": { "enabled": true, "alsoComment": true }
  }
}
```

`bilibili.share.addComment` 仍是旧占位键（`tools/lib/config.mjs` 里默认 `false`），0.8.9 **没有**使用它；面板和 CLI 的实际开关是 `bilibili.dynamic.alsoComment`。

---

## 5. 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/bili/commentLog.ts` | 新增：读 v2/旧记录、按天过滤、legacy id、B 站删除、原子重写 |
| `src/console/routes.ts` | `GET /console/bili-comments`、`POST /console/bili-comments/delete`；类型补两个 action |
| `src/index.ts` | 注入 `readBiliCommentLog` / `deleteBiliComment`，删后失效快照缓存 |
| `client/index.js` | 新 `BiliCommentLog` 组件、TABS 加 `comment-log`、旧页移除「最近 5 条」、`__test` 暴露组件 |
| `tools/lib/bili-write.mjs` | 记录 v2（id/kind/aid/1000 字/2000 行上限）；`postReply` 支持 kind/info；`shareVideoDynamic` 支持 alsoComment 与失败不回滚 |
| `tools/commands/act.mjs` | `act dyn` 解析 `--also-comment` / `--no-comment`，输出评论结果 |
| `src/ecosystem/qq-native/snowluma.ts` | 低层 `ws` 常驻 `error` 监听器：SDK 关闭时不再把「连接未建立就被关」抛成 uncaughtException |
| `tests/commentLog.test.ts` | 新增 6 条 |
| `tests/console.test.ts` | 新路由：读参数、空 id、后端拒绝、trim |
| `tests/consoleClient.test.ts` | 新页渲染：开关文案、异步读取态 |

---

## 6. 验证

### 6.1 类型

```
npm run typecheck   # tsc --noEmit → 0 error
```

### 6.2 测试

| 范围 | 结果 |
| --- | --- |
| `tests/commentLog.test.ts` | 6/6 |
| `tests/consoleClient.test.ts` | 11/11（含新页用例） |
| `tests/console.test.ts` 等受影响三个文件 | 45/45 |
| 全量 `node --experimental-strip-types --test` | **586/586 通过** |
| `tests/plugin.test.ts` 单跑 | 38/38 |

全量第一次跑曾出现 `tests/plugin.test.ts` 文件级失败：`tests/hostFixture.ts` 的 `after` 钩子报 `WebSocket was closed before the connection was established`。定位到 QQ 客户端：`bot.close()` 时 SDK 会摘掉自己挂在 socket 上的监听器，若此刻正好有个「连接还没建立」的 socket 被关闭，`ws` 的 `error` 就变成 uncaughtException（生产环境同样可能带崩宿主）。已在 `snowluma.ts` 给低层 `ws` 从构造起挂常驻 `error` 监听器兜底；之后 `plugin.test.ts` 连跑 3 次 38/38，全量 586/586 干净通过。

新测试覆盖的关键点：

- 读取：倒序、天数过滤、`limit`、`days=0` 不限、legacy id 稳定、`kind` 默认、截断；
- 删除：没有 `rpid` 只删本地；有 `rpid` 时请求带 `type/oid/rpid/action=del/csrf` 与 cookie；B 站失败/网络异常保留本地；有 `rpid` 查不到 `aid` 保留本地；未知 id 不重写文件；
- 路由：`days/limit` 透传、空 id 400、后端拒绝 400、id trim；
- 渲染：新页顶部有「转发时同时评论」、初始「读取中…」。

### 6.3 构建与打包

```
npm run build   # 清空 lib/ 后 tsc -p tsconfig.build.json
npm pack        # prepack 会再跑 typecheck + build
```

- 产物：`<repo>/dsh-world-bili-0.8.9.tgz`
- 大小：486.4 KB（unpacked 1.5 MB），**243 个文件**
- SHA-256：`766D1F1CB83F6219E5FB22B8A8E3EC34CDBC3E71EB6435B58B0665C28D8B56A3`
- 包内确认：`package/lib/bili/commentLog.js`、`package/client/index.js`、`package/tools/lib/bili-write.mjs`、`package/tools/commands/act.mjs`
- `npm run test:package`：在 `.host/` 临时 consumer 里装 tgz、不装 QQ SDK、导入包名、再装 `@snowluma/sdk` 跑 smoke，输出
  `Packed plugin entry, externally installed SDK and local QQ connection passed without install scripts.`

### 6.4 没有做的验证

- **没有对真实 B 站账号发评论或删评论**。协议、参数、失败分支都是 fake fetch 单测；真实删除会受登录态、风控（如 12015）、评论是否已删影响，第一次真删请在面板上盯着结果。
- **没有重启正在运行的 DSH**。本会话就跑在 DSH 里，重启会中断；宿主加载的是旧 `lib/`，所以现在打开控制台还看不到新 tab。
- 没有对运行中的宿主直接 curl 新接口（同理，旧进程没有这两条路由）。

---

## 7. 让新页生效

当前 profile 是用 `link:` 指向仓库目录的（`node_modules/dsh-world-bili` → 仓库），`lib/` 已在 0.8.9 重建，因此：

1. 重启 DSH（退出桌面端/宿主进程再开；只刷新浏览器不够，宿主代码在 `lib/`）。
2. 打开 设置 → 世界控制台，应看到「评论」右边多出「评论记录」。
3. 顶部开关打开后，下一条 `act dyn --bvid … --go` 会读 `bilibili.dynamic.alsoComment`；也可以临时用 `--also-comment` 覆盖。
4. 想手工确认接口（重启后）：

```
GET  http://127.0.0.1:<端口>/dsh-world/console/bili-comments?days=7&limit=50
POST http://127.0.0.1:<端口>/dsh-world/console/bili-comments/delete
     headers: content-type: application/json, x-dsh-world: 1
     body: {"id":"…"}
```

如果是用 tgz 装的（不是 link），把 `dsh-world-bili-0.8.9.tgz` 重新 `npm install` 到 profile，确认 `dsh.profile.bundles` 里有 `dsh-world-bili`，再重启。**不要**把 `link:` 指向带 `@deepseek-ai` 依赖的源码目录再分发，否则对方会报 `1 required plugin did not activate`（见 `DISTRIBUTION.md`）。

### 生效后的验收

- [ ] 控制台出现「评论记录」，旧「评论」页没有「最近 5 条」。
- [ ] 开关打开 → `bili.config.json` 里出现 `bilibili.dynamic.alsoComment: true`；关闭后变 `false`。
- [ ] 干跑一条 `act dyn --bvid … --also-comment`，输出含「同时评论：是」，列表**不**增加。
- [ ] 真发一条（`--go`）且评论成功：列表出现「转发+评论 ✅」，卡片正文在上、BV 在最底层。
- [ ] 删除它：第一下变「确认删除？」，3 秒内第二下；B 站评论消失，本地卡片消失。
- [ ] 故意让 B 站删除失败（例如断网）：面板红字报原因，本地卡片仍在。

---

## 8. 已知边界

- 只能看到/删除**本插件发出**的评论；别人发的、B 站 App 里手发的都不在 jsonl 里。
- 旧记录没有 `rpid` 时只能删本地；有 `rpid` 但视频已删/查不到 `aid` 时拒绝删除（本地保留）。
- 删除 `share-comment` 不会撤销动态；删除不可恢复、无批量。
- 干跑与被闸门拦下的尝试不记录，所以列表不是「所有尝试」，只是「所有真正发出过的尝试」。
- `readCommentLog` 的 `days` 过滤对缺 `at` 的旧行不生效（会保留显示）；`limit` 上限 500。
- 同时评论受评论侧全部闸门约束：评论开关、`dailyBili.allowWrite`、`guard.dryRun`、最小间隔、日额度、风控；任一不过就只发动态。
- 面板删除是串行请求；删除期间新追加的记录不会被覆盖（重写前会重读并按 id 定位）。

## 9. 回滚

- 只关功能：面板关「转发时同时评论」，或 `bilibili.dynamic.alsoComment: false`；不删数据。
- 回退版本：重装 0.8.8 的 tgz 并重启。`bili-comments.jsonl` 的 v2 行对旧代码是普通 JSON，旧「最近 5 条」仍能读（多出的字段被忽略），不需要迁移。
- 新 tab 与两条路由随版本一起消失；已删的评论无法恢复。
