# B 对外接口约定（A4-05、D 验收端口）

状态：**已定稿并接入真实实现（2026-11-27 核对）**。`get_material_text_port()` 已接入 A4-05 持久化提取适配器 `PersistedMaterialTextPort`（`app/modules/b/material_text_port.py`），`get_verification_port()` 已接入 D 持久化人工验收与失效适配器 `PersistedVerificationPort`（`app/modules/b/verification_port.py`）；`Unavailable*Port` 仅作为未配置或隔离测试回退实现保留。

- 代码位置：`services/api/app/modules/b/ports.py`、`material_text_port.py`、`verification_port.py`
- 单元测试：`services/api/tests/test_b_foundation.py`
- 对应历史计划：[2026-11-05-b-module-staged-development-plan.md](2026-11-05-b-module-staged-development-plan.md) 第 2 节

---

## 1. A4-05 取资料正文（`MaterialTextPort`）

**用在哪**：B3-04 项目资料。学生上传文件（A4-04 返回 `receipt_id`）后，B 需要拿到正文给页面显示，并在 B3-05 交给 A7-03 做需求分析。

```python
class MaterialTextPort(Protocol):
    def get_text(self, session: Session, *, receipt_id: UUID, actor_id: UUID) -> MaterialText: ...

@dataclass(frozen=True)
class TextSegment:
    segment_id: str      # 同一个 receipt 内稳定不变，B 的 source_references 用它定位原文
    text: str

@dataclass(frozen=True)
class MaterialText:
    receipt_id: UUID
    status: Literal["ready", "pending", "failed", "unavailable"]
    segments: tuple[TextSegment, ...] = ()
    reason: str | None = None   # failed / unavailable 时给页面看的原因
```

请 A 确认的约定：

| 项 | B 的期望 |
| --- | --- |
| 权限 | A 按 receipt 所属范围检查 `actor_id`；看不到的 receipt 抛 `ApiError(404, "NOT_FOUND")`，不区分“不存在”和“无权”。 |
| 状态 | 提取未完成返回 `pending`，失败返回 `failed` + 原因；B 不重试，只显示状态。 |
| 分段 | 按段落切分；`segment_id` 建议用 `p-0001` 这类顺序号，同一 receipt 多次调用结果一致。 |
| 事务 | 只读，不提交 `session`。 |
| 替换方式 | A 实现后，把 `get_material_text_port()` 的返回值换成 A 的实现（或在 `app.dependency_overrides` 里替换）。 |

**已接入实现** `PersistedMaterialTextPort`（`app/modules/b/material_text_port.py`）：通过 A4-05 `read_receipt_text` 对 `.pdf`、`.docx`、`.md`、`.txt` 进行持久化分段正文提取与 SHA-256 指纹校验；降级/测试回退类 `UnavailableMaterialTextPort` 返回 `status="unavailable"`，绝不伪造正文。文本资料（学生直接粘贴文字）不依赖本端口。

---

## 2. D 验收端口（`VerificationPort`）

**用在哪**：

- B5-02 / B4-02：已验收任务的验收标准被修改时，通知 D 作废旧结果（D1-07）。
- B7-03：确认里程碑阶段交付前，查询关联任务是否都已验收通过。

```python
class VerificationPort(Protocol):
    def invalidate_criterion_results(
        self, session: Session, *, task_id: UUID, criterion_ids: Sequence[UUID],
        reason: str, actor_id: UUID,
    ) -> InvalidationOutcome: ...

    def task_verification_status(
        self, session: Session, *, task_ids: Sequence[UUID],
    ) -> Mapping[UUID, TaskVerificationStatus]: ...

@dataclass(frozen=True)
class InvalidationOutcome:
    task_id: UUID
    accepted: bool                          # False = D 没有处理，B 保留待办，不显示“已作废”
    invalidated_result_ids: tuple[UUID, ...] = ()
    reason: str | None = None

@dataclass(frozen=True)
class TaskVerificationStatus:
    task_id: UUID
    state: Literal["not_submitted", "in_review", "passed", "failed", "invalidated"]
    missing_criterion_ids: tuple[UUID, ...] = ()   # 还没有通过结果的验收标准
```

请 D 确认的约定：

| 项 | B 的期望 |
| --- | --- |
| 作废的事务 | 在 B 的同一个事务里执行（不自己 commit），B 保存失败时作废一起回滚。 |
| 作废的幂等 | 按（`task_id`, `criterion_id`, 任务 `content_version`）去重，B 重试不会重复作废。 |
| 查询的完整性 | 请求了几个任务就返回几个；D 暂时无法判断时抛 `verification_unavailable()`（503 `VERIFICATION_UNAVAILABLE`），**不能漏掉任务或返回空结果**。 |
| 状态口径 | 只有 `passed` 视为“验收完成”；`invalidated` 视为需要重新验收。 |
| 替换方式 | D 实现后，把 `get_verification_port()` 的返回值换成 D 的实现。 |

