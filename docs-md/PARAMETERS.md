# 参数总表（B 站侧 + 世界）

> 版本：0.9.4。**行号已用脚本逐个核对过**（改代码后请顺手更新本表）。
> 「读它的地方」= 代码里真正读这个参数的位置；定义处另标。
> 0.9.3/0.9.4 新增的两件事见 §1.1：`reach_out` 现在有一条内置的 QQ 私聊出口；自查（提前停下）默认停用，每日回顾保留。

## 0. 五类参数，分别改哪里

| 类别 | 存在哪 | 谁能改 | 生效时机 |
|---|---|---|---|
| **主配置** | profile 的 `cordis.patch.yml` → 插件 `Config` schema（`src/index.ts:91`） | 手改 yml / DSH 设置页 | 重载插件 |
| **世界开关** | `<world>/world.json`（`src/worldSwitch.ts:19`） | 控制台面板 | 立刻（`running` 除外） |
| **手动配置** | `<world>/bili.config.json`（`tools/lib/config.mjs:46` `DEFAULTS`） | 面板改一部分，其余手写 | 立刻（`config()` 不缓存） |
| **命令行** | `node tools/bili.mjs <命令> …` | 她 / 人 | 当次 |
| **代码写死** | 常量与内联字面量 | 改代码 → 重新构建 | 新版本 |

`<world>` = `~/.dsh/worlds/<worldId>`；B 站数据根 = `<world>/bili`。

---

## 1. 主配置（profile → 插件）

定义 `src/index.ts:91`（`z.object`），字段语义见 `src/types.ts` 的 `WorldConfig`。

