# dsh-world-bili 配置与开关总览

> 版本 **0.8.9** · 更新于 2026-11-08
>
> `<DSH_HOME>` 默认是 `C:\Users\<你>\.dsh`（也可由环境变量 `DSH_HOME` 指定）。
> `<worldId>` 默认是 `default`（主配置的 `worldId`）。

---

## 0. 一共有几份配置

| 文件 | 位置 | 管什么 | 谁在写 |
|---|---|---|---|
| **主配置** | `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` 里 `- id: dsh-world-bili` 的 `config:` | 世界、定时器、评论功能、真发总开关、评论硬上限/最小间隔、QQ/微信、时区 | DSH 设置页（插件配置表单）、评论页开关、手改 |
| **工具链配置** | `<DSH_HOME>/worlds/<worldId>/bili.config.json` | 干跑、风控、额度、口味、节奏、评论的日上限与跳过概率 | 控制台 B站页 / 评论页、手改；部分键由宿主启动时镜像 |
| **世界运行态** | `<DSH_HOME>/worlds/<worldId>/world.json` | 是否运行、每日预算、记忆、归档范围、模块开关、作息 | 控制台按钮、手改 |
| **凭据** | `<DSH_HOME>/worlds/<worldId>/bili/credentials.json` | `SESSDATA` / `bili_jct` / `buvid3` | B站页「Cookie」卡、手改 |

一句话：**主配置说“世界允许不允许”，`bili.config.json` 说“工具链怎么做”，`world.json` 说“控制台按钮点过什么”。**

---

## 1. 四个开关：参数、文件、是否在主配置

| UI 里叫什么 | 参数（完整路径） | 在哪个文件 | 是否在主配置 | 默认 | 值含义 |
|---|---|---|---|---|---|
| **真发模式**（旧称「干跑模式」） | `guard.dryRun` | `bili.config.json` | ❌ 不在 | `true` | `true` = 干跑（写操作只打印不真发）；`false` = 允许真发。UI 勾上 = `false`（真发） |
| **风控闸门 guard** | `guard.dryRun`、`guard.minGapSec`、`guard.dupThreshold`、`guard.banned` | `bili.config.json` | ❌ 不在 | 见 §4.1 | 不是开关，是一组“发送前检查”：干跑 / 最小间隔 / 复读阈值 / 黑名单词 |
| **B站真发总开关** | 主配置 `dailyBili.allowWrite` → 镜像为 `comment.allowWrite` | 主配置 + `bili.config.json`（镜像） | ✅ 在 | `false` | `true` = 允许评论真发；关闭时评论 `--go` 也被拒绝 |
| **评论功能** | 主配置 `comment.enabled` → 镜像为 `comment.enabled` | 主配置 + `bili.config.json`（镜像） | ✅ 在 | `false` | `true` = 评论命令可执行（含干跑预览）；`false` 直接拒绝 |
| 评论 · 硬上限 | 主配置 `comment.hardDailyMax` | 主配置 | ✅ 在 | `5` | 面板里能设的每日条数不能超过它；`0` = 不限 |
| 评论 · 最小间隔 | 主配置 `comment.minIntervalSec` | 主配置 | ✅ 在 | `3600` | 两条**真发**评论之间的最少秒数；`0` = 不限 |
| 评论 · 每日条数 | `comment.dailyMax` | `bili.config.json` | ❌ 不在 | `0`（不限） | 面板可改，保存时被 `hardDailyMax` 钳制 |
| 评论 · 跳过概率 | `comment.skipChance` | `bili.config.json` | ❌ 不在 | `0.3` | 0–1；每次 `--go` 前抽签，命中就“今天不动手”（`--force` 跳过抽签） |

### 1.1 直接回答你的问题

- **干跑模式 = `guard.dryRun`**（UI 现在叫「真发模式」，勾上才真发），不在主配置，在 `bili.config.json`。**`true` 才是干跑**（只打印），`false` 才允许真发。
- **风控闸门 `guard` 不是“为真才放行”的开关**，它是 `bili.config.json` 的 `guard` 段；其中 `dryRun` 是反向的（`true` = 刹车），`minGapSec`、`dupThreshold`、`banned` 是限制项。
- **B站真发总开关 = 主配置 `dailyBili.allowWrite`**，**在主配置里**；宿主启动时镜像成 `bili.config.json` 的 `comment.allowWrite`，评论发送前由代码硬校验。
- **评论功能 = 主配置 `comment.enabled`**，**在主配置里**；同样镜像进 `bili.config.json`，`postReply` 第一步校验。

