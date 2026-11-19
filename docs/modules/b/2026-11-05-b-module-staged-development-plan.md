# B 模块阶段式开发计划（B1–B7：从加入课程到全组确认计划）

状态：待开发。本文是 B 的分阶段实施计划和验收闸门，不代表任何一项已经完成。

- 编写日期：2026-11-05
- 对照基准：`origin/main` `a693f9e`，以及 `origin/B_task`、`origin/A_task`、`origin/C_task`、`origin/D_task`、`origin/develop`
- 范围：B1 我的课程和加入课程、B2 小组和成员变动、B3 创建项目和初始化、B4 需求管理、B5 任务计划、B6 任务三种视图、B7 里程碑
- 不在范围：任务“开始以后”的状态流转（C2）、验收判定（D）、首页/通知/待办页面本身（C1）

---

## 1. 现状盘点

### 1.1 一句话结论

B 负责的 **数据库表大部分已经建好，但后端没有任何 B 业务接口，前端 B 页面全部跑在浏览器本地的演示数据上**。也就是说 B1–B7 的 33 个编号目前都没有达到“做完的标准”。

### 1.2 各部分实际情况

| 位置 | 现在有什么 | 对 B 意味着什么 |
| --- | --- | --- |
| `services/api/app/modules/b/router.py` | 只有 `GET /api/b/ready` | B 的所有接口都要新写 |
| 迁移 `0002`–`0006` | `courses`、`course_members`、`groups`、`group_members`、`projects`、`project_members`、`functional_modules`、`requirements`、`source_references`、`requirement_conflicts`、`conflict_resolutions`、`milestones`、`tasks`、`task_requirements`、`task_assignees`、`task_dependencies`、`acceptance_criteria`、`task_milestones`、`baseline_versions`/`baseline_confirmations`、`plan_versions`/`plan_confirmations` | 主干表可直接复用；缺加入申请、小组邀请、成员变动申请、任务交接、需求/任务版本、交付物、里程碑改期、向导草稿等表 |
| `lib/commands/*.ts`（`setup`、`baseline`、`plan`、`project-create`、`course`、`project`） | 阶段 03–11 写的本地命令：基线草稿/确认/发布、计划草稿/确认/发布/解锁、项目创建 | 业务规则可以照搬到后端，但数据只存在 `localStorage`（`lib/api/mock-service.ts`），换浏览器就没了 |
| `features/course/CourseView.tsx`、`features/project-core/*` | 页面 07–13、18–19、31–37 的界面 | 界面基本可用，要改成调真实接口；“移出成员”等按钮目前直接改本地数据 |
| `features/route-dispatcher.tsx` | 项目页没有 `projectId` 时回退到 `"project-1"`；只有 C 的页面有 `apiMode(...) === "real"` 的真实分支 | B 需要自己的真实分支，并去掉 `project-1` 回退 |
| `origin/B_task` | 最新提交 2026-11-02，全是合并提交；和 main 对比只有 **删除**（45 个文件，-2732 行），没有 B 专属代码 | 不要在它上面继续堆；按第 3 节从最新 main 重建 |
| `origin/A_task`（未合入 main） | A3-05 权限检查、A4-01 通知、A4-02 操作记录、A4-03 待办、A4-04 文件上传、A7-03/A7-04 AI 函数（固定假结果版），迁移 `0017` | B 必须调用这些，不能自己重写；A_task 合入前 B 无法真正接通知/待办/上传/AI |
| A4-05（文件取正文） | 所有分支都没有 | B3-04“刷新后能看到正文”被它卡住，需要先和 A 约定接口 |
| C | `governance_course_service.resolve_course_invite(session, code)`（查邀请码、锁课程行，但不加成员）；C2-01 `POST /tasks/{id}/start`、`PATCH /tasks/{id}/progress`；C 的任务执行要求“B 先锁同一 Project 行”再解锁/发新计划 | B1-02/03 用前者；B6-02 用后者；B5-05 解锁时遵守锁顺序 |
| D | `modules/d/router.py` 只有 `/ready`；迁移 `0014` 有 `verification_runs`、`criterion_results` 等表，没有查询接口 | B5-02（通知 D1-07 作废旧验收）和 B7-03（问 D 任务是否验收完成）需要 D 提供接口；在此之前 B 先定义端口并用“不可用”实现 |

### 1.3 逐项差距

