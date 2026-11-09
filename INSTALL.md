# 安装 dsh-world-bili

## 目前直接下载tgz包，复制路径安装就行

> 这是**插件**的安装说明。配置项总表见 [docs-md/PARAMETERS.md](docs-md/PARAMETERS.md)（随包附带）；打包、分发、升级、卸载和排障见仓库里的 [docs-md/DISTRIBUTION.md](https://github.com/lmlmlml717/dsh-dafeiyu-biliWorld/blob/main/docs-md/DISTRIBUTION.md)。

## 前置

| 要知道的 | 怎么查 |
| --- | --- |
| `DSH_HOME` | Windows 默认 `C:\Users\<用户名>\.dsh`；里面应有 `profiles`、`worlds` |
| DSH 版本 | 插件声明 `dsh >=0.2.1-rc.2 <0.3.0-0`。宿主升到 0.3 后安装会被直接拒绝，要等插件跟着发版；0.2.x 里以 `0.2.2-rc.1` 测试通过 |
| 用哪个 profile | 列 `<DSH_HOME>/profiles/`，挑 `package.json` 里正在用的那个（通常是 `desktop`） |
| Node 版本 | `node -v`，需要 ≥ 22.16；也可以用 DSH 自带运行时 |
| pnpm | 优先用 DSH 自带的 `<DSH 安装目录>/resources/runtime/.../pnpm`；不要依赖全局 pnpm 版本 |

## 第一步：装进 profile

### 用 tgz（推荐）

```bash
cd <DSH_HOME>/profiles/<你的 profile>
node <DSH 自带 pnpm 的入口> add <dsh-world-bili-0.9.2.tgz 的绝对路径> --ignore-scripts
```

pnpm 会顺带补一套 `@deepseek-ai/dsh-*` 到 `0.2.1-rc.5`，并报 `unmet peer @deepseek-ai/cordis`（装的是 4.1.0，那批包要 `~4.0.5`）。退出码仍是 0，属正常，不要为消警告去删 lock 或降级；细节见 README「装 tgz 时会自动补一套 DSH 内部包」。

然后在 profile 的 `package.json` 里确认：

```json
"dsh": { "profile": { "bundles": ["dsh-world-bili"] } }
```

**必须**手动加进 `bundles`（数组）。漏了这一步包是装上了，但插件不会加载，控制台里什么都看不到。**退出 DSH 再装/改，装完重启 DSH。**

### 用源码 link（开发）

```bash
cd <DSH_HOME>/profiles/<你的 profile>
node <DSH 自带 pnpm 的入口> add "link:<本仓库绝对路径>" --ignore-scripts
```

改 `src/**` 后：

```bash
npm run build     # 重新生成 lib/
```

再重启 DSH。只改 `client/index.js` 或 `tools/**` 时，通常刷新页面/下次命令即可。

> 分发给别人时不要用 `link:` 指向带 `@deepseek-ai` 依赖的源码目录，否则会报 `1 required plugin did not activate`；发 tgz。

## 第二步：配置

在 profile 的 `cordis.patch.yml` 末尾加一条（字段按需，`<...>` 换成你的值）：

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
```

保存后重启 DSH。控制台「概览」应能看到这个世界；第一次启动会在 `<DSH_HOME>/worlds/<worldId>/` 建目录。

B 站定时（先别开真发）：

```yaml
    dailyBili:
      enabled: true
      dailyTime: '20:00'
      dailyMaxVideos: 10
      allowWrite: false
```

QQ（可选，默认关）：

```yaml
    qqNative:
      enabled: true
      wsUrl: 'ws://127.0.0.1:3001'
      accessToken: '<SnowLuma WS 服务端的 token>'
      allowPrivate: ['<你的 QQ>']
      allowGroups: ['<群号>']
      ownerQQ: '<你的 QQ>'
      snowlumaHome: '<SnowLuma 安装目录>'
      supervise: false
```

## 第三步：B 站 Cookie

在控制台「B站 → Cookie 凭据」里粘贴，或直接写文件：

```
<DSH_HOME>/worlds/<worldId>/bili/credentials.json
```

```json
{ "SESSDATA": "<浏览器 Cookie>", "bili_jct": "<CSRF token>", "buvid3": "<buvid3>" }
```

验证：

```bash
node tools/bili.mjs deps
```

应显示登录态 OK（`mid=...`、`nick=...`）。**Cookie 等同账号密码，不要提交、不要发到群里。**

## 第四步：QQ（可选）

QQ 登录和 OneBot 服务由外部的 **SnowLuma** 提供，插件不代替它登录：

1. 按 SnowLuma 自己的说明安装、启动并扫码登录 QQ；
2. 在它的 `config/onebot_<QQ号>.json` 里确认 WebSocket 服务端口与 token；
3. 把端口/token 填进上面的 `qqNative`；
4. 回到控制台打开 QQ 开关。

首次开启时如果缺 `@snowluma/sdk`，插件会用宿主包管理器按需安装（禁用安装脚本），完成后提示重启 DSH。SnowLuma SDK 对 Node 版本有要求；不满足时按其提示升级 Node。

## 第五步：微信（可选）

微信走独立的 Windows 适配器，需要 Python 3.11。步骤和许可说明见 `src/ecosystem/wechat/windows/README.md`；默认关闭，不影响 B 站和 QQ。

## 验证清单

- [ ] 控制台「概览」显示世界正在运行；
- [ ] `node tools/bili.mjs deps` 登录态 OK；
- [ ] `node tools/bili.mjs feed --json` 能返回视频；
- [ ] 定时器卡片显示下一次触发时间；
- [ ] QQ/微信开关状态与配置一致；
- [ ] 先干跑一条 `act dyn`，确认文案后再 `--go`。

## 从源码构建

```bash
git clone https://github.com/lmlmlml717/dsh-dafeiyu-biliWorld.git
cd dsh-dafeiyu-biliWorld
npm ci
npm run typecheck
npm test
npm run build
npm pack
```

产物是 `dsh-world-bili-<版本>.tgz`，按「第一步」装进 profile。`lib/` 是构建产物，不进 git。

## 卸载

1. 退出 DSH；
2. 从 profile 的 `dsh.profile.bundles` 里删掉 `dsh-world-bili`；
3. 从 `dependencies` 里删掉它并重装 profile 依赖；
4. 世界数据在 `<DSH_HOME>/worlds/<worldId>/`，按需保留或删除（删了就不可恢复）。

如果 `cordis.patch.yml` 里有手写的 `- insert: dsh-world-bili`，先删掉，否则插件面板会以 `uninstall-blocked` 拒绝卸载。
