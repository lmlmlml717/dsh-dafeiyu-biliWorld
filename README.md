# dsh-dafeiyu-biliWorld

> 给 [DSH](https://github.com/deepseek-ai) DeepSeek Harness 的一个「世界 + B 站自动化」
> 加了评论发布、动态发布、视频转发
> 当前版本 **0.9.6** · 基于 **dsh-world**，融合 **dsh-feiyu** 的评论链路与 **dsh-bili-whale** 的 B 站工具链/调度设计。
## 太厉害啦DeepSeek大人  与[dsh-world](https://github.com/chenkezhen480/dsh-world)不兼容（大概，我也没试过，这篇md都是DeepSeek大人写的
[![release](https://img.shields.io/github/v/release/lmlmlml717/dsh-dafeiyu-biliWorld)](https://github.com/lmlmlml717/dsh-dafeiyu-biliWorld/releases/latest)当前版本：0.2.2-rc.1 下载tgz包，复制路径安装即可
---
<img width="350" height="350" alt="image" src="https://github.com/user-attachments/assets/767d0883-9993-44d5-ab08-fa2403db3015" />
<img width="350" height="350" alt="image" src="https://github.com/user-attachments/assets/6dc2f239-c8bf-4463-8697-26c41d1cde59" />
<img width="350" height="350" alt="image" src="https://github.com/user-attachments/assets/48763b43-8835-4cca-9ab4-0312184b4529" />
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/wanglijie34/dsh-session-jump)


## 它能做什么

### 一个会生活的世界

- **家与房间**：一个独立的家会话 + 一个工作区房间；房间里的文件她可以自己整理。
- **记忆**：最近若干轮对话原文常驻；更早的按天归档，可用 `memory_find` / `memory_read` 回查。日记和「我是谁」由她自己写。
- **生活线**：自己定闹钟、定焦点、安排日程；每天按时回顾、写日记；想你时可以主动来找你。
- **人设与世界提示词**：控制台里分层编辑；世界提示词可以整份覆盖内置模板。
- **相册**：收藏对话里出现过的图片，控制台按页查看。
- **世界控制台**：概览、人设、世界提示词、记录、档案、相册、QQ、微信、B站、评论、评论记录。

### B 站自动化

- **定时刷视频**：按世界作息窗口随机触发，每次刷若干条，逐条 `debrief` 深读（标题/简介/字幕/热评）。
- **转发动态**：评分达标的视频转发到自己的动态，带 agent 生成的配文。
- **评论**：可以只评论，也可以在转发动态时「同时评论」；两者共用同一套风控与额度。
- **评论记录**：控制台新页按天查看真实发出的评论；删除时先删 B 站那条评论，再删本地记录。
- **额度/账本/心情**：每日上限、同视频去重、评论额度、心情与饥饿度都会影响她的行为。
- **等分调度**：每天 N 次触发时，按「剩余窗口 ÷ 剩余次数」等分，第一次不会被随机扔到几小时后。

### 聊天通道

- **QQ 原生通道**：插件直接连 SnowLuma 提供的 OneBot WebSocket，不经过第二个桥进程。
- **微信模块**：可选的 Windows 适配器（Python），按模块内说明配置；默认关闭。
- **桌面桥**：本机其他程序可以通过 `bridge` 把话送进家里，也可以接她的回复。

---

## 与上游的关系

| 上游 | 用到的部分 |
| --- | --- |
| [dsh-world](https://github.com/chenkezhen480/dsh-world) | 世界/记忆/生活线/控制台骨架、压缩与提示词机制 |
| dsh-feiyu | 评论链路、评论风控与「同时评论」的思路 |
| dsh-bili-whale | B 站 CLI 工具链、夜间调度、额度与去重账本 |
| PiliPlus | 转发动态 `scene=5 + web_repost_src`、评论删除等接口格式参考 |

这个仓库是在上述项目基础上改出的 **B 站特化版**：新增了 B 站工具链、每日定时、评论记录、QQ 原生通道和若干稳定性修复。上游的 MIT 许可与版权声明保留在 [LICENSE](LICENSE)。

---

## 环境要求

- **DSH NEXT**（桌面版；开发时对应 `0.2.2-rc.1` 一代宿主）
- **Node.js ≥ 22.16**（DSH 自带运行时也可以）
- **pnpm**：优先用 DSH 自带的那个（`<DSH 安装目录>/resources/runtime/.../pnpm`）
- 可选：**SnowLuma**（QQ 登录与 OneBot 服务，插件不代替它登录 QQ）
- 可选：**Python 3.11**（只有微信 Windows 适配器需要）

---

## 安装

装 `npm pack` 出来的 tgz。**分发一律走 tgz**——`link:` 指向带 `node_modules/@deepseek-ai` 的源码目录时，旧核心包会被投影进 profile，宿主会报 `1 required plugin did not activate`。

```bash
git clone https://github.com/lmlmlml717/dsh-dafeiyu-biliWorld.git
cd dsh-dafeiyu-biliWorld

npm ci
npm run build
npm pack          # 产出 dsh-world-bili-<版本>.tgz
```

退出 DSH，把 tgz 装进你的 profile：

```bash
cd <DSH_HOME>/profiles/<你的 profile>
node <DSH 自带 pnpm 的入口> add <tgz 的绝对路径> --ignore-scripts
```

确认 profile 的 `package.json` 里 `dsh.profile.bundles` 含 `dsh-world-bili`，然后重启 DSH。也可以在 DSH 的插件面板里直接安装这个 tgz。

### peer 与 `@deepseek-ai/dsh-*`

插件把宿主核心包声明成 peer（区间 `>=0.2.1-rc.2 <0.3.0-0`），运行时由 DSH 自己提供；正常装 tgz 时 profile 里**不会**多出这批包（0.9.6 实测：profile 只解析出 `ws`、`dsh-world-bili`、`@snowluma/sdk` 三个包）。

如果某台机器上 pnpm 真把它们装进了 profile，两件事要留意：

- **预发布版默认不算满足这个区间**：`0.2.2-rc.1` 这类不会被选中，会落到 `0.2.1` / `0.2.1-rc.x`。跟宿主内核版本不一致时，启动可能报 `1 required plugin did not activate`；
- 看到这句就把 profile 里的 `node_modules/@deepseek-ai` 整个删掉（或对齐到宿主版本）再重启。

`@deepseek-ai/cordis` 有时也会报 unmet peer（要 `~4.0.5`，装上的可能是 `4.1.0`）：插件自身不直接 import cordis，这条警告不影响安装和运行，**别为了消警告去删 lock 或降级**。

装完它还会自己补 `dsh.profile.bundles`、换压缩行（`replaceCompaction` 默认 true）、建 `worlds/<worldId>/`。安装与升级踩的坑见 [NOTES.md](NOTES.md)「安装与升级」。

### 卸载

1. 退出 DSH；
2. 从 profile 的 `dsh.profile.bundles` 里删掉 `dsh-world-bili`（**不能漏**，否则插件面板会以 `uninstall-blocked` 拒绝卸载）；
3. 从 `dependencies` 里删掉它，重装 profile 依赖（`node <DSH 自带 pnpm 的入口> install --ignore-scripts`）；
4. 世界数据在 `<DSH_HOME>/worlds/<worldId>/`，卸载不会删；要清就手动删。

---

## 配置

配置写在 profile 的 `cordis.patch.yml`。下面是一份**占位符**示例，把 `<...>` 换成你自己的值：

```yaml
- id: dsh-world-bili
  name: dsh-world-bili
  config:
    companionName: '<她的名字>'
    partnerName: '<你的称呼>'
    worldId: 'default'
    agentPreset: 'standard'
    timeZone: 'Asia/Shanghai'
    life: true
    archiveScope: 'workspace'
    replaceCompaction: true
    fallbackWakeTime: '09:00'

    dailyBili:
      enabled: false            # 先关着；配好 cookie 再开
      dailyTime: '20:00'        # 只作为工具链异常时的兜底
      dailyMaxVideos: 10
      allowWrite: false         # 真发总开关，确认后再改 true
      ownerQQ: ''               # 可选，摘要发到这个 QQ
# qq部分与dsh-world         
   qqNative:                    # 插件自己连 OneBot（原生通道）；不写这一块就是不接 QQ
      enabled: false             # 打开通道：连上、控制台里出 QQ 卡
      wsUrl: ws://127.0.0.1:3003 # OneBot 的 WS 服务地址（不是 HTTP 那个）
      accessToken: ''            # OneBot WS 服务端自己的 token，与 HTTP 那份不是一码事
      allowPrivate: []           # 谁能私聊她；留空 = 谁都不理
      ownerQQ: ''                # 她自己开口的话推给谁；空着取 allowPrivate 的第一个
```

完整字段见 [docs-md/CONFIG-REFERENCE.md](https://github.com/lmlmlml717/dsh-dafeiyu-biliWorld/blob/main/docs-md/PARAMETERS.md)。

### B 站 Cookie

世界数据目录下：

```
<DSH_HOME>/worlds/<worldId>/bili/credentials.json
```
```json
{ "SESSDATA": "<浏览器 Cookie>", "bili_jct": "<CSRF token>", "buvid3": "<buvid3>" }
```

也可以在控制台「B站 → Cookie 凭据」里粘贴。**Cookie 等同账号密码，不要提交到 git。**

### 先干跑，再真发

- `bili.config.json` 的 `guard.dryRun` 默认 `true`：只打印，不真发。
- 主配置 `dailyBili.allowWrite` 默认 `false`：即使 `dryRun` 关了，也不会对外写。
- 两处都确认后，再打开真发。

---

## 常用命令

```bash
# 自检：凭据、登录态、API、干跑状态
node tools/bili.mjs deps

# 抓候选视频
node tools/bili.mjs feed --json

# 深读一条视频
node tools/bili.mjs debrief --bvid BV1xxxxxxxxx

# 转发到动态（先干跑，确认后加 --go）
node tools/bili.mjs act dyn --bvid BV1xxxxxxxxx --text "配文" --score 17
node tools/bili.mjs act dyn --bvid BV1xxxxxxxxx --text "配文" --score 17 --go

# 转发的同时评论
node tools/bili.mjs act dyn --bvid BV1xxxxxxxxx --text "配文" --score 17 --go --also-comment
```

命令细节见 `node tools/bili.mjs --help` 和 [docs-md/PARAMETERS.md](docs-md/PARAMETERS.md)。

---

## 目录结构

```
src/                 # 宿主侧：世界、记忆、生活线、压缩、控制台路由、B 站定时
client/index.js      # 控制台前端（DSH 直接加载，不是构建产物）
tools/               # B 站 CLI 运行时（bili.mjs、lib/*.mjs、commands/*）
templates/           # 内置世界提示词模板
scripts/             # 打包、更新、贴纸导入等脚本
tests/               # Node 回归测试（TS/JS）
docs-md/             # 公开文档
cordis.patch.yml     # bundle 自带的插入行
```

---

## 开发与测试

```bash
npm run typecheck   # tsc --noEmit
npm test            # Node 回归测试（TS/JS，不联网）
npm run build       # 清空 lib/ 后 tsc -p tsconfig.build.json
npm run test:package
```

---

## 许可与致谢

MIT，见 [LICENSE](LICENSE)。版权与思路来自 dsh-world、dsh-feiyu、dsh-bili-whale、PiliPlus 等上游项目；这个仓库只保留 B 站特化与整合部分的改动。