| 编号 | 现状 | 主要缺口 |
| --- | --- | --- |
| B1-01 | 页面 31 读本地数据 | 后端“我加入的课程”查询；Tab/筛选写入 URL |
| B1-02 | 无 | 邀请码查询接口（调 C 的 `resolve_course_invite`）、邮箱验证检查、课程关闭/错误码提示 |
| B1-03 | 无 | 直接加入写 `course_members`；审批模式的加入申请表 + A4-03 待办；防重复 |
| B2-01 | 本地 | 建组接口，创建人写 `group_members(role=leader)` 和 `groups.leader_id` |
| B2-02 | 本地 | 人数上限、已在别组、过截止日期三种拒绝 |
| B2-03 | 无 | 小组邀请表、同课程未入组校验、截止后转老师审批、A4-01 通知 |
| B2-04 | 页面按钮直接删本地成员 | 未完成任务列表 + 逐个指定接手人；无接手人禁用按钮 |
| B2-05 | 页面 36 只有界面 | 组长变更申请 + 每人确认记录 + 最后一人确认后切换 + 全组通知 |
| B2-06 | 页面 37 只有界面 | 退出申请 + 任务交接；截止前直接生效，截止后转老师待办 |
| B2-07 | 页面 48 只有界面 | 老师批准/驳回/要求补充；批准时成员变动与任务交接在同一事务里提交 |
| B3-01 | 本地命令 `createCourseProject` | 后端建项目；每组唯一；带入成员/截止日期/里程碑模板；向导草稿服务端保存 |
| B3-02 | 统计在前端算，有 `project-1` 回退 | 按状态分流的入口；后端实时统计接口 |
| B3-03 | 本地 `saveSetupDraft` | 基本信息保存接口 + 日期校验 + 断点续填 |
| B3-04 | 本地只存文件名 | 接 A4-04 上传 + A4-05 取正文；文本资料直接存正文 |
| B3-05 | 本地 `runMockRequirementAnalysis` | 调 A7-03，异步处理状态，草案合并时不覆盖人工修改，AI 不可用转手动录入 |
| B3-06 | 本地 `conflictsResolved` | 冲突逐个裁决接口（复用 `requirement_conflicts`/`conflict_resolutions`） |
| B3-07 | 无 | 基线审核清单（服务端判定 + 勾选记录） |
| B3-08 | 本地 `confirmBaselineSelf`/`publishBaseline`/`forcePublishBaseline` | 后端确认、冻结快照、组长强推（原因 + 通知未确认的人） |
| B4-01 | 本地筛选 | 需求查询接口（编号/名称/来源/模块/状态 + 分页），URL 筛选 |
| B4-02 | 无版本 | 需求版本表、冻结后改需写原因、保存前的影响预览、关联验收标记“需复查” |
| B4-03 | 无 | 证据链查询（需求→模块→任务→验收标准→证据→验收结果）、两版本对比 |
| B5-01 | 本地 `savePlanDraft` + `validatePlan` | 任务保存接口；跨项目引用拒绝；依赖环检测；每次保存生成任务版本 |
| B5-02 | 本地校验“验收标准非空” | 后端校验；改动已验收任务时通知 D（D1-07） |
| B5-03 | 无 | 调 A7-04、建议列表、逐条采纳、去重 |
| B5-04 | 本地 `confirmAssignmentSelf` | 后端确认记录绑定任务版本，任务改动后自动失效 |
| B5-05 | 本地 `publishPlan`/`unlockPlan` | 后端冻结（全员确认 + 权重校验）、组长解锁（原因 + 重新确认）、全组通知 |
| B6-01 | 本地任务树 | 统一任务查询接口；坏数据（环、孤儿）显式标记；URL 筛选 |
| B6-02 | 本地拖动直接改状态 | 拖动前确认 → 调 C2-01；失败回滚；无权限/前置未完成不能拖 |
| B6-03 | 本地列表 | 组合条件/排序/分页；行内跳 C、D 页面；三视图同一数据源 |
| B7-01 | 本地 | 里程碑列表/详情接口，进度实时算，D 风险占位 |
| B7-02 | 无 | 交付物表：勾选人、时间、关联文件 |
| B7-03 | 无 | 阶段交付确认：问 D 验收状态 + 交付物齐全；缺项列表；通知老师 |
| B7-04 | 无 | 改期记录表（改前/改后/原因）+ 通知老师和全组 |

---

## 2. 外部依赖与约定

| 依赖 | 提供方 | B 用在哪 | 没到位时 B 怎么办 |
| --- | --- | --- | --- |
| A3-05 权限 `permissions.require_*` / `can()` | A（A_task） | 所有 B 写接口 | 阶段 B0 必须先合入；不允许 B 自写权限判断 |
| A4-01 `notify()` | A | B2-03/05/07、B3-08、B5-05、B7-03/04 | 必须等 A_task 合入 |
| A4-02 `record_audit()` | A | 所有状态变化 | 同上 |
| A4-03 `create_action_item()` / `close_action_items_by_source()` | A | B1-03、B2-03/05/06/07 | 同上 |
| A4-04 上传回执 `receipt_id` | A | B3-04、B7-02 | 同上；存储未配置时接口返回 503，B 页面如实显示 |
| A4-05 取正文 | A（**尚无**） | B3-04 | B0 阶段和 A 约定函数签名；B 先支持“添加文本资料”，文件正文显示“正文提取中/不可用” |
| A7-03 `extract_requirements`、A7-04 `suggest_tasks` | A（假结果版） | B3-05、B5-03 | 用 `AI_PROVIDER=fake` 联调；`AI_UNAVAILABLE` 时走人工录入 |
| `resolve_course_invite` | C | B1-02/03 | 已在 main |
| C2-01 任务开始/进度 | C | B6-02 及列表行内按钮 | 已在 main；B 不直接改 `tasks.status` |
| D1-07 作废旧验收、任务验收状态查询 | D（**尚无接口**） | B5-02、B7-03 | B 定义 `VerificationPort`，默认实现返回“不可用”，B7-03 在不可用时拒绝完成并提示“验收服务暂不可用” |

