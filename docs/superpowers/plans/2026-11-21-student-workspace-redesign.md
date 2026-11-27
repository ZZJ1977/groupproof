# Student Workspace Redesign Implementation Plan

> **历史归档文档**：本文记录对应阶段的规划/验收快照，不代表当前最新状态；当前架构、实时交付状态与限制请以 [README.md](../../../README.md) 与 [FRONTEND_STATUS.md](../../../FRONTEND_STATUS.md) 为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the student project's flat navigation and blocking initialization wizard with a grouped workspace and policy-driven setup center, while making requirements baselines optional for independent projects.

**Architecture:** A pure student-workspace model defines project navigation groups and setup-card policy. Shared shell and project pages render that model. Backend planning/execution policy distinguishes personal projects from course projects without weakening course rules. Existing routes and integration components are reused.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Tailwind/global CSS, TanStack Query, FastAPI, SQLAlchemy, PostgreSQL, Playwright, pytest.

**Spec:** `docs/superpowers/specs/2026-11-21-student-workspace-redesign.md`

## Global Constraints

- Preserve all existing project routes and real API integrations.
- Do not modify teacher or administrator information architecture.
- Do not remove or fabricate GitHub, Feishu, materials, baseline, task, evidence, contribution, or report data.
- Independent projects do not require a requirements baseline; course projects keep existing baseline and course-rule enforcement.
- Navigation never grants permission; destinations keep server-side authorization.
- All new interactions must be keyboard-operable and responsive down to 375 px.

## Review Focus

- A personal project with `setup_status=not_initialized` must be editable in planning, while an equivalent course project remains blocked.
- An unavailable GitHub or Feishu provider must show retry/unavailable feedback and must not be counted as a completed setup item.
- Archived projects must render grouped navigation and setup status without exposing write controls.
- A no-conflict requirements state must not render an empty conflict workflow.
- Existing UUID deep links and query-based task views must remain valid after navigation grouping.

---

### Task 1: Student workspace policy model

**Files:**
- Create: `lib/ux/student-workspace.ts`
- Create: `scripts/check-student-workspace.mjs`
- Modify: `package.json`
- Modify: `lib/ux/navigation.ts`

**Interfaces:**
- Produces: `projectNavGroups(projectId: string): ProjectNavGroup[]`
- Produces: `buildSetupCards(input: SetupCardInput): SetupCard[]`
- Consumes: existing route paths and project/setup states.

- [ ] **Step 1: Write the failing policy test**

Add assertions that project navigation is grouped into Overview, Plan, Collaborate, Review, and Settings; preserves all existing destination URLs; marks baseline optional for personal projects; and omits conflict work when unresolved count is zero.

- [ ] **Step 2: Run the policy test and verify RED**

Run: `npm run check:student-workspace`

Expected: FAIL because the script or exported policy functions do not exist.

- [ ] **Step 3: Implement the pure policy model**

Implement the exported types/functions, then adapt `projectNavItems` as a compatibility flattening wrapper over `projectNavGroups`.

- [ ] **Step 4: Run the policy test and existing UX checks**

