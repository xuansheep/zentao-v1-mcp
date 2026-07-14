# 开发说明

本文档用于承载开发者背景信息，避免用户快速开始文档 `README.md` 过重。

## 第一版边界

- 服务器不暴露删除操作。
- 服务器不暴露任意 HTTP 代理能力。
- 除版本创建和版本更新外，不暴露通用创建或更新工具。
- 一个进程只连接一个禅道实例。

## 接口注册表

接口注册表根据本地禅道 API v1 文档 `doc/zentao_api_v1_doc/` 手写维护。

这样做是有意的：本地 Markdown 文档存在编码和格式不一致的问题，自动抽取会让第一版行为超出已接受的设计边界。

## 设计文档

- [禅道 v1 MCP 设计](../design/zentao-v1-mcp-design.md)
- [查询工具多步流程决策](../design/zentao-query-tool-multistep-decision.md)

## 本地验证

```bash
npm install
npm run build
npm test
npm run smoke
```

修改特定区域时先运行聚焦测试；发布或交接前再运行完整验证集。

发布前使用完整门禁：

```bash
npm run verify
```

该命令会依次执行构建、单元测试、stdio smoke、依赖审计和 `npm pack --dry-run`，用于确认 npm 包里的运行产物和文档范围。

## npm 发布流程

### 包名与版本规则

公开包发布到 npm scope `@einsteins`，完整包名为 `@einsteins/zentao-v1-mcp`。npm 不允许覆盖已经发布过的版本号，每次发布必须按语义化版本提升 `package.json` 和 `package-lock.json` 中的版本。

- 修复兼容性问题使用 `patch`，例如 `1.0.0` 到 `1.0.1`。
- 新增兼容功能使用 `minor`，例如 `1.0.0` 到 `1.1.0`。
- 破坏兼容的变更使用 `major`。

### 首次手动发布 1.0.0

新包尚无 npm 包设置页面，首次发布需要从已经合并并通过 CI 的 `main` 分支手动执行一次：

```bash
git switch main
git pull --ff-only origin main
npm login
npm whoami
npm run verify
npm publish --access public
npm view @einsteins/zentao-v1-mcp version
npx -y @einsteins/zentao-v1-mcp print-config
```

`npm whoami` 必须显示拥有 `@einsteins` scope 发布权限的账号。账号应开启 2FA，不要把 npm token 写入仓库、项目 `.npmrc` 或 GitHub Secrets。

`1.0.0` 已由本机发布，因此不要再推送 `v1.0.0` tag，否则发布 workflow 会尝试重复发布同一版本。自动 Tag 发布从下一个版本开始。

### GitHub trusted publishing

首次发布成功后，在 npm 的 `@einsteins/zentao-v1-mcp` 包设置中绑定 GitHub Actions trusted publisher：

- Provider: `GitHub Actions`
- Organization or user: `xuansheep`
- Repository: `zentao-v1-mcp`
- Workflow filename: `publish.yml`
- Environment name: 留空
- Allowed action: `npm publish`

trusted publishing 使用 GitHub OIDC，不需要长期 npm token。`publish.yml` 必须保留 `id-token: write` 权限。绑定验证成功后，建议在 npm 开启 `Require 2FA and disallow tokens`。

### 后续自动发布

在开发分支提升版本，但不要提前创建 Git tag：

```bash
npm version patch --no-git-tag-version
npm run verify
```

提交 `package.json` 和 `package-lock.json`，通过 PR 合并到 `main`。等待 `main` CI 全部通过后，从最新 `main` 创建与包版本完全一致的 Tag：

```bash
git switch main
git pull --ff-only origin main
git tag -a v1.0.1 -m "Release v1.0.1"
git push origin v1.0.1
```

`v*.*.*` Tag 会触发 GitHub Actions。工作流会先校验 Tag 与 `package.json.version` 一致，再执行安装、构建、测试、smoke、审计和 `npm publish --access public`。
