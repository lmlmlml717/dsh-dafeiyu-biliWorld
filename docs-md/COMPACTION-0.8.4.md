# 压缩作用域改造：只给她的会话「只留对话」（0.8.4）

> 适用版本：dsh-world-bili **0.8.4**（DSH 0.2.2-rc.1 / 桌面版 2.0.22-next）
> 相关代码：`src/compaction.ts`、`src/compactionSwap.ts`、`src/index.ts`
> 相关配置：`~\.dsh\profiles\desktop\cordis.patch.yml`
> 本文记录：为什么要改 → 三种方案怎么选 → 新机制怎么工作 → 改了哪些代码 → 怎么验证 / 回退 / 排错

---

## 1. 一句话

把「压缩时剔除工具调用」从**预设级**（影响整个 profile）下沉到**会话级**：只有工作目录在她的房间
（`<DSH_HOME>\worlds\<id>\room`）里的会话才走「只留对话」；写代码等其它会话照常把工具调用与结果放进摘要，
接近宿主原版行为。

不配置这个新选项时，行为与 0.8.x 完全一致。

---

## 2. 背景：为什么会有这个问题

### 2.1 压缩引擎挂在预设里

DSH 桌面版把压缩插件放在每个**预设**（`preset-standard`）的隔离组里：

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate: { compaction: true, toolResultPruner: true }
  config:
    - id: compaction-basic
      name: dsh-world-bili/compaction   # ← 插件换掉了宿主原版
```

一个预设是全 profile 共用的：**任何使用 standard 预设的会话**——她的家、房间、QQ/微信群，以及你在
`default-workspace` 里写代码的窗口——都跑同一个压缩引擎。没有「只对这个会话生效」的开关。

### 2.2 插件怎么换掉的

插件第一次在某个世界启动时执行一次「压缩迁移」（`replaceCompaction`，默认开）：

- 经典宿主：直接改 `cordis.patch.yml` 里 `compaction-basic` 那一行的 `name`；
- 桌面版：profile 里没有那一行（它在预设组内，按 id 改不到，会报 `entry "compaction" not found`），
  于是调用 DSH 自己的配置编辑服务，把**整个预设**写进 profile，只改压缩那一行。

写之前留 `.dsh-world.<hex>.bak`，写完把 `compactionSwapped: true` 记进 `worlds\<id>\world.json`，
每个世界只做一次。

### 2.3 两个真实事故（决定了后面的约束）

| 事故 | 现象 | 根因 |
| --- | --- | --- |
| 旧包名 | 会话报 `compaction-basic (dsh-world/compaction): never started` | 包已改名 `dsh-world-bili`，预设副本里仍是旧名，解析不到包 |
| 工具丢失 | 写代码的会话压缩后不记得跑过什么命令 | 「只留对话」把 tool-call / tool-result 全部剔除，而它作用于整个 profile |

第一个事故在 0.8.1 修好（改名 + 自动迁移）。第二个事故就是本文要解决的：**功能想留，但不要影响代码会话**。

### 2.4 为什么不能「给她单独建一个预设」

会话属于谁的判定是：

```ts
// src/sourceArchive.ts
export function belongsToWorld(session, config) {
  return session.header.agentPreset === config.agentPreset && isOrdinarySession(session.header);
}
```

**预设名就是她的会话身份**。把 `agentPreset` 从 `standard` 改成 `world`：

- 她已有的家/房间/频道会话都是用 `standard` 创建的 → 立刻被判成「不在她的世界」：人设、记忆、归档、世界工具全部失效；
- 只有新创建的会话才带 `world`。

所以「换预设」不是配置问题，是要重建她所有会话；这不是兼容做法。

---

## 3. 方案对比

| 方案 | 做法 | 保留功能 | 影响代码会话 | 破坏会话身份 | 结论 |
| --- | --- | --- | --- | --- | --- |
| A 现状 | 保持 profile 级预设副本 | ✅ | ❌ 工具过程被剔除 | 否 | 可用但不理想 |
| B 专属预设 | 新建 `world` 预设 + `agentPreset: world` | ✅ | ✅ | **是**（旧会话出界） | 需要重建会话，代价大 |
| C 关掉 | `replaceCompaction: false` + 删预设副本 | ❌ | ✅（原版压缩） | 否 | 不满足「保留功能」 |
| **D 按会话分流（采用）** | 引擎内部按 `cwd` 判断 | ✅ | ✅（接近原版） | 否 | **本次实现** |

D 的关键：预设不变、`agentPreset` 不变、会话身份不变，只让引擎在每次摘要前多看一个条件。

---

## 4. 新机制怎么工作

### 4.1 配置项

压缩插件新增配置：

```ts
export interface ToolFreeCompactionConfig {
  // ...
  /** 只在这些目录下的会话里剔除工具调用；留空＝所有会话都剔除（旧行为）。 */
  toolFreeFor?: string[];
}
```

它写在**压缩那一行**的 `config` 里：

```yaml
- id: compaction-basic
  name: dsh-world-bili/compaction
  config:
    toolFreeFor:
      - 'C:\Users\<你>\.dsh\worlds\default\room'