| 键 | 默认 | 功能 | 读它的地方 |
|---|---|---|---|
| `worldId` | `default` | 世界目录名，同时写进 `WORLD_ID` | `src/index.ts:269` |
| `agentPreset` | `standard` | 家/群会话用的 agent 预设 | `src/index.ts:436` |
| `timeZone` | 系统时区 | 所有本地时间与日切的唯一口径 | `src/timeContext.ts:12` |
| `companionName` / `partnerName` | 空 | 提示词里「我」「你」的名字（人格里的名字优先） | `src/worldPrompt.ts:34` |
| `archiveScope` | `workspace` | 记忆归档范围，改完重启 | `src/archiveSelection.ts` |
| `replaceCompaction` | `true` | 首次启动把 profile 的压缩行换成插件自带版 | `src/compactionSwap.ts` |
| `life` | `true` | 生活线（闹钟/回顾/日记）总开关 | `src/index.ts:318` |
| `diaryDir` | `<world>/diary` | 日记目录 | `src/index.ts:313` |
| `fallbackWakeTime` | `09:00` | 「什么都没定」时早上叫她的时刻 | `src/life/runtime.ts`、`templates/alarm.md` |
| `selfFile` / `personaFile` / `worldPromptFile` / `alarmTemplateFile` | `<world>/` 下默认 | 我是谁 / 人格 / 世界提示词 / 闹钟文案的覆盖位置 | `src/index.ts:300-303` |
| `outlets` | `[]` | 她的话推给外部程序（POST），`kinds` 选 reply/busy/reach；`reach` 是 `reach_out` 的第 2 条通道（第 1 条见 §1.1） | `src/ecosystem/shared/outlets.ts` |
| `bridge` | `false` | 本机程序 `POST /dsh-world/bridge/say` 递话 | `src/ecosystem/bridge/bridge.ts` |
| `wechat` | `false` | 微信通道 | `src/ecosystem/wechat/index.ts` |
| `wechatAdapter.{python,config}` | 空 | 随微信模块启停的适配器（写了=允许它发消息） | `src/index.ts:441` |
| `toast` / `toastAppId` | `true` / 空 | 系统通知；**只有 Windows 有**（`toastSupported()` 判平台），云服务器上这条通道根本不存在 | `src/life/notify.ts` |
| `allowedHosts` | `[]` | 控制台额外允许的 Host（跨站一律 403） | `src/console/routes.ts` |
| `qqNative.enabled` | `false` | QQ 原生通道总开关；打开时 `reach_out` 自动多一条 QQ 私聊出口（§1.1） | `src/index.ts:556` |
| `qqNative.wsUrl` | `ws://127.0.0.1:3003` | SnowLuma 的 OneBot WS 地址 | `src/ecosystem/qq-native/snowluma.ts` |
| `qqNative.accessToken` | 空 | OneBot token（空串不传） | 同上 |
| `qqNative.allowPrivate` | `[]` | 能私聊她的 QQ；**第一个也是「主人」的兜底**（`ownerQQ` 没配时用它） | `qq-native/index.ts:327` |
| `qqNative.ownerQQ` | 空 | **主人**：接收自主发言/分享、也是 `reach_out` 的收件人；空则退回 `allowPrivate[0]`（见 §1.1） | `src/bili/owner.ts:35` |
| `qqNative.allowGroups` | `[]` | 允许接话的群 | `qq-native/index.ts:326` |
| `qqNative.autoReply` | `true` | 关掉＝收到不理（不花一轮） | `qq-native/index.ts:379` |
| `qqNative.contextMessages` | `6` | 每轮带几条上文（夹 1–20） | `qq-native/index.ts:380` |
| `qqNative.batchQuietMs` | `10000` | 同会话几句话攒一条再问；0 = 一条一问 | `qq-native/batch.ts` |
| `qqNative.groupTrigger` | `mention` | 群里只接被叫到的 / 每句都接 | `qq-native/index.ts:262` |
| `qqNative.groupKeywords` | `[]` | 命中这些词也算在叫她 | 同上 |
| `qqNative.mutedUntil` | 空 | 只停嘴不停耳，到点自己醒（ISO） | `qq-native/index.ts:379` |
| `qqNative.snowlumaHome` | 空 | SnowLuma 目录（看门狗/拉起） | `src/ecosystem/qq/supervisor.ts` |
| `qqNative.supervise` | `true` | 每 30 秒探端口，不通就拉起 SnowLuma | 同上 |
| `qqNative.bindHomeSession` | `owner` | 谁和家会话共用入口（owner/all/none） | `src/index.ts:505` |
| `qqNative.bridge.{port,token,title,contextMessages}` | `0/空/阳台/6` | 「阳台」WS 线；port 0 = 关 | `qq-native/native-bridge.ts` |
| `dailyBili.enabled` | `false` | B 站自由模式总开关 | `src/index.ts:541` |
| `dailyBili.dailyTime` | `20:00` | **仅兜底**：工具链加载/排期失败才用它 | `src/index.ts:554`、`src/bili/dailyBili.ts:362` |
| `dailyBili.dailyMaxVideos` | `10` | 每日**转发**硬上限（并入 session 剩余量）；0 = 不限 | `src/index.ts:555` → `session-limit.resetSession` |
| `dailyBili.napcatHttp` | `http://127.0.0.1:3000` | **已失效**：0.8.23 起没有读取点 | — |
| `dailyBili.ownerQQ` | 空 | 次要来源，`qqNative.ownerQQ` 没配时才用 | `src/bili/owner.ts:35` |
| `dailyBili.allowWrite` | `false` | 真发总开关，镜像成 `comment.allowWrite` | `src/index.ts:183` `mirrorCommentConfig` |
| `comment.enabled` | `false` | 评论开关（镜像进 bili.config.json） | `src/index.ts:183` → `bili-write.mjs:365` |
| `comment.hardDailyMax` | `5` | 评论每日硬上限，面板条数被它钳制；0 = 不限 | `bili-write.mjs:307` `commentCap`（调用 385） |
| `comment.minIntervalSec` | `3600` | 两条评论最小间隔（秒） | `bili-write.mjs:377` |

### 1.1 `reach_out`（她主动找主人）走哪几条通道

| 通道 | 什么时候在 | 送到哪 | 送不到时 |
|---|---|---|---|
| **QQ 私聊**（0.9.4 起内置） | `qqNative.enabled: true`、通道在线、配了主人 | 主人 QQ 私聊，一句一条 | 静默中 / 未连接 / 没配主人都报「没送到」，不排队 |
| `outlets` | 配置里有 `kinds` 含 `reach` 的出口 | 你登记的 HTTP 接收端 | 非 2xx 或回 `ok:false` 算失败 |
| 系统通知 | 只在 Windows 且 `toast: true` | 桌面右下角 | 找不到通知身份就失败 |