约定：

- **迁移编号**：main 到 `0016`，A_task 占用 `0017`。B 的迁移从 `0018` 开始，每个阶段一个迁移文件，命名 `00xx_b_<主题>.py`。开 PR 前先 rebase 到最新 main 检查编号冲突。
- **代码位置**：后端 `services/api/app/modules/b/`，按主题拆分 `courses_*.py`、`groups_*.py`、`projects_*.py`、`requirements_*.py`、`planning_*.py`、`milestones_*.py`（参照 C 的 `*_router / *_schemas / *_service / *_models` 写法）。前端 `lib/api/b-client.ts` + `features/b/*ApiPage.tsx`，在 `route-dispatcher.tsx` 用 `apiMode("bworkspace") === "real"` 挂载。
- **写接口统一要求**：会话决定身份；带 `expected_version`（对应 `lock_version`）防并发覆盖；带幂等键；CSRF 校验沿用 C 已接入的 A 守卫；成功后写 `record_audit`；通知/待办与业务在同一事务。
- **错误码**：统一 `ApiError(status, CODE, 中文提示)`，前端用 `messages/` 翻译，不在页面里写死错误文字。

---

## 3. 通用完成标准（每个阶段都要满足）

一个阶段只有下面全部打勾，才算“通过验收”，才能开始下一阶段的验收（开发可以提前并行，验收不能跳）。

- [ ] **真实数据**：本阶段页面在 `NEXT_PUBLIC_API_FEATURES` 打开 `bworkspace=real` 时只读写后端，不回退演示数据，不出现 `project-1` 等写死 ID。
- [ ] **后端测试**：新增 `services/api/tests/test_b_<主题>.py`（HTTP 层）和 `test_b_<主题>_postgres.py`（真实 PostgreSQL），覆盖正常、参数错误、未登录、无权限、不存在、版本冲突。
- [ ] **三类越权失败用例**（A_SHARED_SERVICES.md 要求）：学生调老师接口、A 组改 B 组、改归档/冻结对象，全部被拒。
- [ ] **前端端到端**：新增 `e2e/b-<主题>.spec.ts`，跑本阶段“做完的标准”里的每一条。
- [ ] **CI 全绿**：`ruff format --check`、`ruff check`、`alembic upgrade head`、`alembic check`、`pytest -q`、`npm run lint`、`npm run typecheck`、`npm run check:routes`、`npm run build`、`npm run test:e2e`。
- [ ] **记录**：所有状态变化写了 `record_audit`；需要通知的都调了 `notify()`，`dedupe_key` 保证同一件事只通知一次。
- [ ] **文档**：在 `docs/development-stages/stage-reports/` 写本阶段报告：完成了哪些编号、跑了哪些检查、还差什么（对未接通的外部依赖如实写“未完成”）。
- [ ] **演示**：在测试环境用两个学生账号 + 一个老师账号走一遍本阶段流程，截图放 `docs/design/screenshots/b-<阶段>-*.png`。

---

## 4. 阶段划分

总顺序：B0 → B-1 → B-2 → B-3 → B-4 → B-5 → B-6 → B-7 → B-8 → B-9。
每一阶段依赖前一阶段产出的数据（先有课程成员才有小组，先有小组才有项目，先有基线才有任务计划）。

```text
B0 基础对齐
 └─ B-1 课程与加入(B1)
     └─ B-2 小组与成员变动(B2-01~03)
         └─ B-3 项目创建与基本信息(B3-01~04)
             └─ B-4 需求分析与基线冻结(B3-05~08)
                 ├─ B-5 需求管理(B4)
                 └─ B-6 任务计划(B5)
                     ├─ B-7 任务三视图(B6)
                     ├─ B-8 里程碑(B7) + 成员移出/退出的任务交接(B2-04,06,07)
                     └─ B-9 全链路联调与交付
```

说明：B2-04、B2-06、B2-07 都要求“未完成任务先交接”，而任务要到 B-6 才有真实数据，所以把它们放到 B-8 和里程碑一起做；B2-05 更换组长不涉及任务，留在 B-2。

---

### 阶段 B0：分支与基础对齐

**目标**：让 B 有一个干净、能接通 A 公共能力的开发起点。

工作内容：