```

### 4.2 判定规则

```ts
const toolFree = this.toolFreeFor.length === 0
  || underAny(agent.session.header.cwd, this.toolFreeFor);
const visible = toolFreeMessages(messages);
const replayed = toolFree ? visible : messages;   // 工具过程保留 / 剔除
```

`underAny` 的匹配规则（避免路径写法差异导致误判）：

- 反斜杠与正斜杠等价；
- 大小写不敏感（Windows 盘符/目录）；
- 末尾斜杠忽略；
- 必须是**同一目录或以它开头**（`C:\a\room` 命中 `C:\a\room`、`C:\a\room\sub`，不命中 `C:\a\room2`）。

### 4.3 行为矩阵

| 会话 cwd | 压缩时 | 压缩后上下文 |
| --- | --- | --- |
| `…\worlds\default\room`（家、房间、QQ/微信群） | 剔除 tool-call / tool-result，只摘要对话 | 没有工具尾巴（原功能） |
| `…\default-workspace`、`<你的工作区>\…` | 工具调用与结果照常进摘要 | 保留「跑过什么、读过什么」的信息 |
| 没有配置 `toolFreeFor` | 所有会话都剔除 | 与 0.8.3 及以前一致 |

### 4.4 为什么用 cwd 而不是 workspaceId

- `header.cwd` 是会话创建时就固化的绝对路径，插件拿得到；压缩引擎在预设的隔离组里，看不到宿主的
  `workspaceRegistry`；
- 她的会话都由插件用 `roomDir` 创建（家、房间、频道），cwd 天然落在 `worlds\<id>\room`；
- 多个世界时，把多个房间目录都列进 `toolFreeFor` 即可。

---

## 5. 代码改动清单

| 文件 | 改动 |
| --- | --- |
| `src/compaction.ts` | ① `ToolFreeCompactionConfig` 增加 `toolFreeFor?: string[]`；② `static Config` 增加 `toolFreeFor: z.array(z.string())`；③ 构造函数保存 `this.toolFreeFor`；④ 新增 `underAny()`；⑤ `summarize()` 里按 `toolFree` 选择 `toolFreeMessages(messages)` 或原样 `messages`（可见性检查仍用剔除工具后的版本） |
| `src/compactionSwap.ts` | ① 新增 `CompactionSwapOptions { toolFreeFor?: readonly string[] }`；② `swapPresetConfig(config, options)` 在改名的同时把 `toolFreeFor` 合并进该行 `config`（保留已有 config）；③ `swapPresetCompaction(editor, presetId, dir, options)` 透传 |
| `src/index.ts` | 换压缩时传 `{ toolFreeFor: [options.roomDir] }` |
| `tests/compaction.test.ts` | 新增：两个 cwd 不同的会话，房间的摘要不含工具、代码的摘要含 `TOOL_RESULT` |
| `tests/compactionSwap.test.ts` | 新增：传入选项时写入 `config.toolFreeFor`；不传时不写 |
| `CHANGELOG.md` | 0.8.4 条目 |
| `package.json` | 版本 0.8.4 |

### 5.1 兼容性细节

- **默认值空数组**：老配置不写 `toolFreeFor` 时行为不变，不会影响其它 profile；
- **经典宿主**（非桌面版，profile 里直接有 `compaction-basic` 行）：走 `swapStockCompaction` 的文本替换路径，
  **暂不注入** `toolFreeFor`，保持旧行为（全局剔除）。桌面版走预设路径，会注入；
- **已有世界**：`compactionSwapped: true` 已写入 `world.json`，插件不会再改预设行；`toolFreeFor` 需要手工补
  （本次已补）；
- **换 `worldId`**：新世界的房间目录变了，`toolFreeFor` 里的路径要跟着改，否则她的新会话会被当成「代码会话」
  而保留工具过程（功能退化，不会崩）。

---

## 6. 本次在 profile 上的实际操作

### 6.1 改了什么

`~\.dsh\profiles\desktop\cordis.patch.yml`，`preset-standard → compaction → compaction-basic` 下新增：

```yaml
            config:
              toolFreeFor:
                - 'C:\Users\<你>\.dsh\worlds\default\room'