### 1.2 极性（最容易踩的坑）

| 控件 | 勾选 = |
|---|---|
| B站页顶部「真发模式」 | 勾上 = 真发（`dryRun: false`）；不勾 = 干跑 |
| 评论页「B站真发总开关」 | 勾上 = 允许真发（`allowWrite: true`） |
| 评论页「评论功能」 | 勾上 = 评论可执行（`enabled: true`） |
| 评论页「每日上限」「跳过概率」 | 数值，直接写 `bili.config.json` |

> 0.8.7 起全页只有顶部「真发模式」一个 `dryRun` 开关；「风控闸门 guard」卡只说明、不再放第二个复选框（见 §11.1）。

---

## 2. 关系：一条评论要过几道闸

以下是 `tools/lib/bili-write.mjs` 里 `postReply` 的**真实判定顺序**：

```
1. comment.enabled === true            ← 主配置（镜像文件）
2. 文本清洗后非空
3. 没带 --go → 只打印【干跑】预览，结束
4. guard.dryRun === false             ← bili.config.json
5. comment.allowWrite === true         ← 镜像自主配置 dailyBili.allowWrite
6. 距上一条成功评论 ≥ comment.minIntervalSec
7. 今日评论数 < commentCap(dailyMax, hardDailyMax)
8. guard.allow：minGapSec 间隔 + 3-gram 复读检测
9. 请求 B 站 → 成功才记账（bili-actions.json / bili-comments.jsonl / sent-at.json）
```

两个细节：

- **不带 `--go`** 时只到第 3 步就返回预览，不联网、不占额度，但**仍然要求 `comment.enabled = true`**；
- `--force` 只跳过 `comment.mjs` 里的“跳过概率”抽签，**上面任何一道闸都不免**。

### 2.1 干跑 vs 真发总开关，谁管谁

| | `guard.dryRun` | `dailyBili.allowWrite` |
|---|---|---|
| 层级 | 工具链代码闸（每次命令现读文件） | 世界级意图开关（主配置） |
| 作用范围 | 所有写操作（动态、转发、评论…） | 评论已硬校验；动态/转发只体现在 prompt 提示 |
| 方向 | `true` = 拦截真发 | `true` = 允许真发 |
| 谁能改 | B站页 / 手改 `bili.config.json` | 评论页开关 / DSH 设置页 / 手改主配置 |

也就是说：**动态链目前只被 `guard.dryRun` 硬拦；评论链被 `enabled → allowWrite → dryRun` 三道都拦。**

### 2.2 自动链路谁让它跑

- 世界在运行（`world.json` 的 `running: true`，控制台「开始」）；
- 主配置 `dailyBili.enabled: true` → 才会创建每日定时器，按 `dailyTime` + `night.wakesPerDay` 随机唤醒；
- 各功能自己的开关：`bilibili.dynamic.enabled`（动态/转发）、`comment.enabled`（评论）。

> `dailyBili.enabled` 只决定“自动定时器存不存在”；手动执行 `bili.mjs` 命令不受它控制。

---

## 3. 主配置全参数（`cordis.patch.yml` → `dsh-world-bili.config`）

改法：DSH 设置 → 插件配置 → `dsh-world-bili`（表单），或直接改 `cordis.patch.yml`（改完重启 DSH）。
标「重启」的字段在插件启动时读取。

### 3.1 基础 / 世界

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `worldId` | string | `default` | 世界目录名：`<DSH_HOME>/worlds/<worldId>/` |
| `agentPreset` | string | `standard` | 用哪个 agent 预设跑她的会话 |
| `timeZone` | string | 系统时区 | IANA 时区，如 `Asia/Shanghai`；作息/日记按它算 |
| `companionName` | string | 必填 | 她的名字（人设里有名字时以人设为准） |
| `partnerName` | string | 必填 | 她对你的称呼 |
| `archiveScope` | `home` / `workspace` | `workspace` | 记忆归档范围；改完重启生效 |
| `replaceCompaction` | boolean | `true` | 安装时是否用本插件替换宿主默认压缩 |
| `life` | boolean | `true` | 是否启用生活线（闹钟/回顾/生活记录） |
| `fallbackWakeTime` | `HH:MM` | `09:00` | 兜底起床时间（`world.json` 的 `wakeTime` 优先） |
| `diaryDir` | string | `<world>/diary` | 日记目录 |
| `selfFile` | string | `<world>/room/我是谁.md` | “我是谁”文件 |
| `personaFile` | string | `<world>/persona.md` | 人设文件 |
| `worldPromptFile` | string | `<world>/world-prompt.md` | 世界提示词文件 |
| `alarmTemplateFile` | string | `<world>/alarm.md` | 闹钟模板 |
| `toast` | boolean | `true` | 系统通知开关 |
| `toastAppId` | string | 自动查找 | 通知用的 AppUserModelID |
| `allowedHosts` | string[] | `[]` | 允许访问控制台/桥的额外主机名（LAN/反代） |

