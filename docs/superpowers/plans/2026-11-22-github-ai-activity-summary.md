# GitHub 活动 AI 摘要 Implementation Plan

> **历史归档文档**：本文记录对应阶段的规划/验收快照，不代表当前最新状态；当前架构、实时交付状态与限制请以 [README.md](../../../README.md) 与 [FRONTEND_STATUS.md](../../../FRONTEND_STATUS.md) 为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为任意软件项目提供可验证、可缓存的 Git 活动 AI 摘要，让列表首屏明确显示“谁提交了什么”，详情页再展示影响、验证、风险和原始证据。

**Architecture:** GitHub 同步继续只保存原始提交快照；服务端新增一个独立的摘要派生层，按 `activity_id + source_revision + prompt_version + input_hash` 生成或命中缓存。C 活动 API 将摘要状态投影到现有活动 DTO，单条和当前页批量生成通过独立命令接口触发；前端列表保持轻量，详情按需读取完整摘要与证据。

**Tech Stack:** FastAPI、SQLAlchemy、Alembic、Pydantic、OpenRouter-compatible AI provider、Next.js App Router、React Query、TypeScript、OpenAPI-generated types、pytest、Vitest/现有前端检查脚本。

**Spec:** `docs/superpowers/specs/2026-11-22-github-ai-activity-summary-design.md`

## Global Constraints

- 提示词必须是平台无关、项目无关模板；项目名、仓库名、任务格式只能作为输入上下文。
- 简略卡片必须显示提交者和实现内容；完整影响、验证、风险、证据和原始来源进入详情。
- AI 结果必须保留 `needs_human_review=true`，不得自动改变任务、证据或活动处理状态。
- GitHub 同步不能因为 AI 不可用而失败；摘要失败时仍可浏览原始活动。
- 结果只能引用本次输入中存在的 evidence id、文件路径和验证记录。
- 缓存必须按来源版本和提示词版本失效；来源变化时旧摘要保留并标记 stale。
- 所有 schema/API 变更都要刷新 OpenAPI 与 `packages/domain/api.generated.ts`。

## Review Focus

- 提交作者与 PR 作者/合并者不同：列表和摘要必须使用规范化输入的 `actor`（测试：作者身份保持）。
- diff 被截断或没有文件补丁：AI 必须返回 `insufficient_context`，不能把提交标题当成实现结论（测试：上下文不足降级）。
- AI 返回不存在的路径、evidence id 或测试结果：服务端拒绝整份结果（测试：证据引用校验）。
- 源 revision 或 prompt version 改变：不得复用旧摘要，旧结果要变成 stale（测试：缓存键与失效）。
- AI 调用失败/重复点击/批量部分失败：原始活动仍可用且请求幂等（测试：失败降级、并发和命中缓存）。

---

### Task 1: 建立平台无关的 AI 摘要输入/输出契约

**Files:**
- Modify: `services/api/app/modules/a/ai/schemas.py`
- Modify: `services/api/app/modules/a/ai/functions.py`
- Modify: `services/api/app/modules/a/ai/__init__.py`
- Modify: `services/api/app/modules/a/ai/openrouter.py`
- Modify: `services/api/app/modules/a/ai/fake_results.py`
- Test: `services/api/tests/test_a_ai_activity_summary.py`

**Interfaces:**
- Produces `ActivityAnalysisInput`, `ActivitySummaryResult`, `summarize_activity(payload, provider=None, usage=None)`。
- `ActivitySummaryResult` 的 `brief.actor.display_name` 必须与输入 actor 对齐；实现点、验证、风险和证据使用固定枚举。

- [ ] **Step 1: Write the failing tests**

  在新测试文件中覆盖：
  - 合法输入可构造，输出包含 `brief.headline`、`brief.implementation`、`details`、`evidence`、`confidence`、`insufficient_context`；
  - stub provider 返回合法摘要时 `summarize_activity` 成功并标记人工复核；
  - 返回未知 evidence id、未知文件路径、actor 不一致或超范围置信度时抛出 `ApiError`，错误码为 `AI_UNAVAILABLE`；
  - diff 截断的 fake provider 结果标记 `insufficient_context=true`。

- [ ] **Step 2: Run tests to verify they fail**

  Run: `cd services/api && .venv/bin/pytest tests/test_a_ai_activity_summary.py -q`
  Expected: FAIL because the new schemas and function do not exist。

