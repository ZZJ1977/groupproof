# A 提供给组员的公共能力

B、C、D 写后端接口时直接调用下面这些函数，不要自己重写权限判断、通知、文件上传或 AI 调用。代码都在 `services/api/app/modules/a/`。

| 任务 | 能力 | 入口 |
| --- | --- | --- |
| A3-05 | 角色和权限检查 | `app/modules/a/permissions.py` |
| A4-01 | 发通知（站内 + 重要事情发邮件） | `app/modules/a/inbox.py` 的 `notify()` |
| A4-02 | 记操作记录（只能加不能改） | `app/modules/a/audit.py` 的 `record_audit()` |
| A4-03 | 建待办 / 关待办 | `app/modules/a/inbox.py` 的 `create_action_item()` / `close_action_item()` |
| A4-04 | 文件上传和限时下载 | `app/modules/a/storage.py` 和 `POST /api/v1/storage/uploads` |
| A7 | AI 中间层和 4 个 AI 函数（目前是固定假结果版） | `app/modules/a/ai/` |

所有写操作都只 `flush` 不 `commit`，跟着调用方的业务事务一起提交或回滚。

## 权限（A3-05）

判断都基于数据库里的当前关系，不信任前端传来的角色。Admin 只有治理权限，默认看不到项目内容。

```python
from app.modules.a import permissions as perm

# 只要真假
perm.is_project_member(session, user, project_id)
perm.is_project_leader(session, user, project_id)
perm.is_course_teacher(session, user, course_id)
perm.is_course_ta(session, user, course_id)
perm.is_group_leader(session, user, group_id)
perm.is_admin(user)

# 直接拦截：失败抛统一的 ApiError
relation = perm.require_project_member(session, user, project_id)            # 默认要求项目可写
relation = perm.require_project_member(session, user, project_id, write=False)
perm.require_project_leader(session, user, project_id)
perm.require_course_teacher(session, user, course_id)
perm.require_admin(user)

# 按动作矩阵（与前端 lib/access/policy.ts 同名）
perm.can(session, user, "project.files.write", perm.Target("project", project_id))
perm.require_action(session, user, "project.publish", perm.Target("project", project_id))
```

返回规则：

- 不是成员也不是本课老师/助教：`404 PROJECT_NOT_FOUND`（不暴露项目是否存在）；
- 能看但不能做：`403`，例如 `PROJECT_MEMBER_REQUIRED`、`PROJECT_LEADER_REQUIRED`；
- 归档、定稿或课程已结束：`403 PROJECT_READ_ONLY`。只有组长可以 `project.reopen`。

越权测试在 `services/api/tests/test_a_permissions.py` 和 `test_a_storage.py`，每次 PR 自动跑。新加的写接口请仿照这些用例加上“学生调老师接口 / A 组改 B 组 / 改归档项目”三类失败用例。

## 操作记录（A4-02）

```python
from app.modules.a.audit import record_audit

record_audit(
    session,
    actor=user,                      # None 表示系统操作
    action="task.status.changed",    # 模块.对象.动作
    target=("task", task.id),
    project_id=task.project_id,
    before={"status": "todo"},
    after={"status": "done"},
    reason="组长确认完成",
    request=request,                 # 可选，记下请求编号
)
```

- 字段名里含 password、secret、token、api_key 等的值会被替换成 `[redacted]`；
- 改前改后只记变化的字段，单条快照超过 2 万字符会报错；
- 数据库触发器拒绝对 `a_audit_events` 的修改、删除和清空；
- 查询页（54，C 做）用 `list_audit_events(session, project_id=..., actor_id=..., since=..., page=...)`，调用前先查权限。
- 每条记录还带 **操作人角色**（`actor_role`，操作发生那一刻的角色，之后账号角色变了也不改写）和 **结果**（`result`：`success` / `failure` / `denied`，默认 success）。记失败或被拒绝的操作：`record_audit(..., result="denied")`；查询时可按 `result`、`actor_role` 过滤。

## 通知和待办（A4-01、A4-03）

