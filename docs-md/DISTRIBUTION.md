# 分发指南：把 dsh-world-bili 交给别人用

> 适用版本：0.8.8（写这份文档时的版本；命令里的 `<版本>` 换成实际版本即可）
> 读者：你（分发者）和对方（接收者）
> 相关文档：[INSTALL.md](../INSTALL.md)（安装细节）、[CONFIG-REFERENCE.md](CONFIG-REFERENCE.md)（配置项全表）、[NOTES.md](../NOTES.md)（行为说明）

---

## 0. 先选一种分发方式

| 方式 | 适合谁 | 对方要做什么 | 你要给什么 |
| --- | --- | --- | --- |
| **Git 仓库** | 会写代码、要跟着改的人 | `git clone` → `npm ci` → `npm run build` → `npm pack` → 装 tgz → 注册进 profile | 仓库地址（或对方能访问的 git） |
| **npm 包（tgz）** | 只想用、不想构建的人 | 把 tgz 装进 profile → 重启 → 配 cookie/QQ | `npm pack` 出来的 `dsh-world-bili-<版本>.tgz` |
| **源码 zip** | 没有 git、但能跑命令的人 | 解压 → `npm ci` → `npm run build` → `npm pack` → 装 tgz | 一个排除了 `node_modules`/`lib`/`.git` 的 zip |

三种方式**对方最终都要做同一件事**：让插件出现在 DSH profile 的 `dsh.profile.bundles` 里。
注意：**不要让对方把 `link:` 直接指向带 `node_modules/@deepseek-ai` 的源码目录**（原因见 3.4）。

---

## 1. 上传到 Git：提交什么、不提交什么

### 1.1 必须进 git 的（仓库里已经在跟踪，照常提交）

```
package.json          package-lock.json        pnpm-lock.yaml        pnpm-workspace.yaml
tsconfig.json         tsconfig.build.json      cordis.patch.yml
client/               src/                     tools/                templates/
scripts/              tests/                   .github/              docs-md/
README.md  INSTALL.md  NOTES.md  CHANGELOG.md  CONTRIBUTING.md  LICENSE
.gitignore  .gitattributes  .dockerignore
```

关键点：

- **`tools/` 必须提交**（32 个文件）。它是 B 站 CLI 的运行时（`tools/bili.mjs`、`tools/lib/*.mjs`），
  打包时 `files` 字段也把它算进去了；漏了它对方一跑 B 站就 `MODULE_NOT_FOUND`。
- **`client/index.js` 必须提交**。它不是构建产物，DSH 直接加载这一份；改前端就是改它。
- **`cordis.patch.yml` 必须提交**。它是 bundle 自带的 patch（`- insert: - id: dsh-world-bili`），
  对方把包加进 `bundles` 后，这一行由宿主自动插进配置树。
- **`docs-md/`** 是公开文档；`docs/` 是本地设计笔记/排障记录，不进公开仓库。

### 1.2 绝对不要进 git 的

| 路径 | 原因 |
| --- | --- |
| `node_modules/` | 依赖，对方自己装；体积大 |
| `lib/` | TypeScript 构建产物；对方 `npm run build` 生成（已在 `.gitignore`） |
| `artifacts/`、`*.tgz` | 打包产物，不进源码仓库 |
| `.host/`、`room/`、`.trae/`、`.agents/skills/...` | 本地脚手架/个人目录 |
| `~/.dsh` 里任何东西 | 见下 |

**真正会泄密的是“运行数据”，不是仓库里的源码**，这些永远不要提交、也不要去 `.dsh` 以外：

- `profiles/<name>/cordis.patch.yml` 里你自己填的 `accessToken`、`ownerQQ`、`snowLuma` 路径；
- `worlds/<id>/bili/credentials.json`（SESSDATA / bili_jct / buvid3）；
- `worlds/<id>/` 整个目录（归档、日记、相册、聊天记录）；
- `~/.dsh/logs/*.log`（含个人路径、会话内容）；
- SnowLuma 的 `config/onebot_<QQ号>.json`（accessToken）。

提交前跑一遍（本仓库实测干净，但每次发版都建议跑）：