```

### 6.2 备份

- `cordis.patch.yml.bak-toolfree-20261108-013736`（本次改动前）
- 之前还留有：`cordis.patch.yml.bak-config-*`（配置行写入前）、`.dsh-world.*.bak`（压缩迁移前）

### 6.3 校验

用宿主同款 YAML 语义解析（`yaml` 解析器）复核：

```
rows: 7
compaction-basic = { id, name: dsh-world-bili/compaction, config: { toolFreeFor: ['C:\Users\…\worlds\default\room'] } }
```

（解析器对 `!!js` 自定义标签会告警，那是 DSH 的表达式标签，不是错误。）

### 6.4 安装状态

- `node_modules\dsh-world-bili` 是指向 `<repo>` 的**软链接**（profile 依赖写作 `link:…`）；
- 仓库已 build 为 **0.8.4**，装进去的 `lib/compaction.js` 含 `toolFreeFor`；
- 因此本次**不需要重装**，重启 DSH 即生效。

---

## 7. 验证

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 0 error |
| 单测（压缩） | `node --test tests/compaction.test.ts tests/compactionSwap.test.ts` | 21 条全过（含 2 条新增） |
| 全量测试 | `npm test` | 542 条，541 通过；唯一失败为既有 flake（见 7.1） |
| 构建 | `npm run build` | 通过 |
| 打包 | `npm pack --pack-destination artifacts` | `dsh-world-bili-0.8.4.tgz`（447 KB） |

### 7.1 关于那个 flake

`tests/plugin.test.ts` 偶发在文件级失败，日志是：

```
Test hook "after" at tests\hostFixture.ts:28:5 generated asynchronous activity after the test ended.
This activity created the error "Error: WebSocket was closed before the connection was established"…
```

这是测试夹具清理 WebSocket 的时序问题（插件里 QQ 原生通道相关用例），**不是本次改动引入**：单独重跑
`tests/plugin.test.ts` 38/38 通过，全量重跑多数也通过。

---

## 8. 回退

三种粒度，从小到大：

1. **只恢复成全局剔除工具**：删掉压缩行下的 `config:` / `toolFreeFor:` 三行，重启。行为回到 0.8.3。
2. **恢复改配置前的文件**：用 `cordis.patch.yml.bak-toolfree-20261108-013736` 覆盖，重启。
3. **彻底不用插件的压缩**：
   - 在 `- id: dsh-world-bili` 配置里把 `replaceCompaction` 改成 `false`；
   - 删掉 profile 里 `- id: preset-standard` 那一整块（约 165 行，注意保持 YAML 合法，删到下一个顶层 `- ` 之前）；
   - 重启。压缩回到宿主原版 `@deepseek-ai/dsh-compaction-basic`。

代码级回退：`git revert` 0.8.4 的提交；`toolFreeFor` 是可选项，删掉配置即可，不影响旧代码。

---

## 9. 已知边界与 FAQ

**Q1：为什么不直接把预设换成只给她用？**
预设名就是她的身份（`belongsToWorld` 按 `agentPreset` 判定），换预设等于换身份，旧会话全部出界。见 2.4。

**Q2：`replaceCompaction` 和「应用并压缩家会话」按钮什么关系？**
按钮走 `compactionFor(agent)` → 取家会话**所在预设里**的压缩引擎。`replaceCompaction` 不控制按钮能否点击，
只决定预设里装的是插件引擎还是宿主原版。引擎没启动（如旧包名那次的 `never started`）时，按钮会报
「未加载压缩服务…」。

**Q3：`toolFreeFor` 会写进预设副本，那我以后改预设怎么办？**
可以改；只是这份副本不再跟随 DSH 升级。`toolFreeFor` 只是其中一个 `config` 键，不影响其它行。

**Q4：为什么摘要请求里还要带工具的 schema？**
非剔除分支会把 tool-call/tool-result 原样送进摘要请求，工具表沿用当前会话的 `header.tools`，与宿主原版一致；
剔除分支会去掉工具表，保持 provider 前缀缓存。

**Q5：多个世界 / 多个房间？**
把每个房间目录都列进 `toolFreeFor`。路径必须是绝对路径；相对路径不会命中。

**Q6：她的频道会话（QQ/微信群）cwd 是房间吗？**
是——频道会话由插件用 `roomDir` 创建，落在 `worlds\<id>\room` 下，因此同样命中。

**Q7：改完不重启会怎样？**
不生效。压缩引擎实例在启动时按预设里的 `config` 构造，`toolFreeFor` 只在构造时读取。

---

## 10. 后续可以做的事（未做）

1. 经典宿主路径（`swapStockCompaction` 的文本替换）也注入 `toolFreeFor`：需要小心的 YAML 文本插入（避免重复
   `config` 键），目前保持旧行为；
2. 把 `toolFreeFor` 默认填成 `options.roomDir`，让新世界免手工配置（现在是手工补）；
3. 在控制台健康里显示「当前作用域：仅房间 / 全 profile」，方便确认；
4. 给 flake 的测试夹具补一次 `ws.close()` 等待，消掉 `plugin.test.ts` 的偶发失败。