### 3.2 对外通道

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `outlets` | array | `[]` | 把她的回复/忙碌/触达推给外部程序；每项 `{name,url,urlFile,path,kinds[]}` |
| `bridge` | boolean | `false` | 允许本机程序通过 `POST /dsh-world/bridge/say` 把话递给她 |
| `wechat` | boolean | `false` | 启用微信模块 |
| `wechatAdapter` | `{python,config}` | 无 | 随微信模块启停 Windows 适配器；**写上即视为允许它发消息** |

### 3.3 QQ（`qqNative`）

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `qqNative.enabled` | boolean | `false` | 启用原生 QQ 通道 |
| `qqNative.wsUrl` | string | `ws://127.0.0.1:3003` | SnowLuma/OneBot 的 WS 地址 |
| `qqNative.accessToken` | string | `''` | WS 鉴权 token |
| `qqNative.allowPrivate` | string[] | `[]` | 允许私聊的 QQ 号 |
| `qqNative.ownerQQ` | string | `''` | 她主动发消息的对象；空则取 `allowPrivate[0]` |
| `qqNative.allowGroups` | string[] | `[]` | 允许接的群号 |
| `qqNative.autoReply` | boolean | `true` | 是否自动回 |
| `qqNative.contextMessages` | number | `6` | 每次带几条上下文 |
| `qqNative.batchQuietMs` | number | `10000` | 同一会话攒消息的静默毫秒（0 = 一条一问） |
| `qqNative.groupTrigger` | `mention` / `all` | `mention` | 群里只接被叫到的 / 每句都接 |
| `qqNative.groupKeywords` | string[] | `[]` | 群里命中即算“被叫到”的关键词 |
| `qqNative.mutedUntil` | ISO 时间 | `''` | 之前只收不回 |
| `qqNative.snowlumaHome` | string | `''` | SnowLuma 安装目录；空则按常见路径探测 |
| `qqNative.supervise` | boolean | `true` | 看门狗：每 30s 探端口，不通就拉起 SnowLuma |
| `qqNative.bindHomeSession` | `owner` / `all` / `none` / `''` | `owner` | 谁和她的家会话共用一个入口 |
| `qqNative.bridge` | `{port,token,title,contextMessages}` | `{0,'','阳台',6}` | “阳台”通道：给本机其它程序留的线 |

### 3.4 每日 B 站（`dailyBili`）

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `dailyBili.enabled` | boolean | `false` | 每日定时器总开关；**显式 true 才开** |
| `dailyBili.dailyTime` | `HH:MM` | `20:00` | 兜底定时点（随机窗口用完/跳过时用） |
| `dailyBili.dailyMaxVideos` | number | `10` | 每日转发视频硬上限（跨触发累加，0 = 不限） |
| `dailyBili.napcatHttp` | string | `http://127.0.0.1:3000` | 通知主人的 OneBot HTTP 地址 |
| `dailyBili.ownerQQ` | string | `''` | 通知发给谁；空则取 `qqNative.allowPrivate[0]` |
| `dailyBili.allowWrite` | boolean | `false` | **真发总开关**；镜像为 `comment.allowWrite`，评论硬校验；动态只影响 prompt |

### 3.5 评论（`comment`）

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `comment.enabled` | boolean | `false` | 评论功能开关（镜像进 `bili.config.json`，`postReply` 第一步校验） |
| `comment.hardDailyMax` | number | `5` | 每日硬上限，面板 `dailyMax` 不能超过它；`0` = 不限 |
| `comment.minIntervalSec` | number | `3600` | 两条真发评论的最小间隔秒数；`0` = 不限 |

---

## 4. `bili.config.json` 全参数