```python
from app.modules.a.inbox import notify, create_action_item, close_action_item

notify(
    session,
    recipient=leader,
    category="project",              # course / project / system
    title="验收被退回",
    description="任务 T-3 的验收被老师退回",
    target={"kind": "task", "id": task.id, "project_id": project.id},
    email=True,                      # 重要事情：事务提交后再发邮件
    dedupe_key=f"verification:{run.id}:returned",  # 同一件事只通知一次
)

item = create_action_item(
    session,
    recipient=teacher,
    category="member",               # task / verification / evidence / rule / appeal / member / course
    title="入组申请待审批",
    target={"kind": "member_change", "id": request.id, "course_id": course.id},
    priority="high",
    source_key=f"join:{request.id}",
)
close_action_item(session, item.id, status="completed", actor=teacher)
close_action_items_by_source(session, f"join:{request.id}", actor=teacher)  # 多人收到的同一件事一起关闭
```

- `target` 的格式与 C 的 `InboxTarget` 一致，写入时就校验；待办类别必须和处理页面匹配（例如 `member` 只能指向 `member_change`）；
- 通知页（05）和待办页（06、44）已经通过 C 的 `/api/v1/me/notifications`、`/api/v1/me/action-items` 读到真实数据；
- 邮件走现有发信通道（Brevo / Resend / SMTP）；失败的邮件保持待发状态，最多重试 5 次，不影响站内通知；
- 教师提交身份审核时，所有管理员会收到通知；审核结果会通知申请人并发邮件（A3-03）。

## 文件上传（A4-04）

前端流程：

1. `POST /api/v1/storage/uploads`，body：`{scope: "project" | "course", scope_id, filename, mime_type, size_bytes}`，返回 `receipt_id` 和 `upload_url`；
2. 浏览器把文件 `PUT` 到 `upload_url`（直接传到 Supabase，不经过我们的服务器）；
3. `POST /api/v1/storage/uploads/{receipt_id}/complete`：后端把文件读回来，重新计算 SHA-256、大小，检查文件头和扩展名一致，通过后状态变为 `completed`；
4. 把 `receipt_id` 交给业务接口（例如 C 的项目资料、课程文件接口）。

限制：单个文件不超过 50MB；允许 pdf、doc(x)、ppt(x)、xls(x)、md、txt、zip、png、jpg。

后端代码里也可以直接调用 `storage.create_upload(...)`、`storage.complete_upload(...)`、`storage.signed_download_url(...)`（10 分钟有效）。

说明：`scan_status=clean` 目前代表通过了基础内容检查（文件头与扩展名一致、拒绝可执行文件、压缩包中的可执行文件和压缩炸弹），**不是杀毒扫描**。以后接入杀毒服务时实现 `ContentScanner` 即可。

环境变量（Railway，测试和正式各一套）：

| 变量 | 说明 |
| --- | --- |
| `SUPABASE_URL` | Supabase 项目地址，必须是 https |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key，只放后端变量 |
| `SUPABASE_STORAGE_BUCKET` | 存储桶名，建议 `groupproof-staging` / `groupproof-production`，设为私有 |

三个变量不全时，上传接口和 C 的文件接口返回 `503 FILE_STORAGE_UNAVAILABLE`，不会假装上传成功。

## AI（A7，目前是固定假结果版）

```python
from app.modules.a import ai

result = ai.extract_requirements(ai.RequirementExtractionInput(project_id=..., documents=[...]))
result = ai.suggest_tasks(ai.TaskSuggestionInput(project_id=..., requirements=[...], tasks=[...]))
result = ai.match_evidence(ai.EvidenceMatchInput(project_id=..., criterion={...}, evidence=[...]))
result = ai.explain_risk(ai.RiskExplanationInput(project_id=..., tasks=[...], risks=[...]))
```

