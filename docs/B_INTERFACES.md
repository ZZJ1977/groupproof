# B 对外接口约定（A4-05、D 验收端口）

状态：**B 侧已定义，待 A、D 负责人确认**。确认方式：在 B_task 的合并请求里评论“同意”或提出修改。确认前，B 只使用下面的“默认实现”，不会假装功能已接通。

- 代码位置：`services/api/app/modules/b/ports.py`
- 单元测试：`services/api/tests/test_b_foundation.py`
- 对应计划：`docs/plans/2026-11-05-b-module-staged-development-plan.md` 第 2 节

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

**默认实现** `UnavailableMaterialTextPort`：总是返回 `status="unavailable"`、空正文、原因“正文提取服务暂未接入”。B3-04 在 A4-05 接通前记为“部分完成”，页面显示“正文提取不可用”，不使用假正文。文本资料（学生直接粘贴文字）不依赖本端口。

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

**默认实现** `UnavailableVerificationPort`：

- `invalidate_criterion_results` 返回 `accepted=False`，B 把这次作废记为“待 D 处理”，不显示“旧验收已作废”。
- `task_verification_status` 直接抛 503 `VERIFICATION_UNAVAILABLE`。B7-03 因此拒绝完成里程碑并提示“验收服务暂不可用”，不允许跳过检查。

---

## 3. B 依赖但已由 A/C 提供的接口（不在本文约定，仅列出）

| 接口 | 提供方 | 状态（2026-11-05） |
| --- | --- | --- |
| `permissions.require_*` / `can()`（A3-05） | A | 在 `origin/A_task`，尚未合入 main |
| `notify()`（A4-01）、`record_audit()`（A4-02）、`create_action_item()` / `close_action_items_by_source()`（A4-03） | A | 同上 |
| 上传回执 `receipt_id`（A4-04） | A | 同上 |
| `progress_projection`（C 根任务加权进度，B3-02 总览复用） | C | 已在 main |
| `extract_requirements`（A7-03）、`suggest_tasks`（A7-04） | A | 同上（固定假结果版） |
| `governance_course_service.resolve_course_invite` | C | 已在 main |
| `POST /tasks/{id}/start`、`PATCH /tasks/{id}/progress`（C2-01） | C | 已在 main |

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