```powershell
cd <repo>
# 1) 看看有哪些文件会被提交
git status --short

# 2) 扫一遍真实密钥/QQ号/本机用户名（有命中就人工确认，别把实际值写进仓库）
$bad = git ls-files | Where-Object { Test-Path $_ } |
  Select-String -Pattern 'accessToken\s*:\s*[''"]\w{16,}|ownerQQ\s*:\s*[''"]?\d{5,}|SESSDATA\s*[:=]\s*[''"]\w{16,}|C:\\Users\\(?!<)' -List
if ($bad) { $bad | ForEach-Object { "命中：$($_.Filename):$($_.LineNumber)" } } else { '没有发现个人凭据' }

# 3) 确认忽略规则仍然生效
git check-ignore -v node_modules lib artifacts 2>$null
```

### 1.3 发版建议

1. 改 `package.json` 的 `version`（语义化版本，例如 0.8.8 → 0.8.9）；
2. 在 `CHANGELOG.md` 顶部加一节；
3. 跑验收（见第 6 节），再 `git tag v<版本> && git push --tags`；
4. 仓库里**不要**提交 `lib/`——对方 `npm ci && npm run build` 自己生成。

---

## 2. 打压缩包：两种形态

### 2.1 给开发者：源码 zip

排除 `node_modules`、`lib`、`artifacts`、`*.tgz`、`.git`、`room`、`.host`，其余全带：

```powershell
cd <repo>
$src = 'dsh-world-bili'
$dst = "dsh-world-bili-src-$(Get-Date -Format yyyyMMdd).zip"
# 用 git archive 最省事：只会包含已提交的文件（自动排除 .gitignore 里的东西）
git -C $src archive --format=zip --prefix=dsh-world-bili/ -o "..\$dst" HEAD
"$dst  $([math]::Round((Get-Item $dst).Length/1MB,2)) MB"
```

对方解压后：`npm ci --ignore-scripts` → `npm run build` → `npm pack` → 按第 3 节装 tgz。

### 2.2 给普通用户：成品 tgz（推荐）

```powershell
cd <repo>
npm ci --ignore-scripts        # 首次需要
npm run build                  # 生成 lib/
npm pack                       # 会先跑 prepack（typecheck + build），再按 files 字段打包
# 产物：dsh-world-bili-<版本>.tgz
```

`npm pack` 只会带 `files` 字段列出的东西：

```
lib/            ← 编译后的入口（main: lib/index.js）
client/         ← 前端（client/index.js）
tools/          ← B 站 CLI 运行时（必须）
templates/      ← 世界提示词/记忆模板
src/ecosystem/wechat/windows/   ← 微信适配器（Python）
cordis.patch.yml                ← bundle 自带的 insert 行
README.md INSTALL.md NOTES.md CHANGELOG.md CONTRIBUTING.md
assets/（如果存在）
scripts/enable-tool-free-compaction.ps1、repair-profile-patch.mjs、update-world.mjs、
scripts/import-stickers.mjs、scripts/compact-home.mjs
```

**不要**手动往 zip 里塞 `node_modules`：对方装的时候由 pnpm/npm 解析 `ws` 等依赖；塞进去反而会因为
平台/链接布局不同出问题。

### 2.3 手动 zip 成品目录时至少要有什么

如果不用 `npm pack`，自己压目录，最少保留：

```
package.json  lib/  client/  tools/  templates/  cordis.patch.yml  README.md  INSTALL.md  LICENSE
```

少了 `lib/` → 对方 import 报 `ERR_MODULE_NOT_FOUND`；少了 `tools/` → B 站 CLI 起不来；
少了 `templates/` → 世界提示词/记忆模板回落到插件内置（能跑，但少模板）。

---

## 3. 对方怎么装（三种来源，同一套注册步骤）

### 3.0 前置检查

| 项 | 要求 | 怎么查 |
| --- | --- | --- |
| DSH 版本 | `>=0.2.1-rc.2 <0.3.0-0`（`package.json` 的 `engines.dsh`；0.2.2-rc.1 实测可用） | DSH 设置 → 关于；或看 `~/.dsh/logs/desktop-next.log` 的 `run.start` |
| Node（仅“自己构建”时需要） | `>=22.16.0` | `node -v` |
| 磁盘 | 源码+依赖约 300 MB；成品包约 1 MB | — |

### 3.1 推荐：装 `npm pack` 出来的 tgz

