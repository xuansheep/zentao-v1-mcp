# 使用指南

本文档面向已经按 [`README.md`](../../README.md) 完成快速开始的使用者，整理工具面、典型查询用法和写操作安全语义。

English version: [README.en.md](README.en.md)

## 工具列表

当前暴露 20 个工具：

- `zentao_get_current_user`
- `zentao_list_products`
- `zentao_list_projects`
- `zentao_list_executions`
- `zentao_list_stories`
- `zentao_list_tasks`
- `zentao_list_bugs`
- `zentao_list_builds`
- `zentao_get_build`
- `zentao_create_build`
- `zentao_update_build`
- `zentao_create_bug`
- `zentao_create_task`
- `zentao_create_story`
- `zentao_auth`
- `zentao_upload_paste_image`
- `zentao_list_objects`
- `zentao_get_object`
- `zentao_list_releases`
- `zentao_get_task_efforts`

工具签名、范围参数互斥规则、低频通用工具的资源枚举见[设计文档 — MCP 工具面](../design/zentao-v1-mcp-design.md#mcp-工具面)。

## 按 ID 查询对象详情

当用户已经提供具体对象 ID，并询问详情、内容或分析时，优先使用 `zentao_get_object`，不要先走同领域的列表工具。详情查询只需要对象类型和 ID，例如：

```json
{
  "resource": "bug",
  "id": 80793
}
```

`zentao_get_object` 支持以下详情资源：

| resource | 对象 |
| --- | --- |
| `user` | 用户 |
| `department` | 部门 |
| `program` | 项目集 |
| `product_plan` | 产品计划 |
| `product` | 产品 |
| `project` | 项目 |
| `execution` | 执行 |
| `story` | 需求 |
| `task` | 任务 |
| `bug` | Bug |
| `testcase` | 用例 |
| `testtask` | 测试单 |
| `feedback` | 反馈 |
| `ticket` | 工单 |

高冲突提示示例：

| 用户提示 | 推荐工具 |
| --- | --- |
| 查看 bug 80793 的详情 / 内容 / 原因分析 | `zentao_get_object` with `resource="bug"`, `id=80793` |
| 分析需求 123 | `zentao_get_object` with `resource="story"`, `id=123` |
| 看任务 456 详情 | `zentao_get_object` with `resource="task"`, `id=456` |
| 执行 1510 是什么 | `zentao_get_object` with `resource="execution"`, `id=1510` |
| 产品 60 的详情 | `zentao_get_object` with `resource="product"`, `id=60` |
| 项目 7 的内容 | `zentao_get_object` with `resource="project"`, `id=7` |

`zentao_list_bugs`、`zentao_list_stories`、`zentao_list_tasks` 等列表工具用于分页的范围列表；只有对象类型和 ID 的提示通常是详情查询。

## 按执行查询 Bug

`zentao_list_bugs` 支持产品级和执行级查询。已知两个 ID 时，建议同时传入，结果最明确：

```json
{
  "product_id": 60,
  "execution_id": 1510,
  "status": "unclosed",
  "assigned_to_account": "zhuxiaokun"
}
```

如果只提供 `execution_id`，服务器会先尝试推断产品，再在本地扫描产品 bug。`status: "unclosed"` 只排除 `closed`，会包含 `active`、`confirmed`、`resolved` 以及线上 API 返回的其他非 `closed` 状态。

执行范围查询会按页大小 100 扫描产品 bug 列表，并在本地过滤执行、状态和指派人。响应中暴露 `source.scanned_total`、`source.scan_pages`、`source.scan_limit`，可以让调用方了解 MCP 侧扫描成本。

完整的执行级 bug 查询行为和已知禅道 v1 API 限制见[设计说明](../design/zentao-v1-mcp-design.md#zentao_list_bugs-执行范围第一版边界)。多步流程的架构选择见[查询工具多步流程决策](../design/zentao-query-tool-multistep-decision.md)。

## 写操作安全

当前暴露六个明确白名单禅道写操作：版本创建、版本更新、创建 Bug、创建任务、创建需求和图片粘贴上传；另提供一个本地认证写操作 `zentao_auth`。所有这些工具都需要 `confirm=true` 才会产生真实副作用。

没有 `confirm=true` 时，`zentao_create_build`、`zentao_update_build`、`zentao_create_bug`、`zentao_create_task`、`zentao_create_story`、`zentao_auth` 和 `zentao_upload_paste_image` 只返回带有 `requires_confirmation=true` 的试运行摘要。图片上传摘要不会暴露 base64 原文，认证摘要不会启动浏览器或写入认证文件。

创建版本示例：

```json
{
  "project_id": 1234,
  "execution": 1510,
  "product": 60,
  "name": "v1.2.0-rc1",
  "builder": "zhuxiaokun",
  "confirm": true
}
```

创建 Bug 示例：

```json
{
  "product_id": 60,
  "title": "登录失败",
  "severity": 2,
  "pri": 1,
  "type": "codeerror",
  "openedBuild": ["trunk"],
  "confirm": true
}
```

图片上传认证示例：

```json
{
  "confirm": true
}
```

`zentao_auth` 会强制打开可见浏览器，使用 MCP 配置中的禅道地址、账号和密码完成登录，并将图片上传所需的最小会话信息保存到 `~/.zentao/auth.json`。版本 2 文件包含完整 Cookie，以及实际浏览器的 `user_agent`、最终登录页 `referer`、由 `base_url` 生成的 `origin` 和 `x_requested_with`。不会保存密码、REST API Token、localStorage 或完整浏览器状态。工具响应只返回认证时间、Cookie 名称、上下文字段名称和保存位置，不返回任何上下文字段值。该文件是包含会话凭据的明文 JSON：在支持 POSIX 权限的平台上目录权限设为 `0700`、文件权限设为 `0600`；Windows 权限仍取决于当前用户目录的 ACL，请勿共享该文件。首次实际认证或上传时，如果新文件不存在而旧 `~/zentao/auth.json` 存在，会将旧文件移动到新位置；如果新旧文件同时存在，则使用新文件并保留旧文件。

上传图片示例：

```json
{
  "image_path": "D:\\work\\xxx\\screenshot.png",
  "alt": "缺陷截图",
  "paste_endpoint": "/file-ajaxPasteImg-6a4f423d1ef07.html",
  "confirm": true
}
```

`paste_endpoint` 可选；不传时工具会自动生成 `/file-ajaxPasteImg-*.html` 路径。上传工具不再接受 `web_cookie`、`web_headers` 或 `remember_session`，而是通过共享 AuthService 读取 `~/.zentao/auth.json`，并统一发送 Cookie、User-Agent、Referer、Origin 和 X-Requested-With。版本 1 文件缺少必要上下文，会直接刷新认证并覆盖为版本 2，不会猜测旧字段。认证文件缺失、损坏、与当前禅道地址或账号不匹配、或已标记失效时，也会自动打开浏览器刷新认证；上传首次发生鉴权失败时会刷新并重试一次。第二次仍失败会返回明确错误，不会循环打开浏览器。Cookie 轮换时只更新 Cookie 和时间戳，保留同一批请求上下文。

浏览器能力由可选 Playwright 提供，不再回退到 HTTP 表单登录。当前上传工具和认证文件只支持一个禅道实例及账号；更换配置后会获取新认证并覆盖原文件。

`zentao_upload_paste_image` 成功后会返回类似下面的结构：

```json
{
  "src": "/file-read-14215.png",
  "html": "<img src=\"/file-read-14215.png\" alt=\"缺陷截图\" />",
  "file_name": "screenshot.png",
  "size": 204180
}
```

创建带截图的 Bug 时，先调用 `zentao_upload_paste_image`，再把返回的 `html` 片段写入现有 `zentao_create_bug.steps`。不要把 base64 直接写入 Bug 富文本。

```json
{
  "product_id": 60,
  "title": "登录失败",
  "severity": 2,
  "pri": 1,
  "type": "codeerror",
  "openedBuild": ["trunk"],
  "steps": "<p>[截图]</p><p><img src=\"/file-read-14215.png\" alt=\"缺陷截图\" /></p>",
  "confirm": true
}
```

创建任务示例：

```json
{
  "execution_id": 1510,
  "name": "实现登录接口",
  "type": "devel",
  "assignedTo": "admin",
  "estStarted": "2026-07-09",
  "deadline": "2026-07-31",
  "confirm": true
}
```

创建需求示例：

```json
{
  "title": "支持短信登录",
  "product": 60,
  "pri": 2,
  "category": "feature",
  "spec": "支持通过短信验证码登录",
  "verify": "用户可以收到验证码并完成登录",
  "confirm": true
}
```

设计上不暴露通用创建或更新工具，也不暴露删除操作或任意 HTTP 代理。详细边界见[开发说明 — 第一版边界](../dev/README.md#第一版边界)，以及[设计文档 — 写工具](../design/zentao-v1-mcp-design.md#写工具)。