| 函数 | 给谁 | 输入 | 输出 |
| --- | --- | --- | --- |
| `extract_requirements`（A7-03） | B，页面 08 | 文件列表，每个文件按段落给出 `segment_id` + 文字 | 模块、需求草案、互相矛盾的地方；每条都带出处（`source_id` + `segment_id` + 引文） |
| `suggest_tasks`（A7-04） | B，页面 10 | 需求列表 + 已有任务（含关联的需求 id） | 没被任务覆盖的需求 id，建议的任务和验收标准 |
| `match_evidence`（A7-05） | D，页面 17 | 一条验收标准 + 若干证据 | 通过 / 部分通过 / 不通过 / 证据不足，置信度、理由、缺什么 |
| `explain_risk`（A7-06） | D，风险和报告页 | 任务进度 + 风险记录 | 风险等级、一句话总结、大白话解释、建议 |
| `analyze_implementation`（A7-07） | A5，GitHub 页 | 需求列表 + 代码文件（路径+正文） | 每条需求：已实现 / 部分 / 没找到 / 不确定，置信度、理由、缺什么；声称已实现必须带真实文件路径和逐字存在的引文，否则整份作废 |

完整字段见 `app/modules/a/ai/schemas.py`。**这是草案，请 B、D 看过后在 PR 里提意见，定稿后再接真实 AI。**

- 每个结果都带 `provider`、`is_placeholder` 和 `needs_human_review=true`：AI 的结果只是建议，页面必须让人确认后才写入正式数据；
- AI 不可用时抛 `503 AI_UNAVAILABLE`（“AI 暂不可用，请改为人工处理”），页面改走人工流程，网站其他功能不受影响；
- AI 编造了不存在的出处或 id 时，整份结果作废，同样返回 `AI_UNAVAILABLE`；
- `AI_PROVIDER=fake`：返回固定假结果（本地 Docker Compose 默认开启，测试环境可在 Railway 变量里开启）；正式环境禁止 `fake`；留空表示 AI 不可用。`AI_PROVIDER=openrouter`：走 OpenRouter 真实模型，需要 Railway 变量 `AI_API_KEY`（密钥只放 Railway，不进聊天和代码）和 `AI_MODEL`（建议 anthropic/claude-sonnet-4.5，留空用默认）。
- 接口：`POST /api/v1/a/projects/{id}/github/analyze`，body 为 `{requirements:[{id,text}]}`；项目成员可用，需先绑定并同步仓库；只会把与需求文字相关的文件（总量上限约 6 万字）交给 AI。


## 运维与发布检查（A8）

- **错误监控**：Railway 变量填 `SENTRY_DSN` 后后端自动启用 Sentry；不填就不启用。只发送错误类型、堆栈和请求路径，不发送用户信息、Cookie、请求头和正文。`SENTRY_TRACES_SAMPLE_RATE` 默认 0。
- **正式环境不出现示例数据**：后端 `fake` AI 和演示数据导入在正式/测试环境会直接拒绝；前端在构建变量里设置 `NEXT_PUBLIC_APP_ENV=production`，所有功能强制走真实接口，忽略 mock 开关。
- **接口客户端检查**：`packages/domain/openapi.json` 必须和后端当前接口一致（后端测试 `test_openapi_snapshot` 检查）；`api.generated.ts` 必须和快照一致（CI 里重新生成并比对）。改了接口后：在 `services/api` 运行 `PYTHONPATH=. python scripts/export_openapi.py`，再在仓库根目录运行 `npm run api:generate`，一起提交。

## 账号管理与教师审核（A→C）

- 教师审核的共享规则在 `accounts.review_teacher_application`，A（`/api/v1/admin/...`）和 C（`/api/v1/c-admin/...`）两个入口共用：**拒绝必须写理由**；**批准时学校邮箱必须仍然已验证**；已停用账号不能被审核。
- 恢复账号：`POST /api/v1/c-admin/users/{id}/enable`（body：`expectedVersion`、`reason`），清除停用信息、权限版本加一、通知本人。
- 创建账号：`POST /api/v1/c-admin/users`（`identity` 为 student/teacher、`name`、`username`、`schoolEmail`，可选 `studentId`、`college`）。管理员已人工核对身份，所以学校邮箱记为已验证；**不生成也不返回密码**，本人用该邮箱走“忘记密码”自己设置密码。创建动作写入操作记录 `user.created_by_admin`。

## AI 用量（A7）