> 为什么不用 `link:` 指向源码目录：源码目录里通常有 `node_modules/@deepseek-ai/*`（构建用的核心包）。
> 一旦用 `link:` 或直接指向目录，宿主可能优先解析到那套旧核心包，然后把整排核心插件禁用，
> 启动报 `1 required plugin did not activate`。**分发一律走 tgz。**

1. 对方拿到 `dsh-world-bili-<版本>.tgz`；
2. DSH → 设置 → 插件（市场/插件管理）→ 安装本地插件，选这个 tgz（等价于 `pnpm add file:<tgz>`）；
3. DSH 会往 profile 的 `package.json` 写依赖、往 `dsh.profile.bundles` 加 `dsh-world-bili`；
4. 重启 DSH。

> 面板不可用（版本差异）时，用 3.2 手写，效果一样。

### 3.2 手动注册（最可靠，任何版本都能用）

设 profile 目录为 `%USERPROFILE%\.dsh\profiles\desktop`。

**① 加依赖**（`package.json`，用 tgz 的绝对路径）：

```json
{
  "dependencies": {
    "dsh-world-bili": "file:D:/packages/dsh-world-bili-0.8.8.tgz"
  }
}
```

> 只有在你确认源码目录里**没有** `node_modules/@deepseek-ai`（或版本与宿主完全一致）时，
> 才可以用 `"link:D:/plugins/dsh-world-bili"` 做本地开发；否则会把旧核心包投影进 profile。
> 本地开发更方便的做法见 3.4。

**② 加进 bundles**（同一个 `package.json`）：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-world-bili"]
    }
  }
}
```

**③ 装依赖**（在 profile 目录里，用 DSH 自己的 pnpm 版本最稳）：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
npx -y pnpm@11.28.5 install --ignore-scripts
```

**④ 不要手写 `- insert:`**。插件是 profile bundle，`bundles` 里一出现，宿主会自动把包内
`cordis.patch.yml` 的 `- insert:` 合进配置树。手写一份反而会导致配置编辑器保存时报
`overridden`，卸载时也可能被拦（`uninstall-blocked … still inserts`）。

**⑤ 重启 DSH**。启动日志里应出现：

```
[info] host.start.complete ...
[info] ... dsh-world-bili ...
```

插件列表里能看到 `include:dsh-world-bili`、状态 `active`。

### 3.3 首次启动它会自己做的事

- 把 `dsh-world-bili` 补进 `dsh.profile.bundles`（已在就跳过）；
- 如果 profile 能解析到包，但 bundles 里没有 → 补上（解析不到就什么都不写，只记 warning）；
- **压缩替换**：桌面版会把整个 standard 预设抄进 profile、只把 `compaction-basic` 换成
  `dsh-world-bili/compaction`（`replaceCompaction` 默认 true；不想要就按 4.4 关掉）；
- 建世界目录 `~/.dsh/worlds/<worldId>/`（默认 `default`）。

### 3.4 本地开发（自己改代码时）

分发一律走 tgz；开发时想“改完就生效”，推荐两种方式：

**A. 改前端 / CLI（不用重装）**