- 主人是谁：`qqNative.ownerQQ`，空则 `qqNative.allowPrivate[0]`——`qq-native/index.ts:58` 的 `ownerId`，全模块唯一口径（自主发言推给谁、分享发给谁、标「（你主人）」、`reach_out` 发给谁，四件事同一个人）。
- 规则：每条通道独立成败，**全失败才报错**、部分成功照实汇报（`src/life/tools.ts` 文件头「坑」）。
- 云服务器上没有 toast，所以实际就是「QQ 私聊 + outlets」两条；QQ 在线她就找得到你。
- 静默（`qqNative.mutedUntil`）连这条一起挡：静默是「别吵他」，不排队、直接回没发。
- 这条出口只收 `reach`；回复、在忙、整轮转发、share 队列都不走它（`src/index.ts:547` 起）。

---

## 2. 世界开关（`<world>/world.json`）

定义 `src/worldSwitch.ts:19`；面板改，立刻生效。

| 键 | 默认 | 功能 | 位置 |
|---|---|---|---|
| `running` | `false` | 世界在不在跑（控制台电源键） | `worldSwitch.ts`（`running()`） |
| `wakeTime` | `fallbackWakeTime`（09:00） | 早上几点 → **B 站窗口起点** | `worldSwitch.ts:130` |
| `reviewTime` | `23:00` | 回顾几点 → **B 站窗口终点** | `worldSwitch.ts:129`、`life/alarm.ts:28` |
| `dailyBudget` | 无 | 每天饭钱（元），`null` = 不限 | `life/runtime.ts` 花费闸 |
| `memoryTurns` | `200` | 记忆块带最近几轮 | `worldSwitch.ts:21` |
| `coldHours` | `24`（上限 720） | 沉默多久后重读记忆与提示词 | `worldSwitch.ts:23` |
| `compactAfterReview` | 开 | 回顾后自动「应用并压缩家会话」 | `console/homeApply.ts` |
| `archiveScope` | 主配置值 | 记忆归档范围（改完重启） | `worldSwitch.ts:63` |
| `workspacePermission` | 宿主默认档 | **新建**家会话套用的权限档 | `workspacePermissions.ts:31` |
| `wechatEnabled` / `qqEnabled` | `false` | 两条通道的硬开关 | `worldSwitch.ts:120-121` |
| `wechatContext` | `5`（上限 20） | 微信每轮带几条上文 | `worldSwitch.ts:25` |
| `wechatBufferSeconds` | `3`（上限 30） | 微信消息攒几秒再问 | `worldSwitch.ts:27` |
| `compactionSwapped` | — | 压缩实现是否已换成插件自带版 | `compactionSwap.ts` |

---

## 3. 手动配置（`<world>/bili.config.json`）

`config()` = 默认值 + 用户文件深合并（数组整体替换、对象递归、**`null` 原样保留**）。

### 3.1 风控与作息

| 键 | 默认 | 功能 | 读它的地方 |
|---|---|---|---|
| `guard.dryRun` | `true` | 干跑：写动作只预览 | `guard.mjs:111` |
| `guard.minGapSec` | `25` | 同一 chat 两条消息最小间隔（秒） | `guard.mjs:133` |
| `guard.dupThreshold` | `0.6` | 3-gram Jaccard 复读阈值 | `guard.mjs:88` |
| `guard.banned` | 4 个词 | 发送前删掉的黑名单词 | `guard.mjs:72` |
| `night.skipChance` | `0.3` | 每次排期「今天不想刷」的概率（skip 也占一次名额） | `dailyBili.ts:83` |
| `night.minGapMin` | `10` | 两次唤醒最小间隔（夹 1–240） | `dailyBili.ts:84` |
| `night.maxVideos` | `5` | **feed 每次输出几条候选**（夹 20，不是池子大小） | `dailyBili.ts:86` → `feed.mjs:107` |
| `night.windows` | 已废弃 | 窗口由 world 的 `wakeTime`→`reviewTime` 决定 | — |

### 3.2 口味与选题（feed）