1. 从最新 main 重建 B 分支：`git fetch origin main && git checkout -B B_task origin/main`。现有 `origin/B_task` 只有合并和删除，没有 B 代码，强推前先和组员确认没人依赖它。
2. 等 A_task 合入 main（或经 A 同意先合入 B_task），确认 `app/modules/a/permissions.py`、`inbox.py`、`audit.py`、`storage.py`、`ai/` 可导入。
3. 搭 B 模块骨架：`modules/b/` 下按主题拆文件；`tests/b_fixtures.py`（造课程、老师、学生、小组、项目）；`lib/api/b-client.ts`；`apiMode("bworkspace")` 开关；`route-dispatcher.tsx` 留真实分支。
4. 写通用前端工具 `useUrlFilters()`：把 Tab、筛选、排序、页码读写到 URL 查询参数（B1-01、B4-01、B6 共用）。
5. 和 A 约定 A4-05 取正文的函数签名；和 D 约定 `VerificationPort`（`invalidate_criterion_results(task_id, reason)`、`task_verification_status(task_ids)`）；把约定写进 `docs/B_INTERFACES.md`。

验收标准：

- [ ] B 分支基于最新 main，`git diff origin/main --stat` 只包含 B 的新增文件，没有误删别人的文件。
- [ ] `GET /api/b/ready` 仍返回 200；`pytest -q` 全绿；新的 `b_fixtures.py` 能在 PostgreSQL 测试里造出“1 课程 + 1 老师 + 4 学生 + 1 小组 + 1 项目”。
- [ ] `apiMode("bworkspace")` 默认 `mock`，打开后 B 页面显示“接口未接入”而不是演示数据。
- [ ] `useUrlFilters()` 有单元或 e2e 用例：改筛选 → 刷新 → 筛选还在；复制链接到新标签页 → 筛选一致。
- [ ] `docs/B_INTERFACES.md` 写清 A4-05 和 D 端口的签名，A、D 负责人在 PR 里评论确认。

---

### 阶段 B-1：我的课程和加入课程（B1-01 ~ B1-03，页面 31–32）

后端：

- `GET /api/v1/me/courses?tab=&status=&q=&page=`：只返回 `course_members` 中 `left_at is null` 的课程，含“待处理”数量。
- `POST /api/v1/course-joins/preview`（邀请码）：调 `resolve_course_invite`，返回老师、组队规则（`grouping_mode`、`min/max_group_size`）、`formation_deadline`、`project_deadline`、加入模式。
- `POST /api/v1/course-joins`：直接模式写 `course_members`；审批模式写新表 `b_course_join_requests(status=pending)` 并 `create_action_item(category="member", source_key=f"join:{id}")` 给老师；老师处理接口 `POST /api/v1/course-joins/{id}/decision`（批准时才写 `course_members`，并 `close_action_items_by_source`）。
- 迁移 `0018_b_course_joins.py`。

前端：页面 31 Tab/筛选走 URL；页面 32 两步流程（输入码 → 预览 → 确认）。

验收标准（对应“做完的标准”）：

- [ ] B1-01：账号只看到自己加入的课程；别人的课程即使知道 ID 也拿不到（404）。切 Tab、筛选后刷新或复制链接，筛选不变。
- [ ] B1-02：邀请码错误、邮箱未验证、课程已关闭（`status` 非 active）分别返回不同错误码，页面显示三种不同提示；邮箱未验证时“下一步”不能继续。
- [ ] B1-03：同一账号连点两次“确认加入”只产生一条成员记录（幂等）；已是成员再加入返回 `ALREADY_MEMBER`。
- [ ] B1-03：审批模式下提交后 `course_members` 里 **没有** 该学生，老师待办页（06）出现一条待办；老师批准后才出现成员记录且待办自动关闭；驳回则不加入并通知学生。
- [ ] 并发测试：两个请求同时加入同一课程，只成功一个。
- [ ] 通用完成标准全部满足。

---

### 阶段 B-2：小组建立、加入、邀请、更换组长（B2-01 ~ B2-03、B2-05，页面 33–34、36）

后端：

- `POST /api/v1/courses/{id}/groups`：建组，创建人写 `group_members(role=leader)` 和 `groups.leader_id`，同一事务。
- `POST /api/v1/groups/{id}/join`：依次检查已在本课程别的组、人数满（`max_group_size`）、过 `formation_deadline` 或 `roster_frozen`；三种分别返回 `ALREADY_IN_GROUP`、`GROUP_FULL`、`FORMATION_CLOSED`。加锁防止最后一个名额被两人同时抢到。
- 邀请：新表 `b_group_invitations`；只能邀请同课程、未入组的人；截止前给被邀请人 `notify()`，接受后入组；截止后改为 `create_action_item` 给老师。
- 更换组长：新表 `b_leader_change_requests`、`b_leader_change_confirmations(request_id, user_id)` 唯一约束；原因必填、候选人必须是本组成员；给每个成员 `create_action_item`；最后一人确认时在同一事务更新 `groups.leader_id`、两人 `group_members.role`，关闭待办，`notify()` 全组。有人拒绝则申请失败。
- 迁移 `0019_b_groups.py`。

前端：页面 33 创建失败时保留表单输入；成功跳页面 34；页面 36 发起 + 确认。

验收标准：