`client/index.js` 和 `tools/*.mjs` 不是构建产物。改完后把这两个文件复制进已安装的插件目录
（默认 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-world-bili\` 下的 `client/`、`tools/`），
刷新页面 / 下次跑命令即生效，不用重启。

**B. 改 `src/`（要重新构建，建议走 tgz）**

```powershell
cd <repo>
npm run build
npm pack
cd "$env:USERPROFILE\.dsh\profiles\desktop"
npx -y pnpm@11.28.5 add "file:<仓库目录>/dsh-world-bili-<版本>.tgz" --ignore-scripts --config.engine-strict=false
# 重启 DSH
```

这样源码目录的 `node_modules` 完全不参与解析，不会把 `@deepseek-ai` 旧核心包装进 profile。

**关于直接 `link:` 源码目录**：只有当源码目录的 `node_modules` 里**没有** `@deepseek-ai/*` 时才是安全的
（例如只装生产依赖：`npm ci --omit=dev` 只装 `ws`）。否则宿主会优先解析到源码目录里的核心包，
出现 `1 required plugin did not activate`，排查方法：

```powershell
# profile 里不应出现核心包副本
Get-ChildItem "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@deepseek-ai" -ErrorAction SilentlyContinue
```

---

## 4. 对方接到后要配什么

### 4.1 最小可用配置（`cordis.patch.yml`）

在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` **末尾**追加（顶层必须是列表）：

```yaml
- id: dsh-world-bili
  name: dsh-world-bili
  config:
    companionName: '<她的名字>'        # 换成她的名字
    partnerName: '你'            # 她怎么称呼对方
    worldId: 'default'           # 世界 id；换一个就是另一个世界（各自的 worlds/<id>）
    agentPreset: 'standard'      # 用哪个 DSH 预设
    timeZone: 'Asia/Shanghai'
    life: true                   # 生活线（回顾、闹钟、日记）
    archiveScope: 'workspace'    # 记忆归档范围：home / workspace
    replaceCompaction: true      # 是否换成“只留对话”的压缩
    fallbackWakeTime: '09:00'
```

改完重启。配置项全表见 [CONFIG-REFERENCE.md](CONFIG-REFERENCE.md)。

### 4.2 人设与世界提示词（可选但强烈建议）

- 人设：`~/.dsh/worlds/<worldId>/persona.md`（Markdown 的 `## 名字` 等分节；控制台「人设」页也能改）；
- 世界提示词：`~/.dsh/worlds/<worldId>/world-prompt.md`。**有这个文件就整份替换插件内置模板**，
  所以要么不写（用模板），要么把模板整份复制过来再加自己的段落；
- 「我是谁」：`worlds/<worldId>/room/我是谁.md`，由她自己维护。

### 4.3 B 站（dailyBili）

1. 配置里打开：

```yaml
    dailyBili:
      enabled: true
      dailyTime: '20:00'
      dailyMaxVideos: 10
      allowWrite: false          # 先干跑；确认后再改 true
      ownerQQ: '<对方 QQ>'       # 可选，用 QQ 通知结果
      napcatHttp: 'http://127.0.0.1:3000'   # 可选，SnowLuma/NapCat 的 OneBot HTTP
```

2. **Cookie 必须由对方自己提供**（你不能替他登录，也不该把你的 cookie 发过去）：

   - 路径：`~/.dsh/worlds/<worldId>/bili/credentials.json`
   - 格式（字段名大写 `SESSDATA`）：

   ```json
   { "SESSDATA": "…含 %2C 的一长串…", "bili_jct": "32 位", "buvid3": "…" }
   ```

   - 来源：浏览器登录 B 站 → F12 → Application → Cookies → `bilibili.com`；
   - 或者在插件控制台「B站 → Cookie 凭据」三个输入框里粘贴保存（会写上面这个文件，权限 0600）；
   - 文件权限建议 0600；这个文件**永远不要提交/发群**。

3. 自检（在插件目录里）：

   ```powershell
   $env:WORLD_ID='default'
   node tools\bili.mjs deps        # 应显示：登录态 OK：mid=…，nick=…
   node tools\bili.mjs feed --json # 应返回 ok:true 和若干视频
   ```

   命令一览（0.8.8）：内置 `deps`（`selftest` 是别名）、`nav`；外部命令 `feed`、`debrief`、
   `act`（动态/转发/评论/弹幕/点赞/投币）、`comment`（顶层评论，0.8.7+）、`quota`、`focus`。

4. 如果对方希望她在聊天里也能用 B 站工具，需要给她的 `world-prompt.md` 加一节说明
   （工具路径、可用子命令、什么时候可以直接用），否则她只会用通用网页工具，容易撞验证码。

5. 评论/真发是三道闸叠加：主配置 `comment.enabled` → `dailyBili.allowWrite` → `bili.config.json`
   的 `guard.dryRun`；任何一道关着都只打印不真发。想让对方先跑一段干跑期，把 `allowWrite` 留 `false`。

### 4.4 压缩（可选关掉）

默认 `replaceCompaction: true`：桌面版第一次启动时，插件会把整个 standard 预设抄进 profile，只把压缩那一行
换成 `dsh-world-bili/compaction`，并在这行的 `config.toolFreeFor` 里写上**她的房间目录**
（`<DSH_HOME>\worlds\<worldId>\room`）。所以从 0.8.4 起：

- 只有她房间里的会话（家、房间、QQ/微信群会话）剔除工具调用后再摘要；
- 其它会话（比如 `default-workspace` 里写代码的）照常把工具调用与结果放进摘要，接近宿主原版行为；
- `toolFreeFor` 为空数组时是旧行为（所有会话都剔除）——旧版写下的预设行可能没有这个字段，升级后
  建议重新换一次压缩（见 6.3）。

不想让插件改 profile 的压缩就写 `replaceCompaction: false`：新世界不再抄预设。已经抄过的不会自动删，
要手动回退：删掉 `cordis.patch.yml` 里那条 `- id: preset-standard`（整份预设副本，唯一改动是压缩行），
或从同目录 `cordis.patch.yml.dsh-world.<hex>.bak` 恢复（注意别把后来加的配置行一起盖掉），再重启。

### 4.5 QQ（qqNative，可选）

前置：对方机器上装了 **SnowLuma**，并且已经扫码登录了 QQ、在 SnowLuma 里开了 OneBot 的 **WS 服务**。

1. 从 SnowLuma 的 `config\onebot_<QQ号>.json` 里拿 `wsServers[0]` 的 `port` 与 `accessToken`；
2. 配置：

```yaml
    qqNative:
      enabled: true
      wsUrl: 'ws://127.0.0.1:3001'          # 与 SnowLuma 的 ws 端口一致
      accessToken: '<SnowLuma 里那条 token>'
      allowPrivate: ['<对方 QQ>']            # 只回这些人
      allowGroups: ['<群号>']
      ownerQQ: '<对方 QQ>'
      autoReply: true
      groupTrigger: 'mention'                # 群里只接被 @/引用
      snowlumaHome: '<SnowLuma 安装目录>'
      supervise: false                       # 先 false：手动确认能开 3001 再考虑 true
```

3. **QQ SDK 必须装进 profile**（否则控制台切 QQ 会提示“QQ 依赖安装失败”）：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
npx -y pnpm@11.28.5 add @snowluma/sdk@2.2.1 --ignore-scripts --config.engine-strict=false
```

> 为什么要 `--config.engine-strict=false`：SDK 的 `engines.node` 要求 `^24.22.1 || >=26.12.1`，
> 而 DSH NEXT 自带 Node 常是 24.21.x，pnpm 默认会直接拒绝安装（`ERR_PNPM_UNSUPPORTED_ENGINE`）。
> 装 2.2.1（与插件开发时锁定的同一个版本）实测可用。

---

## 5. 对方收到后的验收清单

按顺序打勾，任何一步失败看第 6 节：

1. `include:dsh-world-bili` 在插件列表里、`fiberPhase: active`；
2. DSH 设置里能打开「世界控制台」（`ui-settings` 没被禁用；禁用时控制台入口也会消失）；
3. 控制台「概览」显示世界运行中；点「开始」后她有第一句话；
4. B 站页：`deps` 自检通过、`feed --json` 能出视频；
5. QQ 页：`online`（SnowLuma 必须在跑，3001 端口通）；
6. 心情页：数值能读、拖动条能拖、能保存；
7. `cordis.patch.yml` 里只有一条 `- id: dsh-world-bili`（没有重复的 `- insert:`）。

---

## 6. 故障排查

### 6.1 DSH 直接起不来（host-boot 失败）

看 `~/.dsh/logs/dsh-desktop-next-failure-*.log` 或 `desktop-next.log`：

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `YAMLException: end of the stream or a document separator is expected` | `cordis.patch.yml` 里出现两个 YAML 文档（典型：`[]` 后面又接 `- insert:`） | 删掉 `[]`，或让文件只有一个顶层列表；改前备份 |
| `YAMLException` + 缩进位置 | 手写配置缩进错、引号没闭合 | 用 YAML 校验（编辑器插件/在线校验）过一遍 |
| `patch.insert?.forEach is not a function` | 旧版（0.8.0/0.8.1）把 `insert` 写成了映射而不是列表 | `node node_modules/dsh-world-bili/scripts/repair-profile-patch.mjs`，然后重启 |
| `failed to parse overlay …` | profile 的 `package.json` 或 patch 文件坏了 | 从同目录 `.bak` 恢复；先保证 JSON/YAML 合法再启动 |

### 6.2 插件没加载 / 加载了但没反应

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 日志 `ERR_MODULE_NOT_FOUND: Cannot find package 'dsh-world-bili'` | 在 `bundles` 里但依赖没装/路径不对 | profile 里 `pnpm install`；确认 `node_modules/dsh-world-bili` 存在且能 `import` |
| 插件列表里没有 `include:dsh-world-bili` | 不在 `dsh.profile.bundles`，或 package.json 依赖没装 | 补 bundles + 装依赖，重启 |
| 列表里有但 `fiberPhase` 不是 active | 插件 apply 抛错 | 看日志里 `dsh-world-bili` 那几行；常见是配置 schema 校验失败（必填项/类型错） |
| 日志 `1 required plugin did not activate`，整排核心插件被禁用 | 用 `link:` 指向了带 `node_modules/@deepseek-ai` 的源码目录，旧核心包被投影进 profile | 改用 tgz 安装（见 3.4-B）；检查并清掉 `profiles\desktop\node_modules\@deepseek-ai`（如果被建出来了），重启 |
| 设置页看不到「世界控制台」 | profile 的 `- id: ui-settings` 被设成 `enabled: false` | 把该项改回 true（或删掉该覆盖），重启 |

### 6.3 压缩相关

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `compaction-basic (dsh-world/compaction): never started` | 预设里还是**旧包名** `dsh-world/compaction` | 改成 `dsh-world-bili/compaction`（新版会自动迁移文件，但要重启才生效） |
| `manual compaction could not produce a smaller summary: … no visible conversation remains` | 会话里只剩工具调用/注入块，没有可摘要的对话 | 0.8.2+ 已改为“无需压缩”，升级即可 |
| 控制台提示「自动压缩仍由预设自带…75% 触发线不生效」 | `replaceCompaction` 关着或没换上 | 想换就把 `replaceCompaction: true`，并确保 `cordis.patch.yml` 里没有手工的 `compaction-basic` 覆盖 |
| 第一次启动后 profile 里多出 160 多行 `preset-standard` | 桌面版压缩替换只能整份写预设 | 正常；不想保留见 4.4 |
| 写代码的会话压缩后丢了工具过程 | 预设行是 0.8.4 之前写的，没有 `toolFreeFor`（空数组 = 所有会话都剔除） | 删掉那条 `preset-standard`（先备份），再让插件重新换一次压缩；或升级后按 4.4 处理 |

### 6.4 QQ / SnowLuma

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 控制台切 QQ 报 `ERR_PNPM_UNSUPPORTED_ENGINE` | `@snowluma/sdk` 的 Node 版本要求高于 DSH 自带 Node | 按 4.5 第 3 步手动装 2.2.1（engine-strict=false） |
| 反复弹 `node.exe` 窗口 | `supervise: true`，看门狗每 30 秒探 `wsUrl` 端口，不通就再拉一个 SnowLuma；没登录 QQ 时 3001 永远不开 → 无限重拉 | 先把 `supervise` 改 `false` 重启；手动 `launcher.bat` 登录 QQ、确认 3001 通，再决定是否开回 |
| QQ 状态一直 `connecting` | wsUrl/端口/token 与 SnowLuma 不一致 | 对照 `config\onebot_<QQ>.json` 的 `wsServers`；注意 SnowLuma 多账号时只有一个账号的 ws 在跑 |
| 私聊不回 | `allowPrivate` 没包含对方 QQ，或 `autoReply: false` | 改配置；群里还要看 `groupTrigger` |

### 6.5 B 站

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `deps` 里 `✗ 登录态失效：code=-101` | cookie 过期/复制错/字段问题 | 控制台重新粘贴 SESSDATA/bili_jct/buvid3；确认 `SESSDATA` 是**大写字段**且含 `%2C` |
| `SyntaxError: Unexpected token ':'`（`cred.mjs`） | `.mjs` 里混进 TypeScript 语法 | 0.8.3 起已修；旧版把类型标注删掉 |
| `node tools/bili.mjs …` 报缺 cookie | 文件不在 `worlds/<worldId>/bili/credentials.json` | 检查 `WORLD_ID` 是否与配置的 `worldId` 一致 |
| 她说“视频看不了/被验证码拦” | 她在用通用网页工具，不是 B 站 CLI | 用 `bili.mjs debrief --bvid <BV>`；或在她的 `world-prompt.md` 里写清工具用法 |
| `act` 只打印不真发 | `bili.config.json` 的 `guard.dryRun` 为 true，或没带 `--go` | 控制台取消勾选「干跑模式」，或命令加 `--go` |
| 想发但发不出去（4100001 等） | B 站接口参数/风控 | 先干跑看 payload；详见 `docs-md/BILI-TOOLCHAIN-AUDIT-AND-FIX.md` |
| 命令跑完退出码 `-1073740791`，stderr 有 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` | 旧版 CLI 在 `fetch` 后立刻 `process.exit()`，Windows + Node 24 触发 libuv 断言（`deps`/`nav` 必崩，`act` 真发后也会崩） | 0.8.8 已改；升级后只剩正常退出码 |
| `feed --json` 的输出前多了一行提示，`JSON.parse` 失败 | 旧版把“去重”提示写进 stdout | 0.8.8 已把提示移到 stderr；或从输出里截取第一个 `{` 开始的部分 |
| 同一条视频被反复转发 / 日额度不生效 | 旧版账本去重与配额闸有缺口 | 0.8.6+ 已修；升级并清掉 `worlds/<id>/bili/cache` 里的旧去重状态再试 |

### 6.6 安装/卸载被拦

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `uninstall-blocked: … user cordis.patch.yml still inserts dsh-world-bili` | profile 里有一条手写的 `- insert: - id: dsh-world-bili` | 删掉那一段（0.8.7+ 自注册会自动清理旧装留下的重复行）；然后重试卸载 |
| `ERR_PNPM_UNEXPECTED_STORE` | profile 的 pnpm store 与面板 pnpm 不一致 | 用与 profile 同版本的 pnpm（`npx pnpm@11.28.5`）操作，或整份重装 profile 依赖 |
| 面板里一张插件卡都没有 | 面板前端/设置页问题（`ui-settings` 被禁用最常见） | 先恢复设置页，再重启 |

### 6.7 想重装/清干净

```powershell
$p = "$env:USERPROFILE\.dsh"
# 1) 停 DSH 后备份
Copy-Item "$p\profiles\desktop\package.json" "$p\profiles\desktop\package.json.bak" -Force
Copy-Item "$p\profiles\desktop\cordis.patch.yml" "$p\profiles\desktop\cordis.patch.yml.bak" -Force
# 2) 从 bundles 移除 dsh-world-bili、从 patch 删掉 - id: dsh-world-bili / - insert: 块
# 3) 删依赖与缓存（保留你自己的 worlds 数据！）
Remove-Item "$p\profiles\desktop\node_modules\dsh-world-bili" -Recurse -Force
Remove-Item "$p\profiles\desktop\.plugin-manager\logs" -Recurse -Force -ErrorAction SilentlyContinue
# 4) 重新按第 3 节安装
```

---

## 7. 安全与隐私（给对方看的）

- **不要**把 `worlds/`、`credentials.json`、`~/.dsh/logs`、SnowLuma 的 `onebot_*.json` 放进 git 或压缩包；
- B 站 cookie、QQ token 等同于账号密码：只存在对方自己的机器上，权限 0600；
- 世界里的一切（日记、相册、聊天原文）都是隐私数据，卸载插件不会自动删除，转手机器前自己确认；
- 插件是 MIT 许可，保留 `LICENSE`。

---

## 8. 附录：路径速查

| 东西 | 路径 |
| --- | --- |
| profile 配置 | `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` |
| profile 依赖/bundles | `%USERPROFILE%\.dsh\profiles\desktop\package.json` |
| 世界根目录 | `%USERPROFILE%\.dsh\worlds\<worldId>\` |
| 人设 | `worlds\<worldId>\persona.md` |
| 世界提示词（覆盖模板） | `worlds\<worldId>\world-prompt.md` |
| “我是谁” | `worlds\<worldId>\room\我是谁.md` |
| B 站配置 | `worlds\<worldId>\bili.config.json` |
| B 站凭据 | `worlds\<worldId>\bili\credentials.json` |
| B 站 CLI | `<插件目录>\tools\bili.mjs` |
| 压缩替换备份 | `profiles\desktop\cordis.patch.yml.dsh-world.<hex>.bak` |
| DSH 日志 | `%USERPROFILE%\.dsh\logs\`（失败启动另有 `dsh-desktop-next-failure-*.log`） |