- 所有 AI 函数多一个可选参数 `usage=ai.AIUsageContext(user_id=..., project_id=...)`，传了就会为这次调用记一行（`a_ai_usage_events`）：用户、项目、功能、厂商、模型、成功与否、错误码、输入/输出 token、费用（OpenRouter 返回的 USD）、耗时。**不传不记录**；记录用独立会话提交，AI 失败或业务事务回滚也不会丢，记录本身出错也不会影响 AI 结果。
- 管理员查询：`GET /api/v1/a/ai-usage`（逐条，可按 `user_id`、`project_id`、`feature`、`success`、`since`、`until` 过滤，分页）和 `GET /api/v1/a/ai-usage/summary`（按功能 + 模型汇总调用数、失败数、token、费用）。

## GitHub 活动（A5）

- “同步 GitHub”现在除了代码文件，还会读默认分支最近 100 条提交、100 个合并请求、100 次 CI 运行（只读）。**GitHub App 需要只读权限：Contents、Metadata、Pull requests、Actions。** 给已有的 App 补权限后，仓库所有者要在 GitHub 上点“接受新权限”，否则同步会报 503。
- 查询：`GET /api/v1/a/projects/{id}/github/activity?kind=commit|pull_request|ci_run&author_id=...`；C 的活动页和证据页通过 `ActivitySourcePort` 读取（`github_activity.DatabaseGithubActivityPort`），能按本站用户、类型、时间、关键词过滤，记录带稳定的 `identity` 和 `revision`。
- 作者识别：本人用 `PUT /api/v1/a/me/github-login`（body `{login}`，空表示清除）声明 GitHub 用户名；也会按提交邮箱匹配本站登录邮箱、已验证学校邮箱和 `id+用户名@users.noreply.github.com`。**只会对应到本项目成员**，对应不上就只显示 GitHub 名字。
- 来源被删除：窗口内本该出现却没出现的提交或 CI 运行，会逐个向 GitHub 确认，GitHub 明确说查不到才标记 `deleted`；网络、权限失败整体 503，绝不当成删除。
- 同步到新提交后，自动调用 C 的 `auto_associate_github_commit`：提交信息里恰好写了一个任务号（如 `#T-012`）且在冻结计划里，就自动关联到任务；之前人工取消关联的不会被重新关联。

## 飞书完整消息和附件（A6）

- 同步时保存**脱敏后的全文**（上限 3 万字）：手机号、邮箱、证件号、银行卡号、密钥、“密码：xxx”会被替换成占位符。富文本（post）会拼出文字，图片/文件/语音/视频记为附件引用。
- 消息每次内容变化（编辑、附件变化、删除）都会生成新版本（`a_feishu_message_versions`，只增不改），`revision` 随版本变化。
- C 的 `ActivitySourcePort.get` 返回全文、`version_no` 和附件引用；列表仍只给前 200 字。
- 详情：`GET /api/v1/a/projects/{id}/feishu/messages/{message_id}`（全文、所有版本、附件）。
- 附件核验：`POST /api/v1/a/projects/{id}/feishu/attachments/{attachment_id}/verify`，用机器人凭证下载（上限 20MB）并记录 SHA-256 和大小，内容不入库；指纹一旦记录不再改写，下载失败整体 503。需要飞书应用有“获取消息中的资源文件”权限。

## 临时只读授权（A→C）

- C 的访问申请通过 `AuthorizationPort` 调用 A（`access_grants.DatabaseAuthorizationPort`，已接入）：
  1. `visible_target`：只有同课程的学生（目标项目对课程公开）或本课老师/助教能看到目标；其他情况一律返回与“不存在”相同的 404；
  2. `activate`：批准时在同一事务里生效，回执原样包含申请人、范围、到期时间；同一个 `command_id` 重复调用得到同一份授权，同一申请不能生效两份；
  3. 读取时检查：项目范围的授权会让 A 的只读接口（绑定列表、GitHub 活动、飞书消息等）承认申请人为只读访问者，**不能写、不能做组长操作、不能触发附件核验**；到期或撤销后下一次读取立即失效，不需要清理任务。
- 任务、证据范围的授权，C 在读取任务或证据内容时调用 `access_grants.has_read_grant(session, user_id, project_id, "task", task_id)`；项目范围的授权覆盖项目里的所有资源。
- 撤销：`POST /api/v1/a/access-grants/{grant_id}/revoke`（管理员，body `{reason}`），重复撤销不改写原记录。生效和撤销都写入操作记录。
