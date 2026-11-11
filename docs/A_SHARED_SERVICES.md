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