- [ ] **Step 3: Implement the contract and validation**

  在 `schemas.py` 定义平台无关的 source/actor/change/context 输入和 brief/details/evidence 输出；在 `functions.py` 用既有 `_run` 接入 provider，并校验 actor、evidence id、文件路径、verification 引用和 `needs_human_review`；在 `openrouter.py` 增加通用系统提示词、JSON schema 和 `summarize_activity` feature；在 `fake_results.py` 生成确定性的本地结果；从 `__init__.py` 导出新类型和函数。

- [ ] **Step 4: Run tests to verify they pass**

  Run: `cd services/api && .venv/bin/pytest tests/test_a_ai_activity_summary.py -q`
  Expected: PASS。

- [ ] **Step 5: Commit**

  ```bash
  git add services/api/app/modules/a/ai services/api/tests/test_a_ai_activity_summary.py
  git commit -m "feat: add generic activity summary contract"
  ```
### Task 2: 读取 GitHub 提交详情并构造规范化输入

**Files:**
- Modify: `services/api/app/modules/a/github.py`
- Modify: `services/api/app/modules/a/github_activity.py`
- Modify: `services/api/app/modules/a/models.py`
- Test: `services/api/tests/test_a_github_activity_summary_input.py`

**Interfaces:**
- Produces `GithubClient.commit_detail(owner, repo, sha, installation_id)`，返回 GitHub commit detail（含 files/patch）；
- Produces `github_activity.build_summary_input(session, activity, link, client, ...) -> ActivityAnalysisInput`；
- `GithubActivity.detail` 中保留来源快照所需的 sha/branch 等字段，diff 不写入原始活动主表。

- [ ] **Step 1: Write the failing tests**

  使用 fake GitHub client 验证：
  - commit detail 请求路径为 `/repos/{owner}/{repo}/commits/{sha}`，非 200 转换为 `_unavailable`；
  - 提交者取 commit 的 `author`/`committer` 规范化结果，不误用 PR 作者；
  - files 的 path/status/additions/deletions/patch 被转换，超长 patch 被截断并设置 `diff_truncated`；
  - 非 commit 活动返回明确的 unsupported/insufficient context，而不是伪造提交 diff。

- [ ] **Step 2: Run tests to verify they fail**

  Run: `cd services/api && .venv/bin/pytest tests/test_a_github_activity_summary_input.py -q`
  Expected: FAIL because commit detail adapter does not exist。

- [ ] **Step 3: Implement the GitHub adapter**

  在 `GithubClient` 增加只读 commit detail 方法；在 `github_activity.py` 增加长度限制、常见凭据脱敏和平台无关输入构造函数。不要在同步循环中调用 AI；只在摘要命令路径按需拉取 detail。

- [ ] **Step 4: Run tests to verify they pass**

  Run: `cd services/api && .venv/bin/pytest tests/test_a_github_activity_summary_input.py -q`
  Expected: PASS。

- [ ] **Step 5: Commit**

  ```bash
  git add services/api/app/modules/a/github.py services/api/app/modules/a/github_activity.py services/api/tests/test_a_github_activity_summary_input.py
  git commit -m "feat: normalize github commit details for summaries"
  ```

### Task 3: 增加摘要缓存表、迁移和服务层

**Files:**
- Modify: `services/api/app/modules/a/models.py`
- Create: `services/api/migrations/versions/0047_a_activity_summaries.py` (after the current develop head `0046`)
- Create: `services/api/app/modules/a/activity_summaries.py`
- Test: `services/api/tests/test_a_activity_summaries.py`

**Interfaces:**
- `ActivitySummary` ORM model keyed by `(activity_id, source_revision, prompt_version, input_hash)`。
- `get_cached_summary(session, activity_id, source_revision, prompt_version, input_hash)`。
- `generate_activity_summary(session, actor, project_id, activity_id, *, provider=None, usage=None)`。
- `mark_stale_summaries(session, activity_id, current_revision)`。

- [ ] **Step 1: Write the failing tests**

  覆盖：
  - 同一缓存键只生成一次，第二次直接返回 ready；
  - source revision 或 prompt version 改变时创建新结果并把旧结果标记 stale；
  - AI 失败记录 failed 和错误码，但不删除原始 `GithubActivity`；
  - 不属于项目、已删除或非 commit 活动不能生成摘要；
  - 数据库唯一约束阻止并发重复缓存。

- [ ] **Step 2: Run tests to verify they fail**

  Run: `cd services/api && .venv/bin/pytest tests/test_a_activity_summaries.py -q`
  Expected: FAIL because the model, migration and service do not exist。