位置：`<DSH_HOME>/worlds/<worldId>/bili.config.json`。**每次命令现读，改完立即生效**（CLI 不用重启）。
「面板」列表示控制台里有没有对应控件。

### 4.1 `guard` 风控闸门

| 参数 | 类型 | 默认 | 说明 | 面板 |
|---|---|---|---|---|
| `guard.dryRun` | boolean | `true` | **`true` = 干跑**（只打印不真发）；UI 勾「真发模式」= 写 `false` | B站页顶部「真发模式」 |
| `guard.minGapSec` | number | `25` | 同一 chatId 两条对外消息的最小间隔（秒） | 否 |
| `guard.dupThreshold` | number | `0.6` | 3-gram 相似度超过即判复读 | 否 |
| `guard.banned` | string[] | `["作为AI","语言模型","无法协助","作为一个"]` | 清洗时删掉的词 | 否 |

### 4.2 `night` 作息

| 参数 | 类型 | 默认 | 说明 | 面板 |
|---|---|---|---|---|
| `night.skipChance` | number | `0.3` | 0–1，今天“不想刷”的概率 | B站页「作息」卡 |
| `night.wakesPerDay` | number | `1` | 一天最多触发次数（夹 1–12） | 心情·定时器页 |
| `night.minGapMin` | number | `10` | 两次触发最小间隔分钟（夹 1–240） | 心情·定时器页 |
| `night.maxVideos` | number | `5` | 每轮建议挑几条（软建议） | B站页「作息」卡 |

### 4.3 `preferences` 口味

| 参数 | 类型 | 默认 | 说明 | 面板 |
|---|---|---|---|---|
| `preferences.like` | string[] | 见源码 | feed 选题偏好的话题 | B站页「口味」卡 |
| `preferences.dislike` | string[] | `["带货","擦边","标题党","纯搬运"]` | 不喜欢的话题 | B站页「口味」卡 |
| `preferences.keywords` | string[] | `[]` | 额外搜索词 | 否 |
| `preferences.synonyms` | object | `{}` | 话题同义词 | 否 |

### 4.4 `share` / `quota` 分享与额度

| 参数 | 类型 | 默认 | 说明 | 面板 |
|---|---|---|---|---|
| `share.enabled` | boolean | `true` | 是否分享（预留） | 否 |
| `share.via` | string | `'dynamic'` | 分享方式（预留） | 否 |
| `share.minScore` | number | `13` | debrief 评分 ≥ 才值得转发（0 = 全转） | B站页「观看·转发」卡 |
| `quota.shareDaily` | number | `3` | 每日转发上限；`bilibili.dynamic.shareDailyMax` 没配时回落到它 | 否 |
| `quota.sameVideoDays` | number | `7` | 同一视频多少天内只转发一次 | 否 |

### 4.5 `comment` 评论（工具链侧）

| 参数 | 类型 | 默认 | 说明 | 面板 |
|---|---|---|---|---|
| `comment.enabled` | boolean | `false` | **镜像自主配置**，不要手改这里当准 | 评论页开关（写主配置） |
| `comment.allowWrite` | boolean | `false` | **镜像自主配置 `dailyBili.allowWrite`**；`postReply` 硬校验 | 评论页「B站真发总开关」（写主配置） |
| `comment.hardDailyMax` | number | `5` | **镜像自主配置** | 评论页只读显示 |
| `comment.minIntervalSec` | number | `3600` | **镜像自主配置**；发送前按 `sent-at.json` 硬校验 | 否 |
| `comment.dailyMax` | number | `0` | 面板可改的每日条数；保存时钳到硬上限 | 评论页「每日上限」 |
| `comment.skipChance` | number | `0.3` | 0–1，抽签跳到下一轮的概率 | 评论页「跳过概率」 |

### 4.6 `ledger` 账本

| 参数 | 类型 | 默认 | 说明 | 面板 |
|---|---|---|---|---|
| `ledger.enabled` | boolean | `true` | 记账开关 | 否 |
| `ledger.dailyBudget` | number | `3` | 每天饭钱（元），0 = 不设预算 | 否 |
| `ledger.mineWorkspace` | string | `bili-work` | 哪个工作区的消耗算“她自己吃的” | 否 |
| `ledger.price` | `{inputPerM,cachePerM,outputPerM}` | `{2,0.2,3}` | 计价（元/百万 token） | 否 |
| `ledger.balanceUrl` | string | `''` | 余额查询地址（DeepSeek balance API） | 否 |
| `ledger.apiKey` | string | `''` | 余额查询用的 key | 否 |
| `ledger.balanceTimeoutMs` | number | `8000` | 余额查询超时 | 否 |
| `ledger.promptInQQ` | boolean | `true` | 是否在 QQ 里提示账本 | 否 |