| 键 | 默认 | 功能 | 读它的地方 |
|---|---|---|---|
| `preferences.like` | 4 个词 | 偏好词加分；每轮随机抽 2 个去搜索 | `feed.mjs:131` |
| `preferences.dislike` | 4 个词 | 命中整条剔除 | `feed.mjs:160` |
| `preferences.keywords` | `[]` | 额外搜索词，按本地日轮换（每轮 2 个） | `feed.mjs:134`、`seed-rotation.mjs:29` |
| `preferences.synonyms` | `{}` | 追加同义词（与 `tools/lib/synonyms.json` 合并） | `feed.mjs:161` |

### 3.3 分享与额度

| 键 | 默认 | 功能 | 读它的地方 |
|---|---|---|---|
| `share.enabled` | `true` | 分享总开关；false 时转发直接拒绝 | `bili-write.mjs:451` |
| `share.push` | `true` | 分享是否真推到 QQ；false = 只排队不丢 | `qq-native/index.ts:487` |
| `quota.shareDaily` | `3` | 转发日上限的回落值（`shareDailyMax` 为 0 时用） | `config.mjs:241` `shareDailyLimit` |
| `quota.sameVideoDays` | `7` | 同一条视频几天内不再转（feed 也用它去重） | `quota.mjs:86`、`feed.mjs:181` |

### 3.4 看懂一条（debrief）

优先级：命令行 > 这里 > 内置默认（`debrief.mjs:44` `resolveDebriefOptions`）。

| 键 | 默认 | 功能 |
|---|---|---|
| `debrief.comments` | `5` | 热评条数（夹 1–20） |
| `debrief.frames` | `true` | 要不要抽帧（没 ffmpeg 可关） |
| `debrief.cache.framesMaxMB` / `framesMaxDays` | `300` / `7` | 抽帧缓存上限与保留天数 |
| `debrief.cache.coversMaxMB` / `coversMaxDays` | `100` / `7` | 封面缓存上限与保留天数 |

（四行的读取都在 `debrief.mjs:44` 起的 `resolveDebriefOptions` 里。）

### 3.5 评论

| 键 | 默认 | 功能 | 读它的地方 |
|---|---|---|---|
| `comment.enabled` | `false` | 评论开关（主配置镜像） | `bili-write.mjs:365` |
| `comment.allowWrite` | `false` | 真发总开关（`dailyBili.allowWrite` 镜像） | `bili-write.mjs:372` |
| `comment.dailyMax` | `0` | 面板可改的每日条数，0 = 不限 | `bili-write.mjs:307`（调用 385） |
| `comment.hardDailyMax` | `5` | 硬上限（主配置镜像），面板值不能超 | 同上 |
| `comment.skipChance` | `0.3` | 抽签跳过概率（`--force` 可绕过） | `comment.mjs:69` |
| `comment.minIntervalSec` | `3600` | 两条评论最小间隔（秒） | `bili-write.mjs:377` |

### 3.6 主人打码（debrief 防注入）

| 键 | 默认 | 功能 | 读它的地方 |
|---|---|---|---|
| `owner.qq` | 空 | 主人 QQ，材料里出现就打码 | `debrief.mjs:117` |
| `owner.name` | 空 | 主人昵称（qq/name 由宿主 `mirrorOwnerConfig` 自动补） | `debrief.mjs:115` |
| `owner.mid` | 空 | 主人的 B 站 mid，只能手填 | `debrief.mjs:116` |

### 3.7 账本（她自己的饭钱）

| 键 | 默认 | 功能 | 读它的地方 |
|---|---|---|---|
| `ledger.enabled` | `true` | **不生效**（无读取点） | — |
| `ledger.dailyBudget` | `3` | 每天饭钱（元），0 = 不设预算 | `ledger.mjs:271` |
| `ledger.mineWorkspace` | `bili-work` | 哪个工作区的会话算「她自己吃的」 | `ledger.mjs:117` |
| `ledger.price.{inputPerM,cachePerM,outputPerM}` | `2 / 0.2 / 3` | 元/百万 token | `ledger.mjs:137` |
| `ledger.balanceUrl` / `apiKey` / `balanceTimeoutMs` | 空 / 空 / `8000` | 查 DeepSeek 余额（也可用 `DEEPSEEK_API_KEY`） | `ledger.mjs:223-226` |
| `ledger.python` / `sessionsDir` | 不在默认表 | 账本脚本的 Python 与会话目录（手写才有） | `ledger.mjs:51,65` |
| `ledger.promptInQQ` | `true` | **不生效**（无读取点） | — |