- [ ] **Step 3: Implement model, migration and service**

  新表保存状态、结果 JSON、provider/model、错误信息、输入 hash、source revision、prompt version 和时间戳；服务层负责权限、缓存命中、构造输入、调用 `summarize_activity`、事务提交和 stale 标记。使用现有 AI usage metering 记录调用，不把 diff 写入日志。

- [ ] **Step 4: Run tests and migration checks**

  Run: `cd services/api && .venv/bin/pytest tests/test_a_activity_summaries.py -q && .venv/bin/alembic upgrade head && .venv/bin/alembic downgrade -1`
  Expected: tests PASS; upgrade/downgrade completes without schema errors。

- [ ] **Step 5: Commit**

  ```bash
  git add services/api/app/modules/a/models.py services/api/app/modules/a/activity_summary.py services/api/migrations/versions/0047_a_activity_summaries.py services/api/tests/test_a_activity_summary.py
  git commit -m "feat: persist versioned activity summaries"
  ```

### Task 4: 暴露 C 活动摘要状态和生成 API

**Files:**
- Modify: `services/api/app/modules/c/activity_schemas.py`
- Modify: `services/api/app/modules/c/activity_service.py`
- Modify: `services/api/app/modules/c/activity_router.py`
- Modify: `services/api/app/modules/c/activity_ports.py`
- Modify: `services/api/app/modules/a/activity_summaries.py`
- Test: `services/api/tests/test_c_activity_summary_api.py`

**Interfaces:**
- `ActivityDTO` 增加可选 `ai_summary` 投影：`status`, `summary_id`, `brief`, `source_revision`, `prompt_version`, `needs_human_review`。
- `POST /api/v1/projects/{project_id}/activities/github/{source_id}/summary`：单条生成/重试。
- `POST /api/v1/projects/{project_id}/activities/github/summaries`：接收当前筛选后的 `activity_ids`，返回 accepted/cached/failed。
- `GET /api/v1/projects/{project_id}/activities/github/{source_id}/summary`：读取完整详情。

- [ ] **Step 1: Write the failing tests**

  使用真实测试数据库和 fake provider 验证：
  - list/detail DTO 对 commit 返回摘要状态，对 Feishu 和 PR/CI 不注入错误摘要；
  - 项目成员可以生成；非成员返回现有权限错误；
  - 单条重复请求命中缓存，批量请求每个 ID 独立返回结果；
  - AI_UNAVAILABLE 返回可理解的 503，同时原始活动 GET 仍返回 200；
  - source revision 改变后 GET 返回 stale。

- [ ] **Step 2: Run tests to verify they fail**

  Run: `cd services/api && .venv/bin/pytest tests/test_c_activity_summary_api.py -q`
  Expected: FAIL because DTO fields and routes do not exist。

- [ ] **Step 3: Implement API projection and commands**

  在 C service 的 `activity_data` 读取摘要投影；生成命令复用 C 项目权限和 A 的服务层，不改变活动状态/证据操作；批量接口限制最多当前页 20 条、并发 3，返回逐项状态。更新路由响应模型和错误映射。

- [ ] **Step 4: Export OpenAPI and regenerate client types**

  Run the repository’s API export command, then `npm run api:generate` from the repository root. Confirm generated paths/schemas include the new DTO fields and routes。

- [ ] **Step 5: Run tests to verify they pass**

  Run: `cd services/api && .venv/bin/pytest tests/test_c_activity_summary_api.py -q`
  Expected: PASS。

- [ ] **Step 6: Commit**

  ```bash
  git add services/api/app/modules/c services/api/app/modules/a/activity_summaries.py packages/domain/openapi.json packages/domain/api.generated.ts services/api/tests/test_c_activity_summary_api.py
  git commit -m "feat: expose activity summary API"
  ```

### Task 5: 接入前端 API 客户端和缓存查询

**Files:**
- Modify: `lib/api/c-client.ts`
- Modify: `features/c/c-project-api.tsx` or the existing project API helper file containing `projectApi`
- Modify: `features/c/ActivityApiPages.tsx`
- Test: existing frontend test location for C activity pages, or create `features/c/ActivityApiPages.test.tsx`

**Interfaces:**
- Client methods `activitySummary(projectId, sourceId)`, `generateActivitySummary(projectId, sourceId)`, `generateActivitySummaries(projectId, activityIds)`。
- React Query keys include user/project/source/activity ID and invalidate list/detail after generation。