- [ ] B2-01：建组成功后跳到小组详情，创建人显示为组长；故意让请求失败（如重名/网络错误）时，表单内容还在。
- [ ] B2-02：人数已满、已在别组、过截止日期三种情况都加不进去，各自显示原因；后端测试三种都有。
- [ ] B2-02：并发测试：小组只剩 1 个名额时两人同时加入，只成功一个。
- [ ] B2-03：邀请外课程或已入组的人被拒；截止前邀请，被邀请人通知页出现一条通知；截止后邀请，老师待办页出现一条待办，被邀请人不会直接入组。
- [ ] B2-05：候选人非本组成员、原因为空都被拒；同一人确认第二次返回 `ALREADY_CONFIRMED`；最后一人确认前组长不变，确认后组长变更，全组每人收到一条通知。
- [ ] 通用完成标准全部满足。

---

### 阶段 B-3：创建项目和基本信息、资料（B3-01 ~ B3-04，页面 35、07、08 前两步）

后端：

- 向导草稿：新表 `b_project_drafts(group_id unique, payload jsonb, step, lock_version)`；`GET/PUT /api/v1/groups/{id}/project-draft`，每步自动保存。
- `POST /api/v1/groups/{id}/projects`：`projects.group_id` 加唯一约束（每组一个）；同事务写 `project_members`（本组当前成员）、`final_deadline` 取课程 `project_deadline`、按课程里程碑模板写 `milestones`；返回 `project_id`，前端跳 `/projects/{id}/setup`。
- `GET /api/v1/projects/{id}/overview`：返回 `setup_status`/`lifecycle` 决定的入口（草稿→初始化、已冻结→看基线、已归档→只读）和实时统计（任务数、完成数、进度，进度算法沿用 C 的根任务加权口径，避免两套数字）。
- `PATCH /api/v1/projects/{id}/setup/basic`：名称、类型、开始/结束日期（结束 ≥ 开始、不晚于课程截止）、简介；记 `setup_step`。
- 资料：`POST /api/v1/projects/{id}/materials`（文件用 A4-04 `receipt_id`；文本直接存正文），新表 `b_project_materials(id, project_id, kind, receipt_id, title, text_content, extract_status)`；文件正文通过 A4-05 回填。
- 迁移 `0020_b_projects.py`。

前端：去掉 `route-dispatcher.tsx` 的 `"project-1"` 回退；项目列表/首页“进入”用真实 `project_id`。

验收标准：

- [ ] B3-01：同一小组第二次建项目被拒（`PROJECT_ALREADY_EXISTS`），并发两次也只建成一个。新项目自动带上全部组员、课程截止日期、模板里程碑；建完自动跳到初始化页。
- [ ] B3-01：向导填到第二步刷新页面，已填内容和所在步骤都还在；换浏览器登录同一账号也在。
- [ ] B3-02：草稿项目进总览显示“去初始化”，冻结项目显示“查看基线”，归档项目所有编辑按钮不可用；通过接口把一个任务标为完成后重新打开总览，统计数字变化。
- [ ] B3-02：代码里 `grep -rn '"project-1"' features components lib` 无业务回退。
- [ ] B3-03：结束日期早于开始日期、晚于课程截止日期都被拒并标出字段；保存后关闭页面，再打开停在下一步，内容还在。
- [ ] B3-04：添加文本资料后刷新能看到正文全文；上传文件后刷新能看到文件名和提取状态，A4-05 接通后能看到正文（A4-05 未接通时本条记为“未完成”，不得用假正文代替）。
- [ ] 通用完成标准全部满足。

---

### 阶段 B-4：需求分析、冲突处理和基线冻结（B3-05 ~ B3-08，页面 08 后三步）

后端：

- 分析任务：`POST /api/v1/projects/{id}/analysis` 把资料（段落 + `segment_id`）交给 A7-03，放进现有后台任务队列（`modules/tasks`），返回任务 ID；`GET .../analysis/{run_id}` 返回 处理中/失败/完成。新表 `b_analysis_runs`。
- 草案合并：AI 返回的模块/需求写入 `functional_modules`、`requirements(status=draft)`，并记录来源 `source_references`。每条需求加 `origin`（ai/manual）和 `edited_by_human` 标记；**重新分析只替换 `origin=ai 且未被人工改过` 的条目**，人工新增或改过的保留。
- AI 不可用（`503 AI_UNAVAILABLE`）时，页面切换到手动录入，手动接口 `POST/PATCH /api/v1/projects/{id}/requirements` 在草稿期可用。
- 冲突：AI 返回的冲突写 `requirement_conflicts`；`POST .../conflicts/{id}/resolution`（保留左/保留右/合并 + 理由必填）写 `conflict_resolutions`；有 `status=open` 的冲突时“保存并继续”返回 `CONFLICTS_UNRESOLVED`。
- 审核清单：后端按规则算（范围已填、每个模块至少一条需求、每个模块都有负责人）+ 人工勾选记录 `b_baseline_checklist_items`；没全部满足不能 `submit`。
- 基线确认：复用 `baseline_versions`/`baseline_confirmations`。提交时生成 `snapshot_json`；每人只能确认自己的那条；最后一人确认时 `status=frozen`、`frozen_at`、`projects.setup_status=baseline_frozen`。组长强推 `POST .../baselines/{id}/force-freeze` 原因必填，`notify()` 每个未确认的人；非组长调用 403。
- 迁移 `0021_b_requirements_analysis.py`。