### 4.7 `bilibili` 行为

| 参数 | 类型 | 默认 | 说明 | 面板 |
|---|---|---|---|---|
| `bilibili.reportHistory` | boolean | `true` | 观看历史上报 | B站页「其他」卡 |
| `bilibili.watch.autoFromWindow` | boolean | `true` | 每次触发刷几条按窗口长度自动算 | B站页「观看·转发」卡 |
| `bilibili.watch.sessionMin` | number\|null | `null` | 手动模式最少刷几条 | 同上 |
| `bilibili.watch.sessionMax` | number\|null | `null` | 手动模式最多刷几条 | 同上 |
| `bilibili.dynamic.enabled` | boolean | `false` | 动态总开关（纯文字 + 转发都受它影响） | B站页「纯文字动态」卡 |
| `bilibili.dynamic.alsoComment` | boolean | `false` | 转发视频时把同一段配文也发到视频评论区；评论失败不回滚动态（0.8.9） | 评论记录页顶部开关 |
| `bilibili.dynamic.pureDailyMax` | number | `2` | 纯文字动态每日上限（0 = 不限） | 同上 |
| `bilibili.dynamic.shareDailyMax` | number | `0` | 转发视频每日上限（0 = 回落到 `quota.shareDaily`） | B站页「观看·转发」卡 |
| `bilibili.dynamic.pureSessionMin` | number | `0` | 每次触发最少发几条纯动态 | 「纯文字动态」卡 |
| `bilibili.dynamic.pureSessionMax` | number | `1` | 每次触发最多发几条纯动态 | 同上 |
| `bilibili.share.minScore` | number | `13` | 同 `share.minScore`（面板写这里） | 「观看·转发」卡 |
| `bilibili.share.shareMode` | `auto` / `forwardOnly` | `auto` | 转发时要不要 agent 配文 | 同上 |
| `bilibili.share.addComment` | boolean | `false` | 预留（未实现；同时评论请用 `bilibili.dynamic.alsoComment`） | 否 |
| `bilibili.ownMid` | string | `''` | 自己的 UID（列表去重/归属） | 否 |
| `bilibili.ownBvids` | string[] | `[]` | 自己的投稿 BV（去重） | 否 |

### 4.8 预留 section（写了也不生效）

`danmaku`、`react`、`imageComment`、`replies`、`fishCircle`、`follow`、`freeRoam`、`identity`、`owner`——代码和 UI 里都还留着注释，启用前不要指望它们起作用。

---

## 5. `world.json` 全参数

位置：`<DSH_HOME>/worlds/<worldId>/world.json`。多数由控制台按钮写入；手改后需重启 DSH（进程内缓存）。

| 参数 | 类型 | 默认 | 说明 | 入口 |
|---|---|---|---|---|
| `running` | boolean | 有 `life.json` 则 true | 世界是否运行（记忆块/人设/提示词/生活线一起启停） | 概览「开始/停止」 |
| `dailyBudget` | number | 不写 = 不限 | 家里每天花费上限（元） | 概览「今日花费」 |
| `memoryTurns` | number | `200` | 记忆块带最近多少轮 | 概览「记忆」 |
| `coldHours` | number | `24` | 冷会话多少小时没开口就重读记忆块/人设（上限 720） | 概览「记忆」 |
| `archiveScope` | `home`/`workspace` | 主配置值 | 归档范围；改完需重启 | 概览「记忆」 |
| `workspacePermission` | string | `danger-full-access` | 新建会话的默认工作区权限 | 概览「工作区权限」 |
| `reviewTime` | `HH:MM` | `23:00` | 晚间回顾时间 | 概览「作息」 |
| `wakeTime` | `HH:MM` | 主配置 `fallbackWakeTime`（默认 09:00） | 早上起床时间 | 概览「作息」 |
| `compactAfterReview` | boolean | `true` | 回顾后自动应用她的改动并压缩 | 概览 |
| `compactionSwapped` | boolean | — | 是否已把宿主压缩换成插件压缩（安装记录） | 自动写入 |
| `wechatEnabled` | boolean | `false` | 微信模块开关 | 概览「模块」/微信页 |
| `qqEnabled` | boolean | `false` | QQ 通道开关 | 概览「模块」/QQ页 |
| `wechatContext` | number | `5` | 微信群消息带几条上下文（上限 20） | 微信页 |
| `wechatBufferSeconds` | number | `3` | 私聊图片等同伴消息的秒数（上限 30） | 微信页 |

