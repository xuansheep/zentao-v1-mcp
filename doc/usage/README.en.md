# Usage Guide

This guide is for users who have completed the quick start in [`README.en.md`](../../README.en.md). It covers the tool surface, common query usage, and write-safety semantics.

Chinese version: [README.md](README.md)

## Tools

The server exposes 20 tools:

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

Tool signatures, scope-parameter exclusivity rules, and the resource enums for the generic tools are documented in [Design — MCP Tool Surface](../design/zentao-v1-mcp-design.md#mcp-工具面).

## Get Object Details By ID

When the user already provides a concrete object ID and asks for details, content, or analysis, prefer `zentao_get_object` instead of same-domain list tools. Detail lookups need only the object type and ID, for example:

```json
{
  "resource": "bug",
  "id": 80793
}
```

`zentao_get_object` supports these detail resources:

| resource | Object |
| --- | --- |
| `user` | User |
| `department` | Department |
| `program` | Program |
| `product_plan` | Product plan |
| `product` | Product |
| `project` | Project |
| `execution` | Execution |
| `story` | Story |
| `task` | Task |
| `bug` | Bug |
| `testcase` | Test case |
| `testtask` | Test task |
| `feedback` | Feedback |
| `ticket` | Ticket |

High-conflict prompt examples:

| User prompt | Recommended tool |
| --- | --- |
| Show bug 80793 details / content / root-cause analysis | `zentao_get_object` with `resource="bug"`, `id=80793` |
| Analyze story 123 | `zentao_get_object` with `resource="story"`, `id=123` |
| Show task 456 details | `zentao_get_object` with `resource="task"`, `id=456` |
| What is execution 1510 | `zentao_get_object` with `resource="execution"`, `id=1510` |
| Product 60 details | `zentao_get_object` with `resource="product"`, `id=60` |
| Project 7 content | `zentao_get_object` with `resource="project"`, `id=7` |

List tools such as `zentao_list_bugs`, `zentao_list_stories`, and `zentao_list_tasks` are for paginated scoped lists; prompts with only object type and ID are usually detail lookups.

## Query Bugs By Execution

`zentao_list_bugs` supports product-level and execution-level queries. When both IDs are known, pass both for the most deterministic result:

```json
{
  "product_id": 60,
  "execution_id": 1510,
  "status": "unclosed",
  "assigned_to_account": "zhuxiaokun"
}
```

If only `execution_id` is provided, the server tries to infer the product before scanning product bugs locally. `status: "unclosed"` excludes only `closed`; it includes `active`, `confirmed`, `resolved`, and any other non-`closed` status the live API returns.

Execution-scoped queries scan the product bug list at page size 100, then filter execution, status, and assignee locally. The response exposes `source.scanned_total`, `source.scan_pages`, and `source.scan_limit` so callers can see the MCP-side scan cost.

For the full execution-scoped behavior and known ZenTao v1 API limits, see the [design notes](../design/zentao-v1-mcp-design.md#zentao_list_bugs-执行范围第一版边界). The architectural choice for the multi-step flow is in [Query Tool Multi-Step Decision](../design/zentao-query-tool-multistep-decision.md).

## Write Safety

The server exposes six allow-listed ZenTao write operations: build creation, build update, bug creation, task creation, story creation, and paste-image upload. It also exposes the local authentication write operation `zentao_auth`. Every side-effecting tool requires `confirm=true`.

Without `confirm=true`, these tools return a dry-run summary and perform no external request or local credential write. Image summaries redact base64 content, and auth summaries do not open a browser.

Authenticate image uploads explicitly with:

```json
{
  "confirm": true
}
```

`zentao_auth` opens a visible browser, logs in with the configured ZenTao URL and credentials, and persists the minimum image-upload session data in `~/.zentao/auth.json`. Version 2 stores the complete Cookie plus the real browser `user_agent`, final login-page `referer`, an `origin` derived from `base_url`, and `x_requested_with`. It does not store the password, REST API Token, localStorage, or complete browser state. The result returns only cookie names, request-context field names, capture time, and storage location; it never returns context values. The file is plaintext session credential data. POSIX systems use directory mode `0700` and file mode `0600`; on Windows, protection depends on the user's home-directory ACL. On the first real authentication or upload, an existing legacy `~/zentao/auth.json` is moved when the new file is absent; if both files exist, the new file is used and the legacy file is left untouched.

Upload an image with:

```json
{
  "image_path": "D:\\work\\xxx\\screenshot.png",
  "alt": "Bug screenshot",
  "paste_endpoint": "/file-ajaxPasteImg-6a4f423d1ef07.html",
  "confirm": true
}
```

The upload tool no longer accepts `web_cookie`, `web_headers`, or `remember_session`. It loads managed authentication from `~/.zentao/auth.json` and sends Cookie, User-Agent, Referer, Origin, and X-Requested-With on every upload. Version 1 files lack the required request context and are refreshed and replaced with version 2 without guessing old values. Missing, invalid, mismatched, or rejected authentication triggers one browser refresh and at most one upload retry. Cookie rotation updates only the Cookie and timestamp while preserving the captured request context. Playwright is optional, but there is no HTTP form-login fallback.

By design no generic create/update tool, delete operation, or arbitrary HTTP proxy is exposed. See [Developer Notes — First-Version Boundaries](../dev/README.md#第一版边界) for the boundary rationale.