- [ ] **Step 1: Write the failing tests**

  覆盖列表状态：`not_generated` 显示生成按钮；`pending` 禁止重复点击；`ready` 显示提交者和实现摘要；`failed` 显示重试；`stale` 显示重新生成。验证点击详情不会把完整摘要塞进列表卡片。

- [ ] **Step 2: Run tests to verify they fail**

  Run the project’s focused frontend test command for the new test file.
  Expected: FAIL because client methods and UI states do not exist。

- [ ] **Step 3: Implement client methods and query invalidation**

  使用 generated OpenAPI paths，不手写 fetch URL；生成成功后 invalidate `c-project-activities`、selected detail and summary query。

- [ ] **Step 4: Run focused tests to verify they pass**

  Run the focused frontend test command again.
  Expected: PASS。

- [ ] **Step 5: Commit**

  ```bash
  git add lib/api/c-client.ts features/c features/c/ActivityApiPages.test.tsx
  git commit -m "feat: connect activity summary queries"
  ```

### Task 6: 重构 GitHub 活动页为简略版/详情版

**Files:**
- Modify: `features/c/ActivityApiPages.tsx`
- Modify: `features/c/activity-records.ts` if shared labels/types are needed
- Modify: `docs/C_DAILY_READS.md`
- Modify: `FRONTEND_IMPLEMENTATION_PLAN.md`
- Modify: `FRONTEND_STATUS.md`
- Test: frontend activity page tests and route checks

**Interfaces:**
- List card keeps current filtering, association and history controls, while adding `生成当前页摘要` and per-card summary action.
- Detail panel renders brief, implementation points, impact, verification, risks, evidence, generation metadata and a collapsed raw-source section.

- [ ] **Step 1: Write the failing tests**

  Pin the acceptance behavior:
  - ready card visibly contains actor name/login and implementation text;
  - raw PR/commit body is not rendered in the collapsed list card;
  - detail view renders evidence and raw source only after expansion;
  - batch button sends only current visible commit IDs and reports partial failures;
  - existing activity association/history actions remain available。

- [ ] **Step 2: Run tests to verify they fail**

  Run the focused frontend test command and `npm run check:routes`.
  Expected: new assertions fail before implementation; existing route checks remain the baseline。

- [ ] **Step 3: Implement the two-layer interaction**

  Keep the existing page shell and filters, but replace the repeated large bordered panels with an open activity stream and a compact toolbar. Add a compact `ActivitySummaryBrief` presentation (actor + implementation + AI state), a detail drawer or full-width disclosure with collapsible evidence/source blocks, and a batch action with disabled/loading/partial-failure feedback. Use typography, whitespace, timeline/group separators and semantic status tags as the primary hierarchy; reserve bordered surfaces for focused detail/confirmation regions. Do not remove existing status/association/history actions. Keep source text/PR metadata behind explicit disclosure.

- [ ] **Step 4: Run focused tests and route checks**

  Run the focused frontend test command and `npm run check:routes`.
  Expected: PASS。

- [ ] **Step 5: Commit**

  ```bash
  git add features/c/ActivityApiPages.tsx features/c/activity-records.ts docs/C_DAILY_READS.md FRONTEND_IMPLEMENTATION_PLAN.md FRONTEND_STATUS.md
  git commit -m "feat: show layered AI summaries for github activity"
  ```

### Task 7: 完整验证与回归

**Files:**
- Modify: `docs/A_SHARED_SERVICES.md`
- Modify: `docs/C_DAILY_READS.md` if validation reveals wording gaps

- [ ] **Step 1: Run backend focused suites**

  Run: `cd services/api && .venv/bin/pytest tests/test_a_ai_activity_summary.py tests/test_a_github_activity_summary_input.py tests/test_a_activity_summaries.py tests/test_c_activity_summary_api.py -q`
  Expected: PASS。

- [ ] **Step 2: Run repository checks**

  Run: `npm run lint && npm run typecheck && npm run build && npm run check:routes`
  Expected: all commands exit 0。

- [ ] **Step 3: Review UX states manually**

  Open GitHub activity with no summaries, one ready summary, a failed summary, stale source and a mixed batch. Confirm the first layer shows actor + implementation, details remain opt-in, and raw activity/association/history still work。

- [ ] **Step 4: Update shared service documentation**

  Document the generic prompt contract, cache key, AI failure fallback, human-review boundary and the fact that the first release summarizes commits on demand。

- [ ] **Step 5: Commit verification documentation**

  ```bash
  git add docs/A_SHARED_SERVICES.md docs/C_DAILY_READS.md
  git commit -m "docs: record activity summary contract and verification"
  ```