**已接入实现** `PersistedVerificationPort`（`app/modules/b/verification_port.py`）：直接对接 D 的持久化人工验收结果与同事务失效逻辑（AI 建议不会替代人工确认）。降级/测试回退类 `UnavailableVerificationPort` 保留如下安全拒绝语义：

- `invalidate_criterion_results` 返回 `accepted=False`，B 把这次作废记为“待 D 处理”，不显示“旧验收已作废”。
- `task_verification_status` 直接抛 503 `VERIFICATION_UNAVAILABLE`。B7-03 因此拒绝完成里程碑并提示“验收服务暂不可用”，不允许跳过检查。

---

## 3. B 依赖且已合入主干的 A/C 接口（仅列出）

| 接口 | 提供方 | 当前状态（已合入 `develop` / `main`） |
| --- | --- | --- |
| `permissions.require_*` / `can()`（A3-05） | A | 已合入并上线 |
| `notify()`（A4-01）、`record_audit()`（A4-02）、`create_action_item()` / `close_action_items_by_source()`（A4-03） | A | 已合入并上线 |
| 上传回执 `receipt_id`（A4-04，含 Supabase Storage 与 PG LOB 回退） | A | 已合入并上线 |
| `progress_projection`（C 根任务加权进度，B3-02 总览复用） | C | 已合入并上线 |
| `extract_requirements`（A7-03）、`suggest_tasks`（A7-04） | A | 已合入并接入 OpenRouter 真实模型（`fake` 仅限开发/测试） |
| `governance_course_service.resolve_course_invite` | C | 已合入并上线 |
| `POST /tasks/{id}/start`、`PATCH /tasks/{id}/progress`（C2-01） | C | 已合入并上线 |

---

## 4. B 提供给 C 的接口（B-5 新增，需要 C 确认）

| 接口 | 说明 |
| --- | --- |
| `GET /api/v1/projects/{id}/criteria-rechecks?task_id=` | 因需求修改而需要重新检查的验收标准（`criterion_id`、`requirement_id`、需求版本号、原因、是否已通知 D）。建议 C 的任务详情页（页面 14）在对应验收标准旁显示“需要重新检查”。目前 B 的需求管理页（09）的证据链和影响预览里已经显示。 |

## 5. B-6 任务计划和 C 的约定（需要 C 确认）

| 约定 | 说明 |
| --- | --- |
| 计划状态 | B 写 `plan_versions`。C 的 `require_task_plan` 只看最新一版：冻结时 `status=frozen`，`snapshot_json.tasks` 是任务对象列表（每项有 `id`，另有编号、内容版本、负责人、验收标准等），C 已按 `entry.get("id")` 读取。解锁时旧版改为 `archived`，并新建一版 `draft`，C 会按现有规则拒绝开始任务（`PLAN_NOT_FROZEN`）。 |
| 锁顺序 | B 所有计划写操作都先 `SELECT ... FOR UPDATE` 锁 `projects` 行，再锁最新 `plan_versions` 行，和 C 执行写入的顺序一致。 |
| 任务表 | 草稿期 B 直接写 `tasks`、`task_requirements`、`task_assignees`（`role=responsible`，取消分配写 `unassigned_at`）、`task_dependencies`、`task_milestones`、`acceptance_criteria`。改动定义时 `tasks.lock_version` 加一；执行字段（`status`、`progress_percent`、`started_at`）B 不改。 |
| 删除限制 | 已开始的任务、还有子任务或被别的任务设为前置的任务不能删；有证据或验收记录的验收标准不能删（外键 RESTRICT 时返回 `CRITERION_HAS_RECORDS`）。 |
| 通知 D | 已开始过的任务修改验收标准时，B 调 `VerificationPort.invalidate_criterion_results`；D 未接入时记在 `b_criterion_invalidations`（`accepted=false`），等 D 接入后可补发。 |

## 6. B-7 任务视图和 C 的约定（需要 C 确认）

| 约定 | 说明 |
| --- | --- |
| 只读查询 | `GET /api/v1/projects/{id}/tasks?view=tree\|board\|list&q=&status=&assignee=&module=&milestone=&sort=&page=&page_size=`，三个视图共用。B 没有改任务状态的接口。 |
| 可以做的状态变化 | 每行的 `transitions` 按 C 的规则计算：负责人、前置任务全部完成、计划已冻结且任务在快照里、学校邮箱已验证、项目可写。未开始到进行中给出 C 的 `POST /api/v1/tasks/{id}/start`（`expected_version` = `tasks.lock_version`）；进行中到待提交只给出 C 的提交页链接（`/tasks/{id}/submit`，C2-08 需要填写内容）。其余状态由提交和验收流程改变，看板上拖不动，并显示原因 `blocked_reason`。C 的规则如果改了，这里需要同步。 |
| 进度 | 用 C 的 `progress_projection` 汇总；任务树数据有问题时退回显示每个任务自己的进度，不报错。 |

