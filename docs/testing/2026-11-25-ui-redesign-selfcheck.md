# Playwright UX Self-Check Report: Lucian UI Redesign

> **历史归档文档**：本文记录对应阶段的规划/验收快照，不代表当前最新状态；当前架构、实时交付状态与限制请以 [README.md](../../README.md) 与 [FRONTEND_STATUS.md](../../FRONTEND_STATUS.md) 为准。

- **Date**: 2026-11-25
- **Branch / HEAD**: `feat/ui-lucian-redesign` (`3909ecf`) in `/Users/motasy_delay/GroupProof-team/groupproof-final`
- **Target Runtime**: `http://localhost:3000` (Next.js dev) + `http://localhost:8000` (Docker FastAPI `/readyz` ready)
- **Test Accounts & Fixtures**: Unauthenticated (`/login`, `/reset-password`), seeded student `b-student1` (project `a40e4c52-9991-4cef-b2a4-f27b626db21e`), seeded teacher `b-teacher` (course `6ce75c39-5ec4-4460-a048-529600a64e8b`), signed in once per role with Playwright `storageState` reuse.
- **Verification Script**: Temporary script outside repository (`/Users/motasy_delay/.gemini/antigravity/brain/3a2b048d-a01a-4b1e-a900-fad1358ff509/scratch/ux-redesign-selfcheck.mjs`).

---

## Executive Summary

- **Final Result**: **24 / 24 checks PASSED, 0 FAILED** across `/login`, `/reset-password`, Student Workspace (`/home`, `/projects`, `/projects/[id]/*`, `/account/profile`), Teacher Workspace (`/home`, `/teacher/courses`, `/teacher/courses/[id]/*`), and `prefers-reduced-motion: reduce`.
- **Console / Runtime Health**: `0` uncaught `pageerror` exceptions, `0` non-favicon `console.error` messages, `0` HTTP `>= 500` responses, and `0` horizontal overflow (`scrollWidth <= clientWidth`) at `375px` on every tested screen.
- **No "animates without action" & No "clicks without feedback"**: Every animated trigger (`ParticleWordmark`, `FloatingField`, `LanguageSwitcher`, `TopNav` indicator, `JellyActionRow` items + `"刷新统计"` + `"创建项目"`, sidebar rail toggle, project collapsible groups, `MorphNav` 5-hub links, 4 toolbar pills, `"创建班级"` `Sheet`, `QuickSwitcher`, `ConfirmDialog`, and mobile drawers) was verified both visually/kinematically and functionally.
- **Regressions Caught & Fixed During Self-Check**: Initial passes identified `2` blocking regressions (Student `/home` `"创建项目"` black-on-blue text contrast failure caused by unlayered `.ux` `color: inherit`, and `375px` mobile drawer `Escape` ignoring keyboard focus on `button.gp-mobile-menu`), both resolved (`e5605bb`, `3909ecf`) and re-verified green.

---

## Bugs Found & Fixed During Self-Check

| ID | Issue Discovered | Root Cause | Fix & Commit | Post-Fix Verification |
| --- | --- | --- | --- | --- |
| **UX-BUG-01** | On Student `/home`, primary `"创建项目"` button (`shared/daily-inbox/DailyApiPages.tsx:547-555`) inside `<JellyActionRow className="ux u416-tl">` rendered dark `#0f172a` text on `#0369a1` background (**`3.01:1` WCAG failure**) and lacked `.gp-rainbow-ring`. | Unlayered rule `:where(.ux) :is(button, input, textarea, select) { color: inherit; }` in `shared/styles/lux-tokens.css` beat Tailwind v4 `@layer utilities` `.text-white`; Student CTA also used raw `<button>` instead of `<Button>`. | `@ui-polish` wrapped `.ux` base resets (`lux-tokens.css:30-56`) in `@layer base { ... }`; `@teacher-ui` updated `DailyApiPages.tsx:538-555` (converting `"创建项目"` at `547-555` to `<Button>` + adding `gp-rainbow-ring` to Teacher link at `538-546`, commit `3909ecf`). | `[PASS]` Student `/home` `"创建项目"`: `rgb(255, 255, 255)` on `rgb(3, 105, 161)` (**`5.93:1`**), `gp-rainbow-ring=true`, click opens Create Project `Dialog`. |
| **UX-BUG-02** | Pressing `Escape` right after clicking `button.gp-mobile-menu` at `375px` did nothing across Student TopNav drawer, Student Project Sidebar drawer, and Teacher Sidebar drawer. | `onKeyDown` was attached only to `<aside>` and `<nav id="gp-topnav-mobile-drawer">`, whereas focus remained on `button.gp-mobile-menu` inside `<header>`. | `@shell-ui` added a cleaned-up `window.addEventListener("keydown", ...)` listener gated on `mobileOpen` in `shared/components/workspace-shell.tsx:904-922` (skipping open dialogs/poppers/`.u448-portal.is-open`) closing `mobileOpen` and restoring focus to `mobileMenuBtnRef` (`e5605bb`). | `[PASS]` Direct `Escape` after burger click closes all 3 mobile drawers (`Student /home`, `Student /projects/[id]`, `Teacher /teacher/courses/[id]`) and restores focus. |