验收标准：

- [ ] B3-05：点“开始分析”后页面显示“处理中”，完成后显示需求和模块；用 `AI_PROVIDER` 留空模拟 AI 不可用，页面提示并可手动录入需求，整个初始化流程仍能走完。
- [ ] B3-05：人工改一条 AI 需求、再新增一条手工需求，点“重新分析”后这两条原样保留。
- [ ] B3-06：存在未处理冲突时“保存并继续”被拒；处理冲突不写理由被拒；处理完全部冲突才能进下一步。
- [ ] B3-07：任一检查项不满足时“请大家确认”按钮不可用，接口也拒绝（不能只靠前端禁用）。
- [ ] B3-08：A 不能替 B 确认（403）；同一人确认两次只记一次；最后一人确认后基线冻结，冻结后所有需求/模块编辑接口返回 `BASELINE_FROZEN`，页面编辑按钮全部关闭。
- [ ] B3-08：非组长调强推被拒；组长强推不写原因被拒；强推成功后每个未确认成员收到一条通知，操作记录里能查到原因和未确认名单。
- [ ] 冻结快照：冻结后改数据库里的需求表，`baseline_versions.snapshot_json` 不受影响。
- [ ] 通用完成标准全部满足。

---

### 阶段 B-5：需求管理（B4-01 ~ B4-03，页面 09）

后端：

- `GET /api/v1/projects/{id}/requirements?code=&q=&source=&module=&status=&page=`：分页查询。需求编号（如 `R-001`）项目内唯一、只增不复用。
- 需求版本：新表 `b_requirement_versions(requirement_id, version_no, snapshot, reason, created_by)`。冻结后 `PATCH` 必须带 `reason`，每次生成新版本；草稿期保存也留版本。
- 影响预览：`POST .../requirements/{id}/impact-preview` 返回关联的任务和验收标准；正式保存后把这些验收标准标记 `needs_recheck`（新表或在 `acceptance_criteria` 上加字段），并通过 `VerificationPort` 告诉 D。
- 证据链：`GET .../requirements/{id}/trace` 返回 需求→模块→任务→验收标准→证据（C 的证据查询）→验收结果（D 端口，不可用时标“暂不可用”）。
- 版本对比：`GET .../requirements/{id}/versions?from=&to=` 返回字段级差异。
- 迁移 `0022_b_requirement_versions.py`。

验收标准：

- [ ] B4-01：五种条件任意组合查询结果正确，分页总数正确；筛选写在 URL，刷新/复制链接后一致。
- [ ] B4-02：冻结后不写原因修改被拒；写原因修改后生成新版本，旧版本仍能查到；保存前页面列出受影响的任务；保存后这些任务的验收标准显示“需要重新检查”。
- [ ] B4-03：从一条需求能逐层点开模块、任务、验收标准、证据、验收结果的详情页（D/C 未提供的层级显示“暂不可用”，不显示假数据）；选两个版本能看到差异高亮。
- [ ] 通用完成标准全部满足。

---

### 阶段 B-6：任务计划（B5-01 ~ B5-05，页面 10）

后端：

- 计划草稿：复用 `plan_versions`（绑定当前冻结的 `baseline_version_id`）。任务写 `tasks`、`task_requirements`、`task_assignees`、`task_dependencies`、`task_milestones`、`acceptance_criteria`。
- 任务版本：新表 `b_task_versions(task_id, version_no, snapshot, created_by)`；每次 `PUT /api/v1/projects/{id}/plan/tasks/{task_id}` 生成新版本，`content_version` 递增。
- 校验（服务端 `validate_plan`，规则照搬 `lib/commands/plan.ts`）：模块/需求/父任务/前置任务/里程碑/负责人都必须属于本项目；父子和前置关系都无环（DFS 检测，返回环上的任务）；顶层权重合计 100、子任务合计等于父任务权重；每个任务至少一条验收标准。
- 验收标准改动：任务已有验收记录时，通过 `VerificationPort.invalidate_criterion_results` 通知 D（D1-07）。
- AI 建议：`POST .../plan/suggestions` 调 A7-04 并存 `b_task_suggestions(fingerprint)`；`fingerprint` = 关联需求 + 标准化标题，重复生成不新增；`POST .../suggestions/{id}/adopt` 才写入正式任务草稿，从不覆盖已有人工任务。
- 确认分配：`plan_confirmations` 记录确认时的任务 `content_version`；任一分给该人的任务版本变化后，确认自动失效（查询时比较版本）。
- 冻结/解锁：全员有效确认 + 校验通过 → `status=frozen`；冻结后任务写接口返回 `PLAN_FROZEN`；只有组长能 `unlock`，原因必填，先锁 `projects` 行（与 C 执行写入串行），生成新草稿版本并清空确认；冻结和解锁都 `notify()` 全组。
- 迁移 `0023_b_planning.py`。