---

## 6. 凭据与状态文件（不用改，知道在哪就行）

| 文件 | 位置 | 内容 |
|---|---|---|
| `credentials.json` | `<world>/bili/credentials.json` | `SESSDATA`、`bili_jct`、`buvid3`（B站页「Cookie」卡可改） |
| `bili-actions.json` | `<world>/bili/bili-actions.json` | 当天各动作计数：`dyn_pure`、`dyn_share`、`comment`… |
| `bili-comments.jsonl` | `<world>/bili/bili-comments.jsonl` | 每条评论尝试（成功/失败、bvid、rpid、时间） |
| `sent-at.json` / `sent-log.json` | `<world>/bili/` | 上次发送时间 / 最近 50 条内容（复读检测、评论最小间隔） |
| `plan.json` | `<world>/bili/plan.json` | 下一次 B 站定时触发的计划 |
| `quota.json` | `<world>/bili/quota.json` | 同视频去重与每日转发账本 |
| `logs/` | `<world>/bili/logs/` | 请求、封禁、缓存日志 |

---

## 7. 改动入口映射（按“我想改什么”找）

| 想改什么 | 去哪 |
|---|---|
| 世界开关、预算、记忆条数、冷启动小时、归档范围、工作区权限、回顾后压缩、作息时间、微信/QQ 模块开关 | 控制台 **概览** 页 |
| 她的名字/称呼、时区、QQ 连接、SnowLuma 路径、微信适配器、B站定时器总开关、评论硬上限/最小间隔、`allowWrite`（在设置页也能改） | **DSH 设置 → 插件配置 → dsh-world-bili**（或手改 `cordis.patch.yml`，重启生效） |
| 人设 | 控制台 **人设** 页（写 `<world>/persona.md`） |
| 世界提示词 | 控制台 **世界提示词** 页（写 `<world>/world-prompt.md`） |
| 真发模式（干跑/真发）、触发一次、B站凭据、观看/转发/动态/口味/作息参数、历史账本 | 控制台 **B站** 页 |
| 评论开关、真发总开关、每日条数、跳过概率、今日已发、最近 5 条 | 控制台 **评论** 页 |
| 每天触发次数、两次最小间隔、心情（查看/设置/喂饭） | 控制台 **心情·定时器** 页 |
| 记录、日记、压缩记录、相册 | 控制台 **记录** / **相册** 页 |
| 命令行调试（feed/debrief/act/comment/quota/deps…） | `node tools/bili.mjs <command>`（`comment --bvid … --message … [--go] [--force]`） |

> 「评论」页的两个开关写的是**主配置**（DSH 的配置编辑器），其余写 `bili.config.json`。

---

## 8. 改完什么时候生效

| 改哪里 | 生效时机 |
|---|---|
| `bili.config.json`（面板或手改） | **立即**——CLI 每次命令都重新读文件；面板显示下次刷新后更新 |
| `world.json`（控制台按钮） | 立即（按钮走宿主 API）；手改文件需重启 |
| 主配置（DSH 设置页/评论页开关） | 评论的 `enabled` / `allowWrite` 由面板保存时**同步写镜像**，CLI 立即生效；但插件内存里的 `config` 与动态 prompt 提示要**重启 DSH** 才更新 |
| 手改主配置且没重启 | 镜像不会自动更新：评论页/工具链仍按旧值；**重启 DSH** 后启动镜像才按主配置全量重写（面板保存只会把当次改的那一项写进镜像） |
| `persona.md` / `world-prompt.md` | 保存后新会话生效；正在聊的会话按冷战规则重读 |

---

## 9. 组合矩阵（评论）

| `comment.enabled` | `allowWrite` | `guard.dryRun` | 结果 |
|---|---|---|---|
| `false` | 任意 | 任意 | ❌ 「评论功能已关」——**连干跑预览都不给** |
| `true` | `false` | 任意 | ❌ 「dailyBili.allowWrite 未开」——不联网 |
| `true` | `true` | `true` | ❌ 「干跑（guard.dryRun 开着）」——`--go` 也不发 |
| `true` | `true` | `false` | ✅ 继续查最小间隔 → 日额度 → 风控，通过才真发（仅 `--go`） |
| 任意 | 任意 | 任意 | 不带 `--go` 时只到预览（但 `enabled=false` 仍拒绝） |

