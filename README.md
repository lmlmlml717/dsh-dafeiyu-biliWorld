# dsh-dafeiyu-biliWorld

> 给 [DSH](https://github.com/deepseek-ai) DeepSeek Harness 的一个「世界 + B 站自动化」
> 加了评论发布、动态发布、视频转发
> 当前版本 **0.8.10** · 基于 **dsh-world**，融合 **dsh-feiyu** 的评论链路与 **dsh-bili-whale** 的 B 站工具链/调度设计。
## 太厉害啦DeepSeek大人  与[dsh-world](https://github.com/chenkezhen480/dsh-world)不兼容（大概，我也没试过，这篇md都是DeepSeek大人写的
[![release](https://img.shields.io/github/v/release/lmlmlml717/dsh-dafeiyu-biliWorld)](https://github.com/lmlmlml717/dsh-dafeiyu-biliWorld/releases/latest)
---
<img width="350" height="350" alt="image" src="https://github.com/user-attachments/assets/767d0883-9993-44d5-ab08-fa2403db3015" />
<img width="350" height="350" alt="image" src="https://github.com/user-attachments/assets/6dc2f239-c8bf-4463-8697-26c41d1cde59" />
<img width="350" height="350" alt="image" src="https://github.com/user-attachments/assets/48763b43-8835-4cca-9ab4-0312184b4529" />



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

### 方式一：装打包好的 tgz（推荐给使用者）

```bash
git clone https://github.com/lmlmlml717/dsh-dafeiyu-biliWorld.git
cd dsh-dafeiyu-biliWorld

npm ci
npm run build
npm pack          # 产出 dsh-world-bili-0.8.10.tgz
```

退出 DSH，把 tgz 装进你的 profile：

```bash
cd <DSH_HOME>/profiles/<你的 profile>
node <DSH 自带 pnpm 的入口> add <tgz 的绝对路径> --ignore-scripts
```

确认 profile 的 `package.json` 里 `dsh.profile.bundles` 含 `dsh-world-bili`，然后重启 DSH。也可以在 DSH 的插件面板里直接安装这个 tgz。

### 方式二：开发时用 link

```bash
cd <DSH_HOME>/profiles/<你的 profile>
node <DSH 自带 pnpm 的入口> add "link:<本仓库绝对路径>" --ignore-scripts
```

改 `src/**` 后要 `npm run build` 并重启 DSH；改 `client/index.js`、`tools/**` 一般刷新页面/下次命令即可。

> ⚠️ 分发时不要把 `link:` 指向带 `@deepseek-ai` 依赖的源码目录，否则对方会报 `1 required plugin did not activate`。给对方发 tgz。

更细的安装、升级、卸载与排障见 [docs-md/DISTRIBUTION.md](docs-md/DISTRIBUTION.md) 和 [INSTALL.md](INSTALL.md)。

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
      napcatHttp: 'http://127.0.0.1:3000'
      ownerQQ: ''               # 可选，摘要发到这个 QQ

    qqNative:
      enabled: false
      wsUrl: 'ws://127.0.0.1:3001'
      accessToken: ''           # SnowLuma 的 WS 服务端 token
      allowPrivate: []          # 允许私聊的 QQ
      allowGroups: []           # 允许的群
      ownerQQ: ''
      snowlumaHome: ''          # SnowLuma 安装目录
      supervise: false
```

完整字段见 [docs-md/CONFIG-REFERENCE.md](docs-md/CONFIG-REFERENCE.md)。

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

命令细节见 `node tools/bili.mjs --help` 和 [docs-md/DISTRIBUTION.md](docs-md/DISTRIBUTION.md)。

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
npm test            # 592 条 Node 回归测试
npm run build       # 清空 lib/ 后 tsc -p tsconfig.build.json
npm run test:package
```

- 测试里不联网、不发真实内容；B 站/QQ 的写操作都有 fake transport 或闸门。
- 微信适配器另有 Python 离线测试，见 `src/ecosystem/wechat/windows/README.md`。


---

## 许可与致谢

MIT，见 [LICENSE](LICENSE)。版权与思路来自 dsh-world、dsh-feiyu、dsh-bili-whale、PiliPlus 等上游项目；这个仓库只保留 B 站特化与整合部分的改动。