Run: `npm run check:student-workspace && npm run check:ux`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: define grouped student workspace policy`

### Task 2: Grouped student shell and responsive navigation

**Files:**
- Modify: `components/workspace-shell.tsx`
- Modify: `app/globals.css`
- Modify: `e2e/c-shell-api.spec.ts`

**Interfaces:**
- Consumes: `projectNavGroups()` from Task 1.
- Produces: grouped, collapsible project navigation with stable deep links and mobile behavior.

- [ ] **Step 1: Write failing browser assertions**

Assert that a project page renders labelled Plan, Collaborate, and Review groups; GitHub remains `/projects/{id}/github`; setup is no longer a flat primary navigation item; and group toggles expose `aria-expanded`.

- [ ] **Step 2: Run the shell browser test and verify RED**

Run: `npx playwright test -c playwright.workspace-real.config.ts e2e/c-shell-api.spec.ts`

Expected: FAIL because grouped controls are absent.

- [ ] **Step 3: Implement grouped navigation and shell layout**

Render global project context separately from grouped project sections, add accessible expand/collapse controls, keep project identity visible, and update CSS for desktop/mobile density.

- [ ] **Step 4: Run shell test, lint, and typecheck**

Run: `npx playwright test -c playwright.workspace-real.config.ts e2e/c-shell-api.spec.ts && npm run lint && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: regroup student project navigation`

### Task 3: Project overview setup center

**Files:**
- Modify: `features/b/ProjectsApiPages.tsx`
- Create: `features/b/ProjectSetupCenter.tsx`
- Modify: `features/d/ProjectSettingsApiPage.tsx`
- Modify: `e2e/b-projects-real.spec.ts`
- Modify: `services/api/app/modules/b/projects_service.py`
- Modify: `services/api/tests/test_b_projects_postgres.py`

**Interfaces:**
- Consumes: `buildSetupCards()` and existing `GithubRepoBinding` / `FeishuChatBinding`.
- Produces: overview/setup center and course-create redirect to `/projects/{id}`.

- [ ] **Step 1: Write failing frontend and backend tests**

Assert that course creation returns/uses the overview URL, overview renders “项目设置中心” and direct GitHub/Feishu actions, and `/setup` no longer renders numbered wizard tabs.

- [ ] **Step 2: Run targeted tests and verify RED**

Run: `npx playwright test -c playwright.workspace-real.config.ts e2e/b-projects-real.spec.ts && cd services/api && ./.venv/bin/python -m pytest tests/test_b_projects_postgres.py -q`

Expected: FAIL on the old `/setup` redirect and wizard presentation.

- [ ] **Step 3: Implement setup center and redirect**

Create a card-based setup center, reuse binding components in project settings and direct links from overview, retain materials and requirement deep links, and make `/setup` render the same center rather than an ordered gate.

- [ ] **Step 4: Run targeted tests, typecheck, and project API tests**

Run: `npx playwright test -c playwright.workspace-real.config.ts e2e/b-projects-real.spec.ts && cd services/api && ./.venv/bin/python -m pytest tests/test_b_projects_postgres.py -q && cd ../../.. && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: replace project wizard with setup center`

### Task 4: Optional independent-project baseline policy

**Files:**
- Modify: `services/api/app/modules/b/planning_service.py`
- Modify: `services/api/app/modules/b/planning_schemas.py`
- Modify: `services/api/app/modules/b/tasks_view_service.py`
- Modify: `lib/api/b-planning.ts`
- Modify: `features/b/PlanningApiPage.tsx`
- Modify: `services/api/tests/test_b_planning_postgres.py`
- Modify: `services/api/tests/test_b_tasks_postgres.py`
- Modify: `e2e/b-planning-real.spec.ts`

**Interfaces:**
- Produces: `PlanDTO.baseline_required: bool`.
- Consumes: `Project.course_id` as the policy discriminator.

- [ ] **Step 1: Write failing PostgreSQL policy tests**

Create one personal project and one course project with unfrozen setup. Assert personal-plan editing is allowed, course-plan editing is rejected with `BASELINE_NOT_FROZEN`, and task execution readiness ignores baseline only for the personal project.

- [ ] **Step 2: Run targeted backend tests and verify RED**

Run: `cd services/api && ./.venv/bin/python -m pytest tests/test_b_planning_postgres.py tests/test_b_tasks_postgres.py -q`

Expected: FAIL for the personal project because the old policy always requires `setup_status=frozen`.

- [ ] **Step 3: Implement explicit baseline policy**

Add `baseline_required = project.course_id is not None`, use it in planning writers, freeze, view, suggestions, and task execution readiness, and return it in `PlanDTO`.

- [ ] **Step 4: Update planning UI and browser coverage**

Show course-only baseline warnings; for personal projects show requirements as recommended and allow task-plan editing. Keep no-requirement AI suggestions unavailable with the existing explicit error.

- [ ] **Step 5: Run backend, browser, generated-contract, and type checks**

Run: `cd services/api && ./.venv/bin/python -m pytest tests/test_b_planning_postgres.py tests/test_b_tasks_postgres.py -q && cd ../../.. && npm run api:generate && npm run typecheck && npx playwright test -c playwright.workspace-real.config.ts e2e/b-planning-real.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