### 3.8 B 站写通道

| 键 | 默认 | 功能 | 读它的地方 |
|---|---|---|---|
| `bilibili.reportHistory` | `true` | debrief 后上报观看历史 | `debrief.mjs:322` |
| `bilibili.watch.autoFromWindow` | `true` | 每次唤醒名额按窗口推导（14h → [3,9]） | `session-limit.mjs:127` |
| `bilibili.watch.sessionMin` / `sessionMax` | `null` / `null` | 手动模式：本次**转发**名额区间随机；相等=固定 | `session-limit.mjs:131-139` |
| `bilibili.dynamic.enabled` | `false` | **纯文字动态**总开关 | `bili-write.mjs:273` |
| `bilibili.dynamic.shareEnabled` | `true` | **转发视频**总开关（与上面独立） | `bili-write.mjs:452` |
| `bilibili.dynamic.pureDailyMax` | `2` | 纯动态每日上限（0 = 不限） | `bili-write.mjs:274` |
| `bilibili.dynamic.shareDailyMax` | `0` | 转发每日上限（0 = 回落 `quota.shareDaily`） | `config.mjs:241` |
| `bilibili.dynamic.pureSessionMin` / `pureSessionMax` | `0` / `1` | 本次唤醒纯动态名额区间（随机，可能到 0） | `session-limit.mjs:178-180` |
| `bilibili.dynamic.alsoComment` | `false` | 转发后顺手在视频下评论同一段文案 | `bili-write.mjs:437` |
| `bilibili.share.minScore` | `13` | **唯一**打分阈值：`--score` 低于它拒绝转发 | `act.mjs:84` |
| `bilibili.share.shareMode` | `auto` | `forwardOnly` = 只转发、丢掉配文 | `bili-write.mjs:433` |
| `bilibili.react.like` / `coin` | `false` / `false` | 顺手点赞 / 投币，必须显式开 | `bili-write.mjs:565` / `585` |
| `bilibili.react.likeDaily` / `coinDaily` | `10` / `1` | 点赞 / 投币每日上限 | `bili-write.mjs:566` / `586` |
| `bilibili.danmaku.enabled` / `dailyMax` | `false` / `5` | 弹幕开关与上限（发送通道仍是注释状态） | `bili-write.mjs:527` |

注释掉的占位段（不读）：`imageComment`、`replies`、`fishCircle`、`follow`、`freeRoam`（`config.mjs:185` 起）。

---

## 4. 命令行参数

入口 `tools/bili.mjs`，命令白名单 `bili.mjs:49`（`COMMANDS`）。所有命令只设退出码，不 `process.exit()`。

| 命令 | 参数 | 说明 |
|---|---|---|
| `deps` / `selftest` | — | 体检 Node / 凭据 / 配置 / 登录态 / 熔断 / 干跑 |
| `nav` | — | 打一次 nav：mid、昵称、等级、VIP、金币 |
| `feed` | `--json`、`--n N` | `--n` 夹 1–20，缺省取 `night.maxVideos`（`feed.mjs:107`） |
| `debrief` | `--bvid`（必填）、`--json`、`--no-frames`/`--frames`、`--bucket`（5–600）、`--top`（1–20）、`--grid`、`--tile`（240–1920）、`--comments`（1–20） | 六路材料 + 末尾 `---BILI_ACTION---` 打分块 |
| `act dyn` | `--bvid`、`--text`、`--score 0-20`、`--go`、`--also-comment`/`--no-comment` | 带 `--bvid` = 转发（必须过 minScore）；不带 = 纯动态 |
| `act comment` | 转交 `comment.mjs`：`--bvid`、`--message`、`--go`、`--force` | `--force` 只跳过概率抽签 |
| `quota` | `show`（默认）/ `check --type --target` / `record --type --target --note` | 账本 `quota.json` |
| `focus` | `<bilibili\|rest\|off>`、`--min N`、`--note`；无参=看现状 | 写 `focus.json` |
| `share` | `--bvid`/`--url`（二选一）、`--title`、`--say`、`--list`、`--json` | 写 `owner-outbox.jsonl`，不联网 |

退出码：`0` 成功/干跑通过；`1` 被闸门或接口拒绝；`2` 参数不合法。