验收标准：

- [ ] B5-01：关联别的项目的模块/需求/负责人被拒；构造 A→B→A 依赖被拒并指出环上的任务；每次保存后版本号 +1，历史可查。
- [ ] B5-02：有任务缺验收标准时“确认整体计划”被拒并列出这些任务；修改已验收任务的标准后，D 端口收到作废调用（测试中用假端口断言被调用一次）。
- [ ] B5-03：AI 建议先以列表展示，不采纳不进计划；连续生成两次，同一建议只出现一条；采纳建议不改动任何人工任务。
- [ ] B5-04：成员确认后，组长改了分给他的任务，该成员的确认状态变回“未确认”。
- [ ] B5-05：有人未确认或权重合计不对时冻结被拒，并说明原因；冻结后任务全部只读（接口和按钮都拒绝）；非组长解锁被拒，组长不写原因被拒；解锁后所有人需重新确认；冻结和解锁全组各收到一条通知。
- [ ] C 联调：冻结后 C 的 `POST /tasks/{id}/start` 能正常开始任务；解锁期间 C 拒绝开始（沿用 C 已有规则）。
- [ ] 通用完成标准全部满足。

---

### 阶段 B-7：任务三种视图（B6-01 ~ B6-03，页面 11–13）

后端：

- 一个查询接口 `GET /api/v1/projects/{id}/tasks?view=tree|board|list&q=&status=&assignee=&module=&milestone=&sort=&page=`，三个视图共用，返回同一份任务数据和 `lock_version`。
- 树视图额外返回 `integrity_issues`：环、找不到的父任务、跨项目引用（只读诊断，不自动修）。
- 看板拖动不在 B 改状态：前端确认后调 C2-01；后端返回每张卡片的 `allowed_transitions`（来自 C 的规则：是否负责人、前置任务是否完成）。

前端：三视图的筛选都用 `useUrlFilters()`；共享同一个查询缓存，任一视图操作成功后使三视图缓存同时失效。

验收标准：

- [ ] B6-01：搜索、筛选、展开/收起状态写在 URL，复制链接给另一个账号打开看到同样的筛选；在测试数据库里人为造一个环和一个孤儿任务，树视图明确标出两处坏数据，页面不崩溃。
- [ ] B6-02：拖动卡片先弹确认；确认后调用 C 的接口（网络面板可见请求到 C 的路径，B 没有直接改状态的接口）；C 返回失败时卡片回到原列并提示原因；非负责人、前置任务未完成时卡片拖不动。
- [ ] B6-03：多条件组合 + 排序 + 分页结果正确；行内“开始任务”“提交验收”“查看证据”分别跳到 C、D 对应页面；在看板改了状态，切到列表和树立即一致（不用手动刷新）。
- [ ] 通用完成标准全部满足。

---

### 阶段 B-8：里程碑 + 成员移出/退出与任务交接（B7-01 ~ B7-04、B2-04、B2-06、B2-07）

里程碑后端：

- `GET /api/v1/projects/{id}/milestones`、`GET .../milestones/{mid}`：关联任务、实时进度（任务进度按权重汇总，和 C 口径一致）、截止日期，`risk` 字段留给 D（无数据时 `null`）。
- 交付物：新表 `b_milestone_deliverables(milestone_id, title, done_by, done_at, receipt_id/file_id)`；只有组长能勾选，取消勾选也留记录。
- 确认阶段交付 `POST .../milestones/{mid}/complete`：检查关联任务全部验收完成（`VerificationPort.task_verification_status`）、交付物全部勾选；不满足返回缺项清单；满足则 `status=completed` 并 `notify()` 课程老师。
- 改期：新表 `b_milestone_date_changes(old_deadline, new_deadline, reason, changed_by)`；原因必填；通知老师和全组。

成员变动后端：

- 新表 `b_membership_change_requests(type=remove|leave, status, reason)`、`b_task_handovers(request_id, task_id, from_user, to_user)`。
- 移出（B2-04）：组长发起；接口返回被移出人名下所有未完成任务，每个任务必须指定本组其他成员为接手人。
- 退出（B2-06）：成员发起，原因 + 交接必填；`formation_deadline` 前直接生效，之后 `create_action_item` 给老师。
- 老师处理（B2-07，页面 48）：批准/驳回/要求补充。批准时在 **同一事务** 中：结束 `group_members`/`project_members`、改 `task_assignees`、写交接记录、关待办、通知申请人；任何一步失败整体回滚。
- 迁移 `0024_b_milestones_membership.py`。

验收标准：