Commit message: `feat: make personal project baselines optional`

### Task 5: Requirements workspace interaction cleanup

**Files:**
- Modify: `features/b/ProjectsApiPages.tsx`
- Modify: `features/b/RequirementsApiPage.tsx`
- Modify: `features/b/RequirementsSteps.tsx`
- Modify: `e2e/b-requirements-real.spec.ts`

**Interfaces:**
- Consumes: current materials, analysis, conflict, and baseline APIs.
- Produces: a single requirements workspace with conditional conflict UI and no sequential tab gate.

- [ ] **Step 1: Write failing browser assertions**

Assert manual requirements are accessible without AI analysis, no-conflict state has no conflict navigation step, and materials/analysis/baseline actions appear as sections or direct actions.

- [ ] **Step 2: Run requirements browser tests and verify RED**

Run: `npx playwright test -c playwright.workspace-real.config.ts e2e/b-requirements-real.spec.ts`

Expected: FAIL because the current setup route uses ordered steps.

- [ ] **Step 3: Recompose the requirements workspace**

Reuse existing API actions, conditionally render conflicts, keep baseline confirmation visible only when a baseline draft exists, and retain input on failures.

- [ ] **Step 4: Run requirements tests and checks**

Run: `npx playwright test -c playwright.workspace-real.config.ts e2e/b-requirements-real.spec.ts && npm run lint && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: unify materials and requirements workflow`

### Task 6: Student visual system, responsive review, and regression

**Files:**
- Modify: `app/globals.css`
- Modify: `components/common.tsx`
- Modify: `FRONTEND_IMPLEMENTATION_PLAN.md`
- Modify: `FRONTEND_STATUS.md`
- Modify: `docs/development-stages/README.md`
- Modify: `e2e/home.spec.ts`

**Interfaces:**
- Consumes: all preceding student layouts.
- Produces: consistent density, responsive cards/forms, focus states, and documented implementation status.

- [ ] **Step 1: Add failing responsive and keyboard browser checks**

Assert 375/768/1440 widths have no page-level horizontal overflow, project navigation is keyboard reachable, and primary actions remain visible in empty states.

- [ ] **Step 2: Run browser checks and verify RED where layout still fails**

Run: `npx playwright test -c playwright.workspace-real.config.ts e2e/home.spec.ts e2e/c-shell-api.spec.ts e2e/b-projects-real.spec.ts`

Expected: at least one new assertion fails before the final style pass.

- [ ] **Step 3: Apply shared visual and responsive refinements**

Refine spacing, typography, card hierarchy, form grids, empty states, focus-visible treatment, and reduced-motion behavior without changing teacher/admin navigation.

- [ ] **Step 4: Update project documentation**

Record the new student route grouping, setup-center behavior, independent/course baseline split, verification results, and remaining external-service limitations.

- [ ] **Step 5: Run the complete relevant verification matrix**

Run: `npm run lint && npm run typecheck && npm run build && npm run check:routes && npm run check:student-workspace && npm run check:ux && npm run check:i18n && npm run test:workspace-real`

Run backend: `cd services/api && ./.venv/bin/python -m pytest tests/test_a_projects.py tests/test_b_projects_postgres.py tests/test_b_requirements_postgres.py tests/test_b_planning_postgres.py tests/test_b_tasks_postgres.py tests/test_c_execution.py -q`

Expected: PASS with no skipped tests in the targeted backend matrix.

- [ ] **Step 6: Commit**

Commit message: `feat: complete student workspace redesign`