---

## 5. 代码写死的值（只能改代码）

| 值 | 作用 | 位置 |
|---|---|---|
| 12 | 每天最多唤醒次数（硬上限） | `src/bili/dailyBili.ts:44` |
| 1 / 240 | `minGapMin` 允许范围（分钟） | `dailyBili.ts:46,48` |
| 5 | 专注剩 ≤5 分钟就跳过唤醒 | `dailyBili.ts:224` |
| 0.6 | 窗口每小时折算几次「看+转」 | `session-limit.mjs:104` |
| [2,4] | 窗口算不出时的兜底名额 | `session-limit.mjs:107` |
| 20 | feed 一次最多输出几条 | `feed.mjs:107` |
| 20 条/页、1–3 页 | 热门榜每页条数、随机翻页 | `feed.mjs:116-117` |
| 2 / 2 | 每轮几个偏好词 / 几个种子词 | `feed.mjs:133`、`seed-rotation.mjs:29` |
| 100 MB / 7 天 | 封面缓存上限 | `debrief.mjs:30,32` |
| 300 MB / 7 天 | 抽帧缓存上限 | `frames.mjs:25,27` |
| 3 次 / 700 ms / 60 行 | 字幕重试次数、间隔、判贴合取前几行 | `debrief.mjs:239-247` |
| 15% / 5% | 「够贴合就收手」/「整段丢弃」 | `debrief.mjs:253,260` |
| 40 行 | 输出里带的字幕行数 | `debrief.mjs:378` |
| 120 s + 1.5 s/秒 | 抽帧超时（随时长增长） | `frames.mjs:128` |
| 0.3 / 0.15 / 0.08 | 场景检测阈值阶梯 | `frames.mjs:130` |
| 30% 且 ≥20 条 | 判「刷屏波」并剔除 | `media.mjs:74` |
| 6 / 12 | 每段列几条弹幕 / 全程高频列几条 | `media.mjs:106,117` |
| 24 h / 10 min | API 缓存 TTL / nav TTL | `bili-api.mjs:69,80` |
| 300 ms | 两次请求最小间隔 | `bili-api.mjs:129` |
| 400 条 | API 缓存条目上限 | `bili-api.mjs:263` |
| 5→30 分钟 | 412/429 熔断的指数退避 | `bili-api.mjs:223` |
| 7×TTL | 熔断期间允许的旧缓存年龄 | `bili-api.mjs:172` |
| 2000 字 | 动态/评论正文上限（`slice(0,1000)`） | `bili-write.mjs` 的 `postDynamic` / `postReply` / `shareVideoDynamic` |
| 2000 行 | 评论流水保留条数 | `bili-write.mjs:341` |
| 50 / 20 | sent-log 每 chat 留几条 / 复读比对几条 | `guard.mjs:149,94` |
| 400 条 / 3×120 ms | quota 账本保留条数 / 抢锁重试 | `quota.mjs:118,60` |
| 200 条 / 10 分钟 | 分享队列上限 / 同视频同文案合并 | `owner-share.mjs:73`、`appendShare` |
| 3 s / 30 次 / 400 id | 分享轮询间隔 / 放弃前重试 / 已发 id 记忆 | `share.ts:166,99,88` |
| 5 分钟 / 40 次 / 3 s | QQ 发送重试队列 TTL / 次数 / 间隔 | `outbox.ts:11,35` |
| 2000 字 / 500 条 | QQ 单条入站上限 / 去重记忆 | `qq-native/index.ts:23,25` |
| 600 ms | 一段回复拆多条时每条间隔 | `qq-native/index.ts:27` |
| 30 分钟 / 40 条 | 整轮转发去重窗口 / 记忆条数 | `qq-native/index.ts:29,31` |
| 8 条 / 16 KB | 群聊上下文上限 | `shared/context.ts:63,86` |
| 64 KB / 32 KB | 控制台 / 桥的请求体上限 | `console/routes.ts:32`、`bridge/route.ts:19` |
| 5 s | 控制台快照缓存 | `console/snapshot.ts:34` |
| 60 s / 2 min | 闹钟最短 / 迟到多久算「晚到」 | `life/alarm.ts:25,26` |
| 23:00 | 回顾时间默认值 | `life/alarm.ts:28` |
| 5 min | 闹钟断线保护分段检查 | `life/alarmTimer.ts:31` |
| 5 min | 「她卡住了」判定 | `life/runtime.ts:55` |
| 回顾开、自查关 | 生活线自消息：`LifeOptions.earlyStop` 不传即停用；`dailyReview: true` 保留（日记/「我是谁」快照/回顾后压缩靠它） | `src/index.ts:313`、`src/life/types.ts:58` |
| 4000 字 | 「我是谁」长度上限 | `self.ts:15` || 20 / 100 / 4000 | 记忆查找默认/最多条数、读取上限 | `memory.ts:50` |
| 2 MB / 2000 个 | 单记忆源文件上限 / 每目录文件数 | `memoryFiles.ts:29` |
| 20 MB | 相册单张上限 | `life/photos.ts:20` |
| 「伙伴」/「TA」 | 没配名字时的默认称呼 | `worldPrompt.ts:35` |

