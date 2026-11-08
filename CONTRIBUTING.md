# 贡献

欢迎改这个插件。它是在 dsh-world / dsh-feiyu / dsh-bili-whale 基础上做的 B 站特化版，改动尽量小、可回滚。

## 提交 PR 前

```bash
npm ci
npm run typecheck
npm test
```

- 一个 PR 只做一件事；行为改动补回归测试。
- 不要提交 `node_modules/`、`lib/`、`artifacts/`、`*.tgz`、`~/.dsh` 里的运行数据。
- 不要提交真实 Cookie、QQ token、QQ 号或本机用户名；示例用 `<...>` 占位。
- 新增外部平台适配器放 `src/ecosystem/<channel>/`，复用 `shared/` 里现有的身份与会话路由。

## 代码风格

- 先读相邻模块，复用已有函数/类型，不另起一套。
- 函数小而单一；状态集中在一个 `createXxx(deps)` 返回的对象里。
- 失败要如实上报，不用空结果冒充「没有」。
- 注释写「为什么」，不重复代码在做什么。

## 发版

1. 改 `package.json` 的 `version`（语义化版本）；
2. 在 `CHANGELOG.md` 顶部加一节；
3. `npm pack` 前会跑 `typecheck` + `build`；
4. 用 `npm run test:package` 验证 tgz 能装、能导入；
5. 不把 npm 登录令牌写进仓库。

## 安全

发现安全问题请开 issue 描述影响面，不要贴真实凭据或世界数据。