---

## Full Playwright Verification Matrix (`24 / 24` Passed)

### 1. Login & Public Auth Routes (`/login`, `/reset-password`)

| Check | Viewports | Result | Observed Evidence & Interactive Confirmation |
| --- | --- | --- | --- |
| **ParticleWordmark (#378) Geometry & Zero Overlap** | `1440px`, `1024px`, `768px`, `375px` | `PASS` | Slot height `200px` (`1440/1024/768`) / `120px` (`375`); `aria-hidden="true"` canvas + `.sr-only` `"GroupProof"`; `2,059–2,999` non-empty pixels desktop, `1,243` mobile; `0` overlap with `h1` or `LoginCard`; `scrollWidth === clientWidth` at all 4 widths (`1440/1024/768/375`). |
| **ParticleWordmark Pointer Scatter & Click Re-Assemble** | `1440px` | `PASS` | Moving pointer + mouse press over wordmark animated particle bitmap (`checksum 197242 -> 195106`) cleanly within slot bounds. |
| **FloatingField (#025) Notch, Validation & Shake** | `1440px` | `PASS` | Label notch `--gap: 88.4px` on focus; blurring `"bad@"` sets `aria-invalid="true"` + hint `"请检查邮箱格式，例如 name@must.edu.mo"`; plain username `"b-student1"` and valid email `"b.student1@student.must.edu.mo"` draw check state without email errors. |
| **LoginCard Rainbow Ring, Submit Contrast & Dialog** | `1440px` | `PASS` | `section.gp-rainbow-ring::before` renders rotating `conic-gradient` with `pointer-events: none`; submit button renders crisp `rgb(255, 255, 255)`; Forgot password trigger opens `Dialog` (`gp-dialog-anim`) and `Escape` closes it. |
| **LanguagePicker (#448) Across Public & Auth Pages** | `1440px`, `375px` | `PASS` | Trigger opens portaled `role="listbox"` (`z=90`); keyboard `ArrowDown` -> `zh-Hant` translates FloatingField hint to `"請檢查信箱格式，例如 name@must.edu.mo"`; `End` -> `en` switches title to `"Sign in"` while preserving native autonyms (`简体中文 简`, `繁體中文 繁`, `English EN`); `Home` restores `zh-Hans`; `Escape` returns focus to trigger; at `375px` on `/reset-password`, listbox stays within viewport (`right=337 <= 375`, overflow `375/375px`). |

### 2. Student Workspace (`/home`, `/projects`, `/projects/[id]/*`, `/account/profile`)

| Check | Viewports | Result | Observed Evidence & Interactive Confirmation |
| --- | --- | --- | --- |
| **Global TopNav Sliding Indicator** | `1440px` | `PASS` | `.gp-topnav-indicator` visible and ready; hovering `/projects` glides indicator (`left=359..415`) and click navigates to `/projects`. |
| **Home JellyActionRow (#416) & Refresh Spin** | `1440px` | `PASS` | Hover moves `.u416-th` slider (`--l: 112px -> 215px`); `ArrowRight` moves focus to `"加入课程"`; clicking `"创建项目"` opens `CreateProjectModal` (`gp-dialog-anim`, closes on `Escape`); clicking `"刷新统计"` triggers `.gp-refresh-icon.is-spinning`, HTTP `200` `GET /api/v1/home/summary`, and `.gp-jelly-stat-bar` `data-refresh-dir="next"`. |
| **Home Primary CTA Contrast & Rainbow Parity** | `1440px` | `PASS` | `"创建项目"` `<Button variant="default">` inside `.ux.u416-tl` renders `rgb(255, 255, 255)` on `rgb(3, 105, 161)` (**`5.93:1`**) with `.gp-rainbow-ring`. |
| **Student Keyboard `:focus-visible` & LanguagePicker** | `1440px` | `PASS` | `Tab` traversal across header/main controls shows visible blue outline/ring on `6/6` sampled focusable elements (`visibleFocusRings=6/6`). |
| **Project Sidebar (#412) Pill Glide & Collapsible Groups** | `1440px` | `PASS` | Unified white sidebar (`rgb(255, 255, 255)`), active pill behind links (`pillZ=0 / linkZ=1`), `project-nav-plan` toggle updates `aria-expanded` + `inert` cleanly, clicking GitHub navigates and glides active pill (`"需求基线"` -> `"GitHub"`). |
| **Student Settings `<Button>` State & `ConfirmDialog`** | `1440px` | `PASS` | `/projects/[id]/settings` mounts `2` `<Button variant="default">` controls (`disabled` while input empty, confirming `.gp-rainbow-ring` is omitted when disabled); clicking enabled `"确认归档项目"` opens `<ConfirmDialog>` with `gp-dialog-anim` (closed safely via `Escape`); `/account/profile` mounts `LanguageSwitcher`; overflow `1440/1440px`. |
| **Student Mobile TopNav & Project Drawers** | `375px` | `PASS` | `scrollWidth === 375` (`0` overflow) on `/home` and `/projects/[id]/requirements`; compact `LanguagePicker` hides text label (`display: none`); `button.gp-mobile-menu` toggles `.is-open` X glyph and opens drawers; `Escape` closes both `.gp-topnav-mobile-drawer.is-open` and `aside.gp-sidebar.open` and restores focus. |

### 3. Teacher Workspace (`/home`, `/teacher/courses`, `/teacher/courses/[id]/*`)

| Check | Viewports | Result | Observed Evidence & Interactive Confirmation |
| --- | --- | --- | --- |
| **Home JellyActionRow (#416) & Refresh Spin** | `1440px` | `PASS` | All `5` quick actions mount inside `.u416-tl`; `ArrowRight` moves focus to `"教师工作台"`; `"刷新统计"` triggers `.gp-refresh-icon.is-spinning`, HTTP `200` `GET /api/v1/home/summary`, and `.gp-jelly-stat-grid` `data-refresh-dir="next"`; primary link renders white `rgb(255, 255, 255)`. *(See pre-existing `#3370ff` contrast note below.)* |
| **Collapsible Rail (`224px <-> 64px`) & Persistence** | `1440px` | `PASS` | Rail toggle (`TwoBarToggleGlyph`) collapses `aside.gp-sidebar` from `224px` to `64px` (`.is-collapsed`, `aria-expanded="false"`), persists `localStorage["gp:teacher-rail-collapsed"] === "1"` across reload, and restores `224px`. |
| **Create Class Rainbow Button -> `Sheet` & `⌘K` Switcher** | `1440px` | `PASS` | Primary `"创建班级"` `<Button>` displays `.gp-rainbow-ring` conic-gradient on hover and opens `Sheet` (`gp-sheet-right`); `Meta+K` opens `TeacherQuickSwitcher` `Dialog` and `Escape` closes both cleanly. |
| **5-Hub MorphNav (#354), Slides & 4 Toolbar Pills** | `1440px` | `PASS` | `5` `.u354-tab` hubs render inside `[data-testid="teacher-course-nav"]`; hovering hub #3 glides `--mx: 4px -> 116px` and pointer leave returns cleanly to `4px`; navigating forward -> `/groups` triggers `data-slide="right"` and returning -> overview triggers `data-slide="left"`; all 4 toolbar controls (`#teacher-course-switcher` dropdown, invite pill dialog, `#teacher-course-more-menu` dropdown, `[data-testid="roster-toggle-btn"]` `false -> true`) execute real actions. |
| **Teacher Keyboard `:focus-visible` Tab Rings** | `1440px` | `PASS` | `Tab` traversal across Teacher controls shows visible blue `:focus-visible` outlines on `8/8` sampled focusable elements (`visibleFocusRings=8/8`). |
| **Teacher Mobile Layout, Roster `Sheet` & Sidebar `Escape`** | `375px` | `PASS` | `/home` (`375/375px`) and `/teacher/courses/[id]` (`375/375px`) have `0` horizontal overflow; `button.gp-mobile-menu` opens `aside.gp-sidebar.open` and `Escape` closes it cleanly; `[data-testid="roster-toggle-btn"]` opens mobile roster `Sheet` and `Escape` closes it. |

### 4. Reduced Motion (`page.emulateMedia({ reducedMotion: "reduce" })`)

| Check | Viewports | Result | Observed Evidence & Interactive Confirmation |
| --- | --- | --- | --- |
| **`/login` Static ParticleWordmark** | `1440px` | `PASS` | Canvas immediately renders assembled static `"GroupProof"` wordmark (`2,762` pixels) with animations suppressed. |
| **Teacher MorphNav & Routing** | `1440px` | `PASS` | `.u354-pn` computed `transitionDuration === 0s`; clicking 5-hub link still navigates cleanly to `/groups` with zero console/page errors. |

---

## Pre-Existing Out-of-Scope Observations (Not Redesign Regressions)

1. **Teacher `--gp-action` Brand Color Contrast (`4.28:1`)**: On Teacher `/home`, the primary pill (`#3370ff`, defined in `app/globals.css:571`) with white text (`rgb(255, 255, 255)`) measures `4.28:1` contrast (just under `4.5:1` for normal-sized text, though inherited from Stage 14/15 Feishu palette rather than introduced by Lucian styling).
2. **Narrow-Screen Course Header Flex Wrap (`375px`)**: In `teacher/pages/TeacherClassHomeApiPage.tsx:98-140`, the `<div className="min-w-0 flex-1">` header block next to `<div className="flex max-w-full flex-wrap ...">` buttons causes the course title (`"软件工程（B 模块验收）"`) to wrap vertically beside the action buttons at `375px` (observed in `selfcheck-teacher-course-375.png`; file was not part of the redesign changes).