---

## 6. 环境变量

| 变量 | 作用 | 读它的地方 |
|---|---|---|
| `WORLD_ID` | 当前世界 id | `paths.mjs:48` |
| `WORLD_BILI_DATA_DIR` | B 站数据根，优先于默认路径 | `paths.mjs:56` |
| `WORLD_BILI_CONFIG` | `bili.config.json` 位置 | `paths.mjs:72` |
| `WORLD_BILI_NO_CACHE=1` | 完全绕开 API 缓存（排障） | `bili-api.mjs:120` |
| `DSH_HOME` | DSH 根，默认 `~/.dsh` | `paths.mjs:36` |
| `USERPROFILE` / `HOME` | 用户主目录 | `paths.mjs:33` |
| `FFMPEG` | 指定 ffmpeg（优先于 PATH） | `ffmpeg.mjs:55` |
| `DEEPSEEK_API_KEY` | 查余额（也可写 `ledger.apiKey`） | `ledger.mjs:224` |

---

## 7. 已知「不生效 / 名不副实 / 易踩坑」

1. **`null` 会被当成 0**：`night.skipChance`/`maxVideos`/`minGapMin`/`wakesPerDay` 的守卫是 `Number.isFinite(Number(x))`，`Number(null)`=0 → 跳过概率变 0、候选池变 1。`guard.dryRun: null` 会**关掉干跑**。
2. **`night.maxVideos` 名字骗人**：它决定 feed 每次输出几条（夹 20），不是「抓多少池子」。填 200 与 20 等价。
3. **`watch.sessionMin/Max` 管的是转发条数**，不是「刷几条视频」；`autoFromWindow: true` 时两格被忽略。
4. **两套日上限**：`quota.json`（`quota.check`）与 `bili-actions.json`（`capOk`）各记一份，任一次写失败会各说各话。
5. **已删除的键**（写了不报错、只是被忽略）：`share.via`、顶层 `share.minScore`、`bilibili.share.addComment`、`bilibili.ownMid`、`bilibili.ownBvids`；`tools/lib/share-policy.mjs` 整个模块已删。
6. **`dailyBili.napcatHttp`** 是死参数。
7. **`dailyBili.dailyTime` 只是兜底**：正常由 world 的 `wakeTime`/`reviewTime` 推导。
8. **`ledger.enabled` / `ledger.promptInQQ`** 不生效。
9. **`bilibili.danmaku.*`** 有配置有闸门，但发送通道是注释状态，等于用不了。
10. **`debrief.frames: false` 时不抽帧**，但 `--frames` 可临时打开；`--no-frames` 永远优先。
11. **云服务器上没有桌面通知**：`toastSupported()` 只认 Windows，`toast` 写 `true` 也没用；`reach_out` 在云上原来只剩 outlets 一条路，0.9.4 起内置了 QQ 私聊出口（§1.1）。
12. **静默会挡 `reach_out`**：`qqNative.mutedUntil` 没到点时，她主动找你也发不出去，`reach_out` 会报「静默中（到 …），这条没发」；静默不排队。
13. **整轮转发只认 B 站唤醒（0.9.3）**：闹钟、每日回顾、提前停下这些轮次不再推给主人，只在她的会话里出现；`lifeKind` 加新值也不会自动开始转发。