## 7. B-8 里程碑、成员变动和 C、D 的约定（需要 C、D 确认）

| 约定 | 说明 |
| --- | --- |
| 里程碑进度 | `GET /api/v1/projects/{id}/milestones`、`.../milestones/{mid}` 每次读取时按关联任务用 C 的 `progress_projection` + `weighted_progress` 汇总，不存表；关联的子任务已经在关联的父任务下面时只算一次。任务树数据有问题时退回每个任务自己的进度。 |
| 风险 | B 只读 D 的 `risks` 表（D 迁移 `0017_d_risks`），不写。一个里程碑的风险 = 记在这个里程碑上的，加上记在它关联任务上的；只算 `open`、`mitigating`，`closed` 不算。返回 `risk: {level, open_count, items:[{id, title, level, status, due_at, owner, task}]}`，`level` 取最高一级（high > medium > low），没有未关闭风险时为 `null`、`open_count` 为 0，页面显示“暂无风险”。数据库里还没有 `risks` 表时整个 `risk` 为 `null`，页面显示“风险：暂无数据”。D 以后如果改了表的字段名或状态值，请告诉 B。 |
| 交付物文件 | `b_milestone_deliverables.file_id` 指向 C 的 `c_logical_files.id`，**不加外键**（加了外键会让 C 的 0010 迁移降级测试失败）；B 写入时检查文件属于本项目。链接用 C 文件页的 `?file=` 参数：`/projects/{id}/files?file={file_id}`。 |
| 阶段交付确认 | `POST .../milestones/{mid}/complete` 调 `VerificationPort.task_verification_status`，只有 `passed` 算验收完成；D 不可用时返回 503 `VERIFICATION_UNAVAILABLE`，不允许跳过。没有关联任务时不调用 D。缺项时返回 409 `MILESTONE_NOT_READY`，`details = {tasks: [{id, code, title, state}], deliverables: [{id, title}]}`。 |
| 成员离开时的任务 | 移出/退出生效时，B 在同一个事务里：先锁小组下的项目行（和 C、B 计划写入同样的顺序），再锁小组；结束 `group_members`、`project_members`；把离开的人在 `task_assignees` 里的记录标 `unassigned_at`，给接手人加一条 `responsible`；`tasks.lock_version + 1`。C 读负责人时请只看 `unassigned_at is null` 的记录。 |
| 未完成任务 | 指 `tasks.status != 'completed'` 且本人是当前负责人的任务。 |

## 8. 教师班级与组队广场（需要 C、D 知悉）

| 约定 | 说明 |
| --- | --- |
| 教师自建班级 | `POST /api/v1/teacher/classes` 由已认证教师直接创建 `courses`（`status="active"`）并写入 `course_memberships(role="teacher")`、`b_course_join_policies(join_mode="direct")` 与 32 位 `c_course_invites` 邀请码；不改 C 的管理员建课审批流（`/api/v1/governance/courses`）。 |
| 邀请码轮换 | `POST /api/v1/teacher/classes/{cid}/invite/rotate` 将旧 `c_course_invites` 置为 `revoked_at=now()` 并签发新 32 位邀请码；学生继续使用第 32 页 `/courses/join` 入班。 |
| 花名册与移出学生 | `GET /api/v1/teacher/classes/{cid}/roster` 仅对本班教师/助教/管理员开放；`DELETE /api/v1/teacher/classes/{cid}/students/{uid}` 仅允许移出未组队学生（已组队返回 409 `STUDENT_IN_GROUP`）。 |
| 组队广场与拖拽分配 | `GET /api/v1/teacher/classes/{cid}/plaza`、`POST /api/v1/teacher/classes/{cid}/groups`、`POST /api/v1/teacher/classes/{cid}/groups/assign`、`POST /api/v1/teacher/classes/{cid}/groups/{gid}/leader` 支持教师建空组、拖拽分人、换组、移回未组队池与指定队长。已立项队伍不可直接拖出成员（返回 409 `GROUP_HAS_PROJECT` 并引导至第 48 页 `/teacher/courses/{cid}/member-changes`）；拖入已立项队伍会同步写入或恢复 `project_members`。 |
| 队伍详情与里程碑进度 | `GET /api/v1/teacher/classes/{cid}/groups/{gid}` 复用 `milestones_service.milestone_briefs(session, project_id)` 聚合里程碑完成度、整体进度百分比、逾期数与 D 的风险等级。 |