- [ ] B7-01：把一个关联任务标为完成后，里程碑进度跟着变；风险位置在 D 无数据时显示占位，不显示假风险。
- [ ] B7-02：组长勾选交付物后刷新还在，能看到谁在什么时候勾的、关联了哪个文件；非组长勾选被拒。
- [ ] B7-03：任务未全部验收或交付物未齐时，确认被拒并逐项列出缺什么；D 端口不可用时提示“验收服务暂不可用”，不允许跳过检查；全部满足后完成，老师收到通知。
- [ ] B7-04：不写原因改期被拒；改期后能查到改前、改后日期和原因；老师和每个组员各收到一条通知。
- [ ] B2-04：被移出人有未完成任务且未逐个指定接手人时，“移出”按钮不可点，接口也拒绝；接手人不能是被移出人自己或非本组成员。
- [ ] B2-06：截止前提交退出立即生效，任务转到接手人；截止后提交只生成老师待办，人还在组里。
- [ ] B2-07：老师批准后，被移出/退出的人名下没有任何未完成任务（测试中断言 `task_assignees` 无残留）；在批准过程中人为注入一次失败（如交接目标已离组），成员和任务都保持原样；驳回/要求补充时申请人收到通知，申请可再次编辑。
- [ ] 通用完成标准全部满足。

---

### 阶段 B-9：全链路联调与交付

**目标**：证明 B 这一段从头到尾在真实环境里走得通，并且与 A、C、D 的接口对得上。

工作内容：

1. 写一条全链路 e2e `e2e/b-full-flow.spec.ts`：学生 A 用邀请码加入课程 → 建组 → 学生 B/C 加入 → 建项目 → 填基本信息、加文本资料 → 分析（fake AI）→ 处理冲突 → 清单 → 全员确认基线 → 建任务和验收标准 → 采纳 AI 建议 → 全员确认分配 → 冻结计划 → 看板开始一个任务（C）→ 里程碑进度变化。
2. 在测试环境（Railway staging）跑一遍，截图存档。
3. 写 `docs/B_DELIVERY.md`：每个编号的完成情况、证据（测试名、截图、PR 链接）、仍依赖 A/D 未接通的条目。
4. 删除或隔离 B 页面的演示数据路径（保留的 mock 只用于本地开发，不在真实模式下出现）。

验收标准：

- [ ] 全链路 e2e 在 CI 和 staging 都通过。
- [ ] `docs/B_DELIVERY.md` 中 33 个编号每个都有：状态（完成 / 部分完成 + 原因）、对应测试、截图。任何依赖 A4-05、D1-07、D 验收查询仍未接通的条目明确标“部分完成”，不得记为完成。
- [ ] C 负责人确认：C 的执行、证据页面能读到 B 冻结的计划和稳定任务编号。
- [ ] D 负责人确认：`VerificationPort` 的作废和查询调用与 D 实现一致。
- [ ] 老师角色走一遍页面 48 审批和里程碑通知，全部符合预期。

---

## 5. 阶段与编号对照

| 阶段 | 编号 | 新增迁移 | 主要外部依赖 |
| --- | --- | --- | --- |
| B0 | — | — | A_task 合入；A4-05、D 端口约定 |
| B-1 | B1-01、B1-02、B1-03 | 0018 | C `resolve_course_invite`、A4-03 |
| B-2 | B2-01、B2-02、B2-03、B2-05 | 0019 | A4-01、A4-03 |
| B-3 | B3-01、B3-02、B3-03、B3-04 | 0020 | A4-04、A4-05 |
| B-4 | B3-05、B3-06、B3-07、B3-08 | 0021 | A7-03、A4-01 |
| B-5 | B4-01、B4-02、B4-03 | 0022 | C 证据查询、D 端口 |
| B-6 | B5-01 ~ B5-05 | 0023 | A7-04、D1-07、C2-01 |
| B-7 | B6-01、B6-02、B6-03 | — | C2-01 |
| B-8 | B7-01 ~ B7-04、B2-04、B2-06、B2-07 | 0024 | D 验收查询、A4-01/03/04 |
| B-9 | 全部 | — | A、C、D 联调 |

## 6. 风险与处理

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| A_task 迟迟不合入 main | B 无法接通知、待办、上传、AI，大部分验收标准无法闭环 | B0 就提出合并请求；必要时经 A 同意先把 A_task 合进 B_task 开发，但 B 的 PR 不能先于 A 合入 main |
| A4-05 尚不存在 | B3-04 无法完成 | 先做文本资料；文件正文标“提取不可用”；在 B_DELIVERY.md 标部分完成 |
| D 没有验收接口 | B5-02、B7-03、B4-03 最后一层无法完成 | 用 `VerificationPort` 隔离；默认“不可用”时拒绝完成，不放行 |
| 迁移编号与他人冲突 | `alembic check` 失败 | 每次开 PR 前 rebase main，必要时改编号 |
| 前端本地命令与后端规则两套不一致 | 页面显示能做但接口拒绝 | 规则以后端为准；前端只做提示，所有禁用都必须有后端拒绝的测试 |
| 并发（抢名额、重复建项目、同时确认） | 数据重复 | 唯一约束 + 行锁 + 幂等键，每阶段都有并发测试 |