另外：`--force` 只跳过“跳过概率”抽签，**不跳过上面任何一道闸**。

---

## 10. 常见改法（示例）

```yaml
# cordis.patch.yml —— 只想看，不想真发
dailyBili:
  enabled: true
  allowWrite: false        # 评论 --go 会被拒；动态也只受 prompt 提示
comment:
  enabled: true            # 允许跑评论（包括干跑预览）
  hardDailyMax: 3          # 面板条数最多 3 条
  minIntervalSec: 7200     # 两条真发评论至少隔 2 小时
```

```json
// bili.config.json —— 工具链侧保险
{
  "guard": { "dryRun": true },
  "comment": { "dailyMax": 1, "skipChance": 0.5 }
}
```

```bash
# 干跑看一条
node tools/bili.mjs act comment --bvid BV1xx411c7mD --message "试试看"
# 真发（三闸都开时才会真的发）
node tools/bili.mjs act comment --bvid BV1xx411c7mD --message "试试看" --go
```

---

## 11. 已知差异与注意

1. **`dryRun` 只有一个开关（0.8.7 起）**：B站页顶部「真发模式」是唯一入口，勾上=真发（写 `false`），不勾=干跑（写 `true`）。以前的「风控闸门 guard」卡里还有一个极性相反的复选框，两处各自缓存、互不刷新，会把刚改的值改回去——现在 guard 卡只保留说明文字，不再提供控件。
2. **`dailyBili.allowWrite` 对动态链只是提示词层面**：动态/转发的代码闸只有 `guard.dryRun`；只有评论链把 `allowWrite` 做成了硬校验。
3. **镜像以主配置为准**：插件启动时会用主配置覆盖 `bili.config.json` 里的 `comment.enabled / allowWrite / hardDailyMax / minIntervalSec`。手改 `bili.config.json` 的这四项，在下次插件启动前有效，启动后会被覆盖。
4. **`comment.enabled=false` 连预览都拒**：如果只想“看看会发什么”，要把评论开关打开，靠 `dryRun` 或 `allowWrite` 阻止真发。
5. **`comment.minIntervalSec` 按 `sent-at.json` 记账**：判的是“上次**成功**发送”的时间，失败不留痕；改小或设为 0 可以立刻再发。
6. **`night.wakesPerDay` / `night.minGapMin` 不在默认配置模板里**，但代码会读并夹取范围（1–12 / 1–240），面板写的就是这两个键。
7. **预留 section 不生效**（见 §4.8），包括 `share.enabled` / `share.via` / `bilibili.share.addComment` 这类只占位的键。

---

## 12. 常见故障

### 12.1 面板保存失败：`Configuration for "dsh-world-bili" is overridden by a home patch or command-line overlay`

**现象**：在「评论」页拨「评论功能」或「B站真发总开关」时保存失败，弹出这条；同一页的「每日上限」「跳过概率」却正常（它们写 `bili.config.json`，不走宿主配置编辑器）。

**原因**：这个插件同时是一个 profile bundle（在 profile 的 `dsh.profile.bundles` 里），bundle 自带的 `cordis.patch.yml` 已经会插入 `dsh-world-bili` 这一行；旧版自注册又往 profile 的 `cordis.patch.yml` 写了一条 `- insert:`。两处都插入，宿主组合出两条同 id 的行——第一条（bundle 的）没有 `config`，配置编辑器保存后比对的是第一条，于是判定「被 home patch 或命令行 overlay 覆盖」，拒绝写入。

**修法**：

- **0.8.7 起自动修**：插件启动时发现 bundle 已经提供该行，会把自注册那条 `- insert:` 删掉（备份为 `cordis.patch.yml.dsh-world-bili.<随机>.bak`）；
- 手动修：删掉下面这一块，保留 `- id: dsh-world-bili` 的 `config:` 行，然后重启 DSH：

```yaml
- insert:
    - id: dsh-world-bili
      name: dsh-world-bili
```

**影响范围**：只影响「写主配置」的两个开关。手改 `cordis.patch.yml` 仍然有效，重启后镜像会更新，工具链照常读；`bili.config.json` 的控件不受影响。

---

*相关文档：[CHANGELOG.md](../CHANGELOG.md)。*
