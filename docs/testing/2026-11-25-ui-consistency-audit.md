# UI/UX Consistency Audit: Student vs. Teacher Workspaces

> **历史归档文档**：本文记录对应阶段的规划/验收快照，不代表当前最新状态；当前架构、实时交付状态与限制请以 [README.md](../../README.md) 与 [FRONTEND_STATUS.md](../../FRONTEND_STATUS.md) 为准。

- **Audit Date**: 2026-11-25
- **Target Repository**: `/Users/motasy_delay/GroupProof-team/groupproof-final`
- **Scope**: Read-only audit comparing the Student end (`student/`, plus student paths in `shared/`) and Teacher end (`teacher/`, plus teacher-scoped paths in `shared/` and `.gp-teacher-shell`/`.gp-teacher-portal` styles in `app/globals.css`). No application source files were modified.
- **Methodology**: Direct code inspection of global/scoped CSS, shared UI primitives, workspace shell/navigation, charts, and active Student/Teacher pages, paired with repo-wide static inventory scans (`67` files in `student/`, `48` files in `teacher/`, `110` files in `shared/`).

---

## Executive Summary

Student and Teacher operate as **two parallel UI design systems inside one Next.js repository** rather than two role views built on shared primitives and semantic tokens:

1. **Dual Theme Scopes & Divergent Surface Grammar (`app/globals.css`)**: Student uses a Sky/Slate palette (`--gp-action: #0369a1`, `--gp-canvas: #f8fafc`, `--gp-ink: #0f172a`) with borderless transparent `.gp-panel` sections (`app/globals.css:329`), floating `26px` page titles (`327`), and `16px` `rounded-2xl` feature cards. Teacher scopes `.gp-teacher-shell` / `.gp-teacher-portal` (`560-592`) to a Feishu/Lark palette (`--gp-action: #3370ff`, `--gp-canvas: #f5f6f7`, `--gp-ink: #1f2329`), boxed white `.gp-page-header` cards (`655-662`), `20px` page titles (`664`), and `12px`-radius cards.
2. **Parallel Primitive & Utility Ecosystems**: Teacher adopts `@/shared/components/ui/button` (`27/48` files), `sheet` (`9/48`), `dialog` (`6/48`), `TeacherConfirmDialog`, `TeacherFeedbackPill`, and `TeacherSegmentedTabs`, while bypassing `common.tsx` (`SaveState` only) and `ui/input` (`0/48`) in favor of `17` per-file copies of `feishuCard` / `feishuInput`. Student bypasses `ui/button` (`3/67` files), `ui/input` (`2/67`), and `ui/tabs` (`0/67`) in favor of `shared/lib/b-ui.ts` (`19/67`), `shared/lib/c-project-api.tsx` (`19/67`), `common.tsx` (`EmptyState` `19`, `Feedback` `27`, `StatusBadge` `24`, `PageHeader` `14`), and custom `compactBtn` / `.gp-segmented` strings.
3. **Asymmetric Global Shell & Split Shared Routes**: Student toggles between a `58px` top-navigation bar (`max-width: 1152px`) on global routes and a fixed `232px` sidebar (`max-width: 1320px`) inside projects (`workspace-shell.tsx:559-560,1139-1160`), whereas Teacher keeps a persistent collapsible `224px -> 64px` rail (`localStorage["gp:teacher-rail-collapsed"]`, `workspace-shell.tsx:42,565,600`), `⌘K` `TeacherQuickSwitcher`, and a secondary sticky 5-hub `TeacherClassLayout` bar. Shared routes (`/home`, `/courses`, `/notifications`, `/action-items`, `/activity`) split via `if (scope === "teacher")` into two separate JSX trees.
4. **Inconsistent Async, Feedback & Destructive Confirmation Flows**: Teacher uses `TeacherConfirmDialog` (modal focus trap, loading Esc/outside-click lock, `preserveWidth`), `TeacherFeedbackPill` (`autoHideMs`, dismiss X, `loading` tone), and card skeletons (`animate-pulse` in 7+ pages). Student still invokes synchronous browser `window.confirm()` (`5` calls), `3` un-portaled inline/overlay `role="dialog"` implementations, non-dismissible `<Feedback>` banners lacking `loading` tone or `role="alert"` on errors, and plain `.gp-empty` text loaders on most pages.
5. **Accessibility & Responsive Gaps**: `.gp-student-workspace` enforces a global `:focus-visible` ring (`app/globals.css:496`), whereas `.gp-teacher-shell` has `0` `:focus-visible` CSS rules and `0` `focus-visible:` utilities in `teacher/` (`TeacherQuickSwitcher` input and custom icon/tab buttons lack explicit focus rings). Conversely, Teacher's `TeacherSegmentedTabs` provides WAI-ARIA `ArrowLeft`/`ArrowRight`/`Home`/`End` + roving `tabIndex`, whereas all `13` raw `role="tablist"` widgets in `student/` lack keyboard arrow navigation. Moreover, the mobile shell drawer switches at `720px` in CSS (`app/globals.css:531`) while its backdrop uses Tailwind `md:hidden` (`768px`, `workspace-shell.tsx:953`).

### Severity Breakdown

| Audit Dimension | High | Medium | Low | Total |
| --- | ---: | ---: | ---: | ---: |
| 1. Design Tokens & Styling | 3 | 2 | 0 | **5** |
| 2. Base UI Components | 3 | 3 | 0 | **6** |
| 3. Shell & Navigation | 2 | 2 | 1 | **5** |
| 4. Async, Feedback & Confirmation States | 2 | 2 | 1 | **5** |
| 5. Interaction & Accessibility | 2 | 1 | 1 | **4** |
| **Total** | **12** | **10** | **3** | **25** |

### Quantitative Inventory Snapshot

| Metric / Import | `student/` (`67` files) | `teacher/` (`48` files) | `shared/` (`110` files) |
| --- | ---: | ---: | ---: |
| Hardcoded hex literals (files w/ hex) | `99` (`7/67` files) | `1,068` (`36/48` files) | `98` in `shared/components/` (`12/16`), `93` in `shared/daily-inbox/` (`2/9`) |
| `var(--gp-*)` token references | `109` | `925` (mostly w/ `#hex` fallback) | `67` (`shared/components/`), `101` (`shared/daily-inbox/`) |
| `@/shared/components/ui/button` | `3` (incl. `CoursesApiPages` teacher branch) | `27` | `12` |
| `@/shared/components/ui/dialog` / `sheet` | `4` / `1` | `6` / `9` | `1` / `1` |
| `@/shared/components/ui/input` / `textarea` | `2` / `0` | `0` / `0` | `6` / `0` |
| `@/shared/components/ui/tabs` | `0` | `0` | `0` |
| `@/shared/lib/b-ui` | `19` (buttons, inputs, cards, helpers) | `20` (18 date/error helpers; **2** import `input`/`label`) | `0` |
| `@/shared/lib/c-project-api` | `19` | `1` (`TeacherNotificationsApiPage`) | `2` |
| `common.tsx` primitives | `Feedback` (`27`), `StatusBadge` (`24`), `EmptyState` (`19`), `PageHeader` (`14`), `Panel` (`11`) | `SaveState` (`2` only) | — |
| Native `window.confirm()` calls | `5` (across `3` files) | `0` | `0` |
| Raw `role="dialog"` outside `ui/dialog` & `ui/sheet` | `3` | `0` | `1` (`NotificationCenterPopover`) |
| Raw `role="tablist"` outside `ui/tabs` & `TeacherSegmentedTabs` | `13` | `0` (`ClassRosterSidebar` uses button grid w/o `tablist`) | `2` active (`workspace-shell.tsx:289`, `HomeInboxPanel`) + `3` legacy mock (`5` total) |

---

## 1. Design Tokens & Styling

### [D1-1] Dual Theme Scopes & Divergent Brand/Semantic Palettes (`Sky/Slate` vs. `Feishu Blue/Ink`)
- **Severity**: `High`
- **Student / Shared Evidence**:
  - `app/globals.css:17-32`: `:root` sets `--gp-canvas: #f8fafc`, `--gp-surface: #ffffff`, `--gp-ink: #0f172a`, `--gp-ink-soft: #475569`, `--gp-muted: #64748b`, `--gp-action: #0369a1`, `--gp-action-hover: #075985`, `--gp-action-soft: #e0f2fe`, `--gp-border: #e2e8f0`, `--gp-border-subtle: #edf2f7`, `--gp-success: #0f766e`, `--gp-warning: #b45309`, `--gp-danger: #b91c1c`.
  - `app/globals.css:272-274,329-332`: `.gp-student-workspace` applies a sky radial canvas gradient and flattens `.gp-panel` (`border: 0; border-radius: 0; background: transparent; box-shadow: none;`).
  - `shared/components/ui/theme-scope.tsx:1-21`: `GpThemeScope` switches between `"default"` and `"teacher"`.
- **Teacher / Shared Evidence**:
  - `app/globals.css:560-592`: `.gp-teacher-shell, .gp-teacher-portal` redefines `--gp-canvas: #f5f6f7`, `--gp-ink: #1f2329`, `--gp-ink-soft: #4e5969`, `--gp-muted: #646a73`, `--gp-subtle: #8f959e`, `--gp-action: #3370ff`, `--gp-action-hover: #245bdb`, `--gp-action-soft: #e8f0fe`, `--gp-action-on-soft: #1d4ed8`, `--gp-border: #dee0e3`, `--gp-border-subtle: #ebedf0`, `--gp-success: #008a5c`, `--gp-warning: #d97706`, `--gp-danger: #d93025`.
  - `app/globals.css:674-680`: `.gp-teacher-shell .gp-panel, .gp-teacher-shell .gp-stat` keeps boxed `background: var(--gp-surface)`, `border-color: var(--gp-border)`, `border-radius: var(--gp-radius-panel)`, `box-shadow: var(--gp-shadow-card)`.
- **Exact Divergence**: Both ends share the `--gp-*` CSS variable names but resolve to different hues, grays, semantic success/warning/danger colors, and surface treatments (`transparent` panel sections in Student vs. bordered white cards in Teacher). Additionally, Student defines `--gp-shadow-soft` (`app/globals.css:29`) while Teacher introduces `--gp-shadow-card`, `--gp-shadow-float`, `--gp-shadow-drawer`, `--gp-surface-subtle`, `--gp-surface-hover`, `--gp-action-on-soft`, and `--gp-subtle` (`564-592`) that do not exist in `:root`.
- **Recommended Unification Plan**: Promote the complete token set (`--gp-surface-subtle`, `--gp-surface-hover`, `--gp-subtle`, `--gp-action-on-soft`, `--gp-shadow-card`, `--gp-shadow-float`, semantic `*-soft` tokens) into `:root` in `app/globals.css`. Align neutral grays and status colors (`--gp-success`, `--gp-warning`, `--gp-danger`) across roles, and keep any intentional role accent override limited to `--gp-action` / `--gp-action-soft` tokens.
- **Estimated Change Impact / Scope**: `1` stylesheet (`app/globals.css`) + visual QA across Student & Teacher portals; low regression risk if fallback variable names stay backward-compatible.

---

### [D1-2] Massive Hardcoded Hex Colors & Non-Tokenized UI Primitives Bypassing CSS Variables
- **Severity**: `High`
- **Student / Shared Evidence**:
  - Static scan: `99` hardcoded hex values in `7/67` `student/` files plus extensive raw Tailwind palette overrides (`slate-*`, `sky-*`, `rose-*`, `emerald-*` in `shared/lib/b-ui.ts:2-8`, `student/projects/MilestonesApiPage.tsx:21`, `TasksApiPage.tsx:47-50,216`).
  - `shared/components/ui/button.tsx:14-16,20`: `tonal` hardcodes `bg-[#e8f0fe] text-[#1d4ed8] hover:bg-[#d6e4fd] active:bg-[#c7dafc]`; `secondary` hover hardcodes `hover:bg-[#bae6fd]`; `destructive` hover hardcodes `hover:bg-[#991b1b]` — breaking Student vs. Teacher theming on `tonal`/`secondary`/`destructive`.
  - `shared/components/ui/input.tsx:5` & `textarea.tsx:5`: hardcode `#dbe3ee`, `#1d2a43`, `#80aafc`, `#e9f1ff`.
  - `shared/components/ui/dialog.tsx:19,26,34-35` & `sheet.tsx:33,44-45,53` & `dropdown-menu.tsx:13,16,20`: hardcode `#14233d`, `#dbe3ee`, `#718097`, `#f2f5fa`, `#dfe6ee`, `#40516c`, `#eef4ff`, `#246bfa`.
- **Teacher / Shared Evidence**:
  - Static scan: `1,068` hardcoded hex values across `36/48` `teacher/` files (top literals: `#646a73`: `186`, `#1f2329`: `151`, `#4e5969`: `103`, `#dee0e3`: `79`, `#3370ff`: `73`, `#d93025`: `70`) plus `93` hexes in `2/9` `shared/daily-inbox/` files — predominantly embedded as CSS variable fallbacks (e.g., `var(--gp-muted,#646a73)`) or raw status badge/pill hexes.
  - `teacher/components/TeacherFeedbackPill.tsx:20-26`: hardcodes `#c7dafc`/`#e8f0fe`/`#1d4ed8`, `#a7f3d0`/`#ecfdf5`/`#008a5c`, `#fecaca`/`#fef2f2`/`#d93025`, `#fde68a`/`#fffbeb`/`#b45309`.
  - `teacher/pages/TeacherClassesApiPage.tsx:247,251,254`: hardcodes `#a7f3d0`, `#ecfdf5`, `#064e3b`, `#047857`.
- **Exact Divergence**: Core primitives in `shared/components/ui/*` bake Student/legacy hex colors into class strings while `teacher/` hardcodes Feishu fallback hexes on nearly every JSX node. Neither side consistently relies on CSS variables without fallback literals.
- **Recommended Unification Plan**: Add semantic soft-status tokens (`--gp-success-soft`, `--gp-success-border`, `--gp-warning-soft`, `--gp-danger-soft`, `--gp-info-soft`) to `:root` in `app/globals.css`. Refactor `button.tsx`, `input.tsx`, `textarea.tsx`, `dialog.tsx`, `sheet.tsx`, `dropdown-menu.tsx`, and `TeacherFeedbackPill.tsx` to read strictly from `--gp-*` variables, and gradually strip inline `#hex` fallbacks in `teacher/`.
- **Estimated Change Impact / Scope**: `7` files in `shared/components/ui/`, `1` file in `app/globals.css`, plus `~36` `teacher/` files and `7+` `student/` files for full hex cleanup.

---

### [D1-3] Per-File Duplicated Card & Input Class Constants (`feishuCard`/`panelClass` vs. `b-ui.ts`/`cardClass`)
- **Severity**: `High`
- **Student / Shared Evidence**:
  - `shared/lib/b-ui.ts:5,8`: defines `input` and `card` (`"rounded-2xl border border-slate-200/75 bg-white/95 p-5 shadow-xs"`).
  - Duplicated locally as `cardClass`, `fieldInputClass`, `compactInput`, `filterInput`: `student/projects/MilestonesApiPage.tsx:21`, `student/projects/TasksApiPage.tsx:47-48`, `student/review/ProjectSettingsApiPage.tsx:35-41`, `student/review/RiskApiPage.tsx:34-35`, `shared/daily-inbox/DailyApiPages.tsx:26`.
- **Teacher / Shared Evidence**:
  - Local `const feishuCard` or `const panelClass` (`"rounded-[12px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] p-5 shadow-[var(--gp-shadow-card)]"`) and `feishuInput`/`inputClass` are copy-pasted across **17** `teacher/` files (`teacher/pages/TeacherDashboardApiPage.tsx:14-15`, `TeacherClassesApiPage.tsx:45-49`, `TeacherClassHomeApiPage.tsx:14-15`, `TeacherActionsApiPage.tsx:45-48`, `TeacherGroupDetailApiPage.tsx:29-30`, `TeacherSettingsApiPage.tsx:33-37`, `TeacherRulesApiPage.tsx:54-57`, `TeacherFilesApiPage.tsx:52-55`, `TeamPlazaApiPage.tsx:34-38`, `TeacherStaffApiPage.tsx:29-32`, `TeacherAnnouncementsApiPage.tsx:41-45`, `TeacherReportsApiPage.tsx:23-24`, `TeacherProjectsApiPage.tsx:17-18`, `TeacherAppealsApiPage.tsx:26-27`, `MemberChangesApiPage.tsx:20-21`, `TeacherNotificationsApiPage.tsx:36-37`, `teacher/components/AppealDetailPanel.tsx:13-17`) plus the teacher branches inside `shared/daily-inbox/DailyApiPages.tsx:27-30` and `student/courses/CoursesApiPages.tsx:32-35`.
- **Exact Divergence**: Instead of a shared `<Card>`/`<Panel>` surface component and `<Input>`/`<Textarea>` primitives, both ends copy-paste slight variations (`p-5` vs `p-0`, `min-w-0` present vs omitted, `rounded-[12px]` vs `rounded-2xl`, `bg-white` vs `bg-[var(--gp-surface)]`).
- **Recommended Unification Plan**: Introduce a shared `<Card>` (or unify `<Panel>` in `shared/components/common.tsx:36-38`) with `padding` / `interactive` variants, and use `ui/input.tsx` + `ui/textarea.tsx` + a shared `<FieldLabel>` instead of per-file `feishuCard` / `cardClass` / `feishuInput` constants.
- **Estimated Change Impact / Scope**: `19` files (`17` `teacher/` + `2` shared/route files) and `5+` `student/` files; mechanical refactor once shared `<Card>`/`<Input>` match spacing/tokens.

---

### [D1-4] Typography & Page Header Scale Mismatch
- **Severity**: `Medium`
- **Student / Shared Evidence**:
  - `app/globals.css:326-328`: `.gp-student-workspace .gp-page-header { margin-bottom: 26px; }`, `.gp-page-title { font-size: 26px; font-weight: 700; letter-spacing: -.025em; color: #0f172a; }`, `.gp-page-description { color: #64748b; font-size: 13px; margin-top: 6px; }`.
  - `shared/components/common.tsx:33`: non-teacher `<PageHeader>` floats transparently on canvas.
  - Button text size varies between `text-sm` (`14px`, `b-ui.ts:2`, `c-project-api.tsx:11-12`), `text-xs` (`12px`, `TasksApiPage.tsx:49-50`, `AcceptanceApiPage.tsx:55`, `RiskApiPage.tsx:37`), and `text-[12px]` (`button.tsx:8`).
- **Teacher / Shared Evidence**:
  - `app/globals.css:655-673`: `.gp-teacher-shell .gp-page-header` wraps the header in a bordered white card (`border: 1px solid var(--gp-border); border-radius: var(--gp-radius-panel); background: var(--gp-surface); padding: 20px; box-shadow: var(--gp-shadow-card)`), sets `.gp-page-title` to `20px`, `font-weight: 600`, `line-height: 1.3`, and `.gp-page-description` to `12px`.
  - `shared/components/common.tsx:12-31` & `CoursesApiPages.tsx:61-69` & `DailyApiPages.tsx:978-989`: Teacher headers render `text-xl font-semibold` (`20px`) inside `feishuCard` with a `20px` accent icon.
- **Exact Divergence**: Student H1 is `26px / 700` floating on the canvas; Teacher H1 is `20px / 600` (`6px` smaller) inside a full-width card container, and Student raw buttons (`14px`) are larger than shared `<Button>` (`12px`).
- **Recommended Unification Plan**: Establish one typographic hierarchy in `app/globals.css` (`--gp-title-size`, `--gp-section-title-size`, `--gp-control-text: 13px`) and decide on a single `<PageHeader>` container convention (either both clean canvas headers with optional summary strip, or unified header card) in `shared/components/common.tsx:10-34`.
- **Estimated Change Impact / Scope**: `app/globals.css`, `shared/components/common.tsx`, `shared/components/ui/button.tsx`, plus `~12` inline Teacher `<h1>` header cards.

---

### [D1-5] Border Radius, Surface Hierarchy & Elevation Divergence
- **Severity**: `Medium`
- **Student / Shared Evidence**:
  - `app/globals.css:59-61`: `:root` defines `--gp-radius-control: 6px; --gp-radius-panel: 8px; --gp-radius-pill: 999px;`.
  - `app/globals.css:338-350,397-411`: `.gp-student-workspace .gp-stat` (`14px` radius, lifts `translateY(-1px)` on hover), `.gp-surface-card` & `.gp-section[data-surface="true"]` (`16px` radius), `.gp-student-workspace .gp-badge` (`999px` pill, `352`), `b-ui.ts:8` (`rounded-2xl` = `16px`, `rounded-lg` = `8px`).
- **Teacher / Shared Evidence**:
  - `app/globals.css:587-592,720-727`: `.gp-teacher-shell` sets `--gp-radius-control: 8px; --gp-radius-panel: 12px; --gp-radius-pill: 9999px; --gp-shadow-card: 0 1px 2px rgba(31, 35, 41, 0.04);`, while `.gp-card-interactive:hover` (`723-727`) lifts with `var(--gp-shadow-float)` and `border-color: rgba(51, 112, 255, 0.45)`. Base `.gp-badge` (`219`) stays `border-radius: 4px` (not overridden in `.gp-teacher-shell`), while Teacher's custom status pills (`TeacherClassLayout.tsx:354`, `TeamPlazaApiPage.tsx`) use `rounded-full`.
- **Exact Divergence**: Radius scale differs across `:root` (`6px/8px`), Teacher (`8px/12px`), Student Tailwind (`8px/16px`), and `button.tsx:8` (`6px`), and hover elevation applies to all `.gp-stat` tiles in Student (`346-350`, even non-clickable KPIs) whereas Teacher limits lift animation to `.gp-card-interactive` (`723`).
- **Recommended Unification Plan**: Unify radius tokens in `:root` (`--gp-radius-control: 8px`, `--gp-radius-panel: 12px`, `--gp-radius-pill: 9999px`), bind `button.tsx` and `input.tsx` to `rounded-[var(--gp-radius-control)]`, and apply hover lift strictly to interactive/clickable cards (`.gp-card-interactive`).
- **Estimated Change Impact / Scope**: `app/globals.css`, `shared/components/ui/*`, `shared/lib/b-ui.ts`, and `student/` cards (`rounded-2xl` -> `rounded-[var(--gp-radius-panel)]`).

---

## 2. Base UI Components

### [D2-1] Button Fragmentation: `ui/button.tsx` vs. `b-ui.ts` / `c-project-api.tsx` / Ad-hoc Local Strings & `pill`/Danger Inconsistencies
- **Severity**: `High`
- **Student / Shared Evidence**:
  - Only `3/67` files in `student/` import `@/shared/components/ui/button` (`CoursesApiPages.tsx:10` for its teacher branch, `GithubRepoBinding.tsx:8`, `FeishuChatBinding.tsx:8`).
  - `19/67` files use `shared/lib/b-ui.ts:2-4` (`button`, `secondary`, `dangerButton`), where `dangerButton` is soft rose (`border-rose-200 bg-rose-50 text-rose-700`) and buttons use `rounded-lg text-sm min-h-9`.
  - Other pages use `shared/lib/c-project-api.tsx:11-12` (`apiButton`/`apiPrimaryButton`), or local strings like `compactBtn`/`compactSecondary` (`TasksApiPage.tsx:49-50`, `RequirementsApiPage.tsx:36-37`, `AcceptanceApiPage.tsx:55`, `RiskApiPage.tsx:37-39`), or inline `bg-emerald-600` (`TasksApiPage.tsx:216`, `RequirementsApiPage.tsx:140`) / `bg-sky-600` (`EvidenceApiPage.tsx:506`, `ProjectFilesApiPage.tsx:136`).
- **Teacher / Shared Evidence**:
  - `27/48` files import `@/shared/components/ui/button` (`rounded-[6px] text-[12px]`).
  - Teacher inconsistently mixes `pill` and rectangular buttons on the same screen (`TeacherClassesApiPage.tsx:236` `pill` vs `262` no `pill` vs `269` `pill`; `TeacherClassHomeApiPage.tsx:126,133` `pill` vs `316` no `pill`).
  - Because `Button variant="destructive"` (`shared/components/ui/button.tsx:20`) only has a solid `#b91c1c`/`--gp-danger` fill, Teacher hacks soft danger buttons via `variant="outline"` + hardcoded red utility overrides (`teacher/components/ActionCard.tsx:108-113`, `AppealDetailPanel.tsx:296-299`, `StudentProfileDrawer.tsx:150`, `TeacherSettingsApiPage.tsx:583-587`, `TeacherFilesApiPage.tsx:693-696`).
- **Exact Divergence**: Student renders `min-h-9 text-sm rounded-lg` native `<button>` strings without `loading`/`preserveWidth`; Teacher renders `h-8/h-9 text-[12px]` `<Button>` components with mixed `pill` shapes and `outline` red overrides.
- **Recommended Unification Plan**: Standardize on `@/shared/components/ui/button.tsx` across both ends. Add a `destructive-outline` (soft danger) variant to `buttonVariants`, establish an explicit rule for `pill` vs rectangular radius (`--gp-radius-control`), and deprecate `b-ui.ts` button exports, `apiButton`/`apiPrimaryButton`, and per-file `compactBtn` strings.
- **Estimated Change Impact / Scope**: `shared/components/ui/button.tsx` + ~35 Student files + `5` Teacher files using soft-danger overrides.

---

### [D2-2] Form Inputs Bypass `ui/input.tsx` & `ui/textarea.tsx`; Cross-Domain Leak of `b-ui.ts` into Teacher
- **Severity**: `High`
- **Student / Shared Evidence**:
  - `shared/components/ui/input.tsx:5` & `textarea.tsx:5` are adopted by only `2/67` Student files (`GithubRepoBinding.tsx:9`, `FeishuChatBinding.tsx:9`) and `0/67` for `Textarea`.
  - Student pages mix `b-ui.ts:5` (`input`), `c-project-api.tsx:13` (`apiInput`), `CoursesApiPages.tsx:439`, `ProjectSettingsApiPage.tsx:38-41` (`fieldInputClass`/`fieldTextareaClass`), `TasksApiPage.tsx:48` (`filterInput`), `RiskApiPage.tsx:34` (`compactInput`), and `DailyApiPages.tsx:26` (`inputClass`).
- **Teacher / Shared Evidence**:
  - `0/48` Teacher files import `@/shared/components/ui/input` or `textarea`.
  - At least `10` Teacher files copy-paste `const feishuInput` / `inputClass` (`TeacherClassesApiPage.tsx:47-48`, `TeacherActionsApiPage.tsx:47-48`, `TeacherFilesApiPage.tsx:54-55`, `TeacherRulesApiPage.tsx:56-57`, `TeacherSettingsApiPage.tsx:35-36`, `TeacherStaffApiPage.tsx:31-32`, `TeacherAnnouncementsApiPage.tsx:43-44`, `TeamPlazaApiPage.tsx:36-37`, `AppealDetailPanel.tsx:15-16`, `DailyApiPages.tsx:29-30`, `CoursesApiPages.tsx:34-35`).
  - Conversely, `teacher/components/ClassRosterSidebar.tsx:7,155` and `teacher/components/StudentProfileDrawer.tsx:15,158,163` import Student's `input`/`label` directly from `@/shared/lib/b-ui` — applying Student's `focus:border-sky-500` ring inside Teacher drawers.
- **Exact Divergence**: `ui/input.tsx` and `ui/textarea.tsx` are hardcoded to legacy `#dbe3ee` / `text-[12px]` / `rounded-[6px]`, causing both ends to abandon them in favor of `15+` ad-hoc input class strings and creating an accidental `b-ui.ts` Sky-focus leak inside Teacher's roster/profile drawers.
- **Recommended Unification Plan**: Refactor `shared/components/ui/input.tsx` and `textarea.tsx` to use `--gp-radius-control`, `--gp-border`, `--gp-surface`, `--gp-ink`, `--gp-action` focus styles, and consistent sizing (`sm`/`default`), add a `<FieldLabel>` export, and migrate all Student inputs/textareas, Teacher `feishuInput` strings, and `ClassRosterSidebar`/`StudentProfileDrawer` `b-ui` imports onto those primitives.
- **Estimated Change Impact / Scope**: `shared/components/ui/input.tsx`, `textarea.tsx`, `2` Teacher drawer/sidebar components, `10+` Teacher pages, and `20+` Student files.

---

### [D2-3] Unused `ui/tabs.tsx` vs. `TeacherSegmentedTabs` vs. Student Raw `.gp-segmented` & Inline `role="tablist"`
- **Severity**: `High`
- **Student / Shared Evidence**:
  - `shared/components/ui/tabs.tsx:17-57` (Radix Tabs supporting `"underline"` and `"segmented"`) has **0** imports in `student/` and `teacher/`.
  - Student instead uses CSS-styled `.gp-segmented` (`app/globals.css:364-396`) with raw `role="tablist"` (`CoursesApiPages.tsx:314`, `MyProjectsApiPage.tsx:371`, `ActivityApiPages.tsx:850,891`, `GithubStatsChart.tsx:157,175`, `ContributionApiPage.tsx:266`, `ContributionCharts.tsx:81`), `<nav>` link strips (`TasksApiPage.tsx:271`), or `role="group"` (`RequirementsApiPage.tsx:154`), plus `2` active `shared/` raw `role="tablist"` controls (`shared/components/workspace-shell.tsx:289` in `NotificationCenterPopover` and `shared/daily-inbox/HomeInboxPanel.tsx:253`), un-tokenized Tailwind `bg-slate-100` `role="tablist"` strips (`ProjectOverviewPanels.tsx:230-253,560-587`, `RequirementsApiPage.tsx:356-370`, `PlanningApiPage.tsx:437`, `ProjectDiscussionPreviewPage.tsx:362`), and a plain `<button>` drawer tab strip omitting `role="tablist"` / `role="tab"` altogether (`ReportApiPage.tsx:1433`).
- **Teacher / Shared Evidence**:
  - `teacher/components/TeacherSegmentedTabs.tsx:29-174` provides a full custom tab component (`variant="pill" | "segmented" | "underline"`, `size="sm" | "md"`, optional icons/badges, `<Link>` nav mode, and keyboard arrows) used across Teacher pages (`TeacherProjectsApiPage.tsx`, `TeacherClassesApiPage.tsx`, `TeacherActionsApiPage.tsx`, `CoursesApiPages.tsx:94`).
  - Exception inside Teacher: `teacher/components/ClassRosterSidebar.tsx:162-196` builds a custom 3-button `grid-cols-3` filter strip instead of `TeacherSegmentedTabs` or `role="tablist"`.
- **Exact Divergence**: Three separate tab implementations coexist (`ui/tabs.tsx` unused, `TeacherSegmentedTabs` in Teacher, and `13+` raw CSS/Tailwind tablists in Student).
- **Recommended Unification Plan**: Promote `TeacherSegmentedTabs` to `shared/components/ui/segmented-tabs.tsx` (or fold its link-nav, `pill` variant, and badge support into `shared/components/ui/tabs.tsx`) using `--gp-*` tokens, and migrate all Student `.gp-segmented`/inline `role="tablist"` strips and `ClassRosterSidebar.tsx:162-196` onto it.
- **Estimated Change Impact / Scope**: `1` shared primitive promotion + `13` Student/shared files + `teacher/` import path update.

---

### [D2-4] Un-Portaled Student Dialogs & Drawers vs. Radix `Dialog` / `Sheet` / `DetailDrawer`
- **Severity**: `Medium`
- **Student / Shared Evidence**:
  - `4` Student files import `@/shared/components/ui/dialog` (`CreateProjectModal.tsx`, `AttachCourseControl.tsx`, `ProjectOverviewPanels.tsx:21,551`, `ProjectFilesApiPage.tsx:7,191`), `1` imports `ui/sheet` (`ProjectFilesApiPage.tsx:8`), and `2` use `DetailDrawer` (`shared/components/common.tsx:51-56`, `ActivityApiPages.tsx:1281`).
  - `3` high-traffic Student modals/drawers bypass Radix primitives completely: `student/projects/TasksApiPage.tsx:355-373` (renders an inline `<div role="dialog" aria-modal="true">` inside page content with no portal or backdrop), `student/review/ReportApiPage.tsx:1406-1431` (hand-rolled `fixed inset-0` drawer instead of `Sheet`/`DetailDrawer`), and `student/execution/MarkdownPreview.tsx:318-350` (hand-rolled `fixed inset-0` figure zoom dialog instead of `Dialog`).
  - `DetailDrawer` (`common.tsx:52`, `app/globals.css:487-490`) sets `modal={false}` and pushes `.gp-content` `padding-right: 584px` on `>=1024px`.
- **Teacher / Shared Evidence**:
  - `teacher/` has `0` raw `role="dialog"` blocks, consistently wrapping modals and side drawers in Radix `Dialog` / `Sheet` (`TeacherConfirmDialog.tsx:83-140`, `TeacherQuickSwitcher.tsx:246`, `TeacherRulesApiPage.tsx:812-968`, `TeacherFilesApiPage.tsx:1136-1168`, `TeacherClassLayout.tsx:534-545`, `StudentProfileDrawer.tsx:8-14`). Teacher drawers always overlay without shifting `.gp-content`.
- **Exact Divergence**: Teacher enforces Radix `Dialog`/`Sheet` portal + overlay semantics everywhere; Student retains 3 raw `role="dialog"` implementations plus a `modal={false}` content-pushing `DetailDrawer`.
- **Recommended Unification Plan**: Replace raw `role="dialog"` blocks in `TasksApiPage.tsx:355`, `ReportApiPage.tsx:1406`, and `MarkdownPreview.tsx:318` with `Dialog`/`Sheet`/`ConfirmDialog`, and document/standardize when drawers overlay (`Sheet`) vs. dock side-by-side (`DetailDrawer`).
- **Estimated Change Impact / Scope**: `3` Student component refactors; zero backend/API impact.

---

### [D2-5] `common.tsx` Primitives (`PageHeader`, `EmptyState`, `StatusBadge`, `ProgressBar`) Bypassed in Teacher
- **Severity**: `Medium`
- **Student / Shared Evidence**:
  - Student imports heavily from `@/shared/components/common.tsx`: `Feedback` (`27`), `StatusBadge` (`24`), `EmptyState` (`19`), `PageHeader` (`14`), `Panel` (`11`), `Avatar` (`9`), `ProgressBar` (`4`), `StateBlock` (`4`), `Section` (`3`), `DetailDrawer` (`2`).
- **Teacher / Shared Evidence**:
  - `teacher/` imports **only** `SaveState` (`2` files) from `common.tsx`, even though `PageHeader` (`common.tsx:12-32`) and `EmptyState` (`common.tsx:92-104`) explicitly branch on `useGpThemeScope() === "teacher"`!
  - Instead, Teacher reimplements:
    - Inline header cards (`TeacherDashboardApiPage`, `TeacherClassesApiPage`, `TeacherActionsApiPage`, `DailyApiPages.tsx:156+`, `CoursesApiPages.tsx:61`)
    - Custom empty blocks (`TeamPlazaApiPage.tsx:568-575`)
    - Custom progress bars (`teacher/components/GroupProgressBar.tsx:54-68`, `ProjectOverviewCard.tsx:123-135`, `TeacherGroupDetailApiPage.tsx:484-494`) instead of `ProgressBar` (`common.tsx:78-80`)
    - Custom status pills (`TeacherClassLayout.tsx:352-361`) instead of `StatusBadge` (`common.tsx:71-76`, whose `.gp-badge` in `app/globals.css:219` renders `4px` square corners because `.gp-teacher-shell` doesn't override `.gp-badge` to `999px` pill like `.gp-student-workspace` at `352`).
- **Exact Divergence**: `common.tsx` maintains dead/underused Teacher branches for `PageHeader` and `EmptyState`, while actual Teacher pages author bespoke equivalents for headers, empty states, progress bars, and status badges.
- **Recommended Unification Plan**: Make `common.tsx` (`PageHeader`, `EmptyState`, `StatusBadge`, `ProgressBar`, `Panel`) the canonical cross-role component layer (upgrading `EmptyState` to show the Teacher circular icon style cleanly across both roles, and `ProgressBar` to support risk-level color tones), then adopt them across Teacher pages.
- **Estimated Change Impact / Scope**: `shared/components/common.tsx`, `app/globals.css` (`.gp-badge` pill unification), plus gradual adoption in `~15` `teacher/` files.

---

### [D2-6] Table Styling & Scroll Wrapper Divergence (`.gp-table` vs. Raw Tailwind Tables)
- **Severity**: `Medium`
- **Student / Shared Evidence**:
  - `3` Student files use `.gp-table-wrap` + `.gp-table` (`student/execution/CourseFilesApiPage.tsx:155`, `ProjectFilesApiPage.tsx:220`, `student/review/ContributionApiPage.tsx:580-581`, styled by `app/globals.css:211-216,334-337`).
  - `5` Student files write raw `<table>` elements with bespoke cell padding/header borders (`EvidenceApiPage.tsx:591`, `MilestonesApiPage.tsx:281`, `PlanningApiPage.tsx:380`, `RequirementsApiPage.tsx:264,482`, `TasksApiPage.tsx:564`).
- **Teacher / Shared Evidence**:
  - `0` files in `teacher/` use `.gp-table`; custom tables appear in `teacher/charts/ActivityRanking.tsx:18` (`min-w-[560px] text-xs`) and `teacher/pages/TeacherGroupDetailApiPage.tsx:291` (`w-full border-collapse text-sm`), styled manually with `--gp-border` / `--gp-surface-hover` because `.gp-teacher-shell` has no `.gp-table` CSS rules.
- **Exact Divergence**: `.gp-table` styling is scoped only to base `:root` (`app/globals.css:212-216`) and `.gp-student-workspace` (`334-337`), leaving both Teacher tables and `5` Student table-heavy pages on one-off Tailwind classes with varying font sizes (`text-xs` vs `text-sm`), min-widths, and row hover rules.
- **Recommended Unification Plan**: Theme `.gp-table-wrap` and `.gp-table` using `--gp-*` variables (adding `.gp-teacher-shell .gp-table` token alignment or a shared `shared/components/ui/table.tsx` primitive), and migrate all `7` raw table instances in `student/` and `teacher/`.
- **Estimated Change Impact / Scope**: `app/globals.css` + `5` Student files + `2` Teacher files.

---

## 3. Shell & Navigation

### [D3-1] Divergent Global Shell Architecture: Student Top-Nav vs. Teacher Collapsible Sidebar & Container Widths
- **Severity**: `High`
- **Student / Shared Evidence**:
  - `shared/components/workspace-shell.tsx:559-560,1139-1160` & `app/globals.css:176-186,324-325`: Student switches layout modes based on route—non-project routes (`isGlobalStudentTopNav`) hide the sidebar completely in favor of a `58px` top nav (`max-width: 1152px`, `padding: 28px 28px 56px`), while `/projects/[id]` routes mount a fixed `232px` sticky sidebar (`60px` topbar, `max-width: 1320px`, `padding: 30px 36px 56px`) with collapsible plan/collaborate/review nav groups (`1084-1108`) and a header project-switcher dropdown (`981-1023`).
- **Teacher / Shared Evidence**:
  - `shared/components/workspace-shell.tsx:42,561-606,954-979` & `app/globals.css:606-654,732-762`: Teacher always renders a `224px` left rail (`56px` opaque topbar, `padding: 20px 28px 44px`, `max-width: 1570px` inherited from base `.gp-content` at `192`), collapsible to a `64px` icon rail persisted in `localStorage["gp:teacher-rail-collapsed"]`.
- **Exact Divergence**: Sidebar widths (`232px` non-collapsible vs `224px <-> 64px` collapsible), topbar heights (`58px`/`60px` blurred vs `56px` opaque), content max-widths (`1152px`/`1320px` vs `1570px`), and content padding all diverge between Student and Teacher.
- **Recommended Unification Plan**: Standardize shared shell chrome constants (single `56px` topbar height, unified desktop horizontal content padding `28px`, consistent `224px` or `232px` rail width and optional rail collapse support in Student project mode, plus explicit max-width tokens `--gp-container-prose` vs `--gp-container-wide`).
- **Estimated Change Impact / Scope**: `app/globals.css` + `shared/components/workspace-shell.tsx`.

---

### [D3-2] Shared Routes (`/home`, `/courses`, `/notifications`, `/action-items`, `/activity`) Split into Two Divergent UIs (`scope === "teacher"`)
- **Severity**: `High`
- **Student / Shared Evidence**:
  - `shared/daily-inbox/DailyApiPages.tsx:499-951` (`HomeApiPage`) and `1166-1328` (`ActivityApiPage`), `shared/daily-inbox/InboxApiPages.tsx:101-350` (`NotificationsApiPage`) and `566-675` (`ActionItemsApiPage`), `student/courses/CoursesApiPages.tsx:288+` (`MyCoursesApiPage`), plus `shared/components/AnnouncementBanner.tsx:20` (student-only `role === "student"`). Student branches use `<PageHeader>`, `b-ui`/`compactBtn`, `HomeInboxPanel`, `.gp-segmented`, and `<Feedback>`.
- **Teacher / Shared Evidence**:
  - `shared/daily-inbox/DailyApiPages.tsx:156-497` (`HomeApiPage`), `975-1164` (`ActivityApiPage`), `shared/daily-inbox/InboxApiPages.tsx:95-97` (delegating to `teacher/pages/TeacherNotificationsApiPage.tsx`) and `372-564` (`ActionItemsApiPage`), and `student/courses/CoursesApiPages.tsx:57-286` (`MyCoursesApiPage`). Teacher branches hardcode `feishuCard`, `feishuInput`, `TeacherSegmentedTabs`, `TeacherFeedbackPill`, and `animate-pulse` skeletons inside files located in `shared/daily-inbox/` and `student/courses/`.
- **Exact Divergence**: Shared URLs render two completely separate UI component hierarchies depending on user role, forcing every shared-page change (filtering, header layout, error display, empty states) to be maintained twice and leaking Teacher-specific imports (`TeacherSegmentedTabs`, `TeacherFeedbackPill`) back into `student/` and `shared/`.
- **Recommended Unification Plan**: Once `PageHeader`, `SegmentedTabs`, `Input`, `Button`, and `Feedback` are unified in `shared/components/`, collapse the `if (scope === "teacher")` styling forks in `HomeApiPage`, `ActivityApiPage`, `ActionItemsApiPage`, and `MyCoursesApiPage` so role differences are strictly data/actions rather than duplicated UI chrome.
- **Estimated Change Impact / Scope**: `5` shared route components (`DailyApiPages.tsx`, `InboxApiPages.tsx`, `CoursesApiPages.tsx`, `TeacherNotificationsApiPage.tsx`, `AnnouncementBanner.tsx`).

---

### [D3-3] Header Search & Quick Switcher Asymmetry (Inline API Search vs. `Cmd/Ctrl+K` Local Modal)
- **Severity**: `Medium`
- **Student / Shared Evidence**:
  - `shared/components/workspace-shell.tsx:858-950,961,965`: Student (and Admin) renders an inline `.gp-search` `<input>` with debounced remote API search (`projects`, `tasks`, `courses`, `evidence`, `files`, `users`) and an inline `role="listbox"` dropdown (`ArrowDown`/`ArrowUp`/`Enter`/`Escape`), with **no** `Cmd/Ctrl+K` global trigger.
- **Teacher / Shared Evidence**:
  - `shared/components/workspace-shell.tsx:571-594,1126-1138,1243-1247` & `teacher/components/TeacherQuickSwitcher.tsx:143-200,245-324`: Teacher replaces the inline search box with a button displaying `⌘K` that opens the `TeacherQuickSwitcher` `Dialog`. It searches **only** loaded classes, current-class 5-hubs, and current-class roster students (never hitting global backend search for tasks, files, appeals, or cross-class students).
- **Exact Divergence**: Student has cross-entity API search but no `⌘K` modal/shortcut; Teacher has `⌘K` modal navigation but cannot search backend entities outside loaded class/roster lists. Also, `workspace-shell.tsx:911-914` renders `.gp-search` listbox using hardcoded `#dfe6ee`/`#eef4ff`/`#17243c`.
- **Recommended Unification Plan**: Keep a single header command trigger (`⌘K` + click) or inline search with `⌘K` focus/open support across all roles, and wire `TeacherQuickSwitcher` to fall back to the shared remote search query when typing >1 character so both ends gain full search coverage and identical keyboard invocation.
- **Estimated Change Impact / Scope**: `shared/components/workspace-shell.tsx`, `teacher/components/TeacherQuickSwitcher.tsx`.

---

### [D3-4] Notification Header Bell Mismatch (Popover Preview vs. Direct Route Link) & Hidden Help Link
- **Severity**: `Medium`
- **Student / Shared Evidence**:
  - `shared/components/workspace-shell.tsx:143-519,1166,1183`: Topbar includes a Help text label (`{!isTeacher && ...}`) and renders `<NotificationCenterPopover>` on the bell icon, letting users preview unread/all notifications, filter by category, and mark read inline without leaving their current work page.
- **Teacher / Shared Evidence**:
  - `shared/components/workspace-shell.tsx:1166-1181`: Help link is explicitly hidden (`{!isTeacher && ...}`), and the bell is downgraded to a plain `<Link href="/notifications">`, forcing a full-page route change to inspect any notification.
- **Exact Divergence**: Topbar utility parity breaks between Student and Teacher—Teacher loses inline notification triage (`NotificationCenterPopover`) and the topbar Help entry.
- **Recommended Unification Plan**: Render `<NotificationCenterPopover>` for Teacher as well (passing `gp-teacher-portal` scope on its popover container so tokens apply cleanly) and unify topbar utility visibility rules across roles.
- **Estimated Change Impact / Scope**: `shared/components/workspace-shell.tsx` (`~15` lines).

---

### [D3-5] Secondary Course Sub-Navigation & Breadcrumb Pattern Divergence
- **Severity**: `Low`
- **Student / Shared Evidence**:
  - `shared/components/workspace-shell.tsx:981-1023` puts the project context switcher `<DropdownMenu>` inside the left sidebar header, while page headers use plain `<PageHeader eyebrow=...>` text breadcrumbs (`common.tsx:33`, `app/globals.css:194`).
- **Teacher / Shared Evidence**:
  - `teacher/components/TeacherClassLayout.tsx:286-541` mounts an extra sticky rounded sub-header bar inside `.gp-content` containing a back-to-classes button, class switcher `DropdownMenu`, status badge, invite code pill + copy button, 5-hub nav links + overflow dropdown, and a `roster-toggle-btn`.
- **Exact Divergence**: Context switchers and secondary navigation live in different places (left rail header + breadcrumb text in Student vs. in-content sticky toolbar in Teacher).
- **Recommended Unification Plan**: Document this as an intentional layout pattern where appropriate (5-hub course workspace vs 15-route project tree), but extract shared sub-components for the `<ContextSwitcherDropdown>` and `<BackBreadcrumb>` so dropdown borders, height (`h-8`), and hover states match across both workspaces.
- **Estimated Change Impact / Scope**: `teacher/components/TeacherClassLayout.tsx`, `shared/components/workspace-shell.tsx`, `shared/components/common.tsx`.

---

## 4. Async, Feedback & Confirmation States

### [D4-1] Destructive & State-Changing Confirmations: `TeacherConfirmDialog` vs. Native `window.confirm()` & Inline Raw Dialog
- **Severity**: `High`
- **Student / Shared Evidence**:
  - `5` native synchronous `window.confirm()` calls across `3` files: `student/execution/ExecutionApiPage.tsx:243` (discarding candidate evidence edits), `student/projects/ProjectOverviewPanels.tsx:769` (archive project), `1163` (transfer leader), `1183` (remove member), and `student/review/ProjectSettingsApiPage.tsx:355` (archive project).
  - `1` un-portaled inline confirmation card (`<div role="dialog" aria-modal="true">`) inside `student/projects/TasksApiPage.tsx:355-373` (no overlay, no `loading` lock, no `Escape` close).
- **Teacher / Shared Evidence**:
  - `teacher/components/TeacherConfirmDialog.tsx:38-141` (used e.g. in `TeacherFilesApiPage.tsx:1136-1168`, `TeacherSettingsApiPage.tsx`): wraps Radix `Dialog` or `Sheet`, styles destructive confirmation with `tone="danger"`, blocks Escape and outside clicks while `loading={true}`, locks cancel, and shows an inline spinner with `preserveWidth` to prevent button jitter.
- **Exact Divergence**: Teacher uses accessible, theme-consistent, non-blocking modal confirmation with async loading protection; Student relies on unstyled OS `window.confirm()` popups and an inline non-modal card that cannot show pending state cleanly or trap focus.
- **Recommended Unification Plan**: Move `TeacherConfirmDialog` to `shared/components/ConfirmDialog.tsx` and replace all `5` `window.confirm()` calls plus `TasksApiPage.tsx:355-373` with `<ConfirmDialog>`.
- **Estimated Change Impact / Scope**: `1` new shared component re-export (`teacher/components/TeacherConfirmDialog.tsx` can alias for compatibility) + `4` Student files (`ExecutionApiPage`, `ProjectOverviewPanels`, `ProjectSettingsApiPage`, `TasksApiPage`).

---

### [D4-2] Feedback & Status Notifications: `TeacherFeedbackPill` vs. `common.tsx` `<Feedback>` vs. Plain `<p role="status">`
- **Severity**: `High`
- **Student / Shared Evidence**:
  - `shared/components/common.tsx:120-122`: `<Feedback>` uses `.gp-feedback` (`app/globals.css:116-119`, full-width rectangular banner), hardcodes `role="status"` even when `tone="error"`, has **no** `loading` tone, **no** `onDismiss` button, **no** `autoHideMs`, and **no** `floating` placement.
  - Even where `<Feedback>` exists (`27` files), several Student views bypass it for plain `<p role="status">` text (`EvidenceApiPage.tsx:479`, `ProjectFilesApiPage.tsx:224`, `shared/daily-inbox/InboxApiPages.tsx:226`), and `CoursesApiPages.tsx:159` + `c-project-api.tsx:46` pull `TeacherFeedbackPill` into shared/student-path modules.
- **Teacher / Shared Evidence**:
  - `teacher/components/TeacherFeedbackPill.tsx:20-106`: pill-shaped status notification supporting `idle | loading | success | error | info | warning`, `role={tone === "error" ? "alert" : "status"}`, optional inline `action` button, `onDismiss` close button, `autoHideMs` auto-dismiss for `success`/`info`, and `placement="inline" | "floating"`.
- **Exact Divergence**: Neither end has a global toast queue; Student displays static rectangular banners (or bare `<p>` tags) with wrong ARIA role (`status` on errors), while Teacher displays dismissible auto-hiding pills (sometimes floating bottom-right).
- **Recommended Unification Plan**: Merge `<Feedback>` and `<TeacherFeedbackPill>` into one shared `<FeedbackBanner>` (supporting `variant="banner" | "pill"`, `loading` tone, proper `role="alert"` on errors, optional `onDismiss` & `autoHideMs`) backed by `--gp-*` CSS variables, and replace raw `<p role="status">` feedback strings in Student execution/inbox pages.
- **Estimated Change Impact / Scope**: `shared/components/common.tsx`, `teacher/components/TeacherFeedbackPill.tsx`, `shared/lib/c-project-api.tsx`, `EvidenceApiPage.tsx`, `ProjectFilesApiPage.tsx`, `InboxApiPages.tsx`.

---

### [D4-3] Loading State Inconsistency: Pulse Card Skeletons vs. Plain `.gp-empty` Text
- **Severity**: `Medium`
- **Student / Shared Evidence**:
  - Most Student pages show plain centered text (`<div role="status" className="gp-empty">` or `<p role="status">`) during initial load (`CoursesApiPages.tsx:365`, `TasksApiPage.tsx:377`, `MilestonesApiPage.tsx:124`, `RequirementsApiPage.tsx:256`, `EvidenceApiPage.tsx:480`, `ProjectFilesApiPage.tsx:219`, `InboxApiPages.tsx:222`).
  - Only `4` Student/shared views implement `animate-pulse` skeletons (`ReportApiPage.tsx:1109,1177-1201`, `GithubStatsChart.tsx:96-99`, `DailyApiPages.tsx:890-891`, `HomeInboxPanel.tsx:365-366`).
- **Teacher / Shared Evidence**:
  - `7+` Teacher views render structured `animate-pulse` card skeletons (`TeacherDashboardApiPage.tsx:61-80`, `TeacherClassesApiPage.tsx:535`, `TeacherClassHomeApiPage.tsx:36-42,215`, `TeacherActionsApiPage.tsx:385`, `TeacherAppealsApiPage.tsx:192-193,278`, `TeacherGroupDetailApiPage.tsx:106-107`, `TeacherNotificationsApiPage.tsx:117`, `TeamPlazaApiPage.tsx:208-213`, plus `CoursesApiPages.tsx:150`).
  - Meanwhile `7` other Teacher views fall back to plain `.gp-empty` or `<p role="status">` text (`TeacherSettingsApiPage.tsx:271`, `TeacherStaffApiPage.tsx:167`, `TeacherProjectsApiPage.tsx:118`, `TeacherReportsApiPage.tsx:159`, `TeacherAnnouncementsApiPage.tsx:257`, `TeacherFilesApiPage.tsx:706`, `ClassRosterSidebar.tsx:199`).
- **Exact Divergence**: Neither end has a shared `<Skeleton>` component; Student mostly flashes plain `.gp-empty` text (higher layout shift), while Teacher is split ~50/50 between ad-hoc `animate-pulse` boxes and plain text loaders.
- **Recommended Unification Plan**: Create `shared/components/ui/skeleton.tsx` (`<Skeleton>`, `<SkeletonCard>`, `<SkeletonList>`) using `--gp-surface-hover` and `motion-reduce:animate-none`, and adopt it on initial data loads across both Student and Teacher.
- **Estimated Change Impact / Scope**: `1` new UI primitive + ~15 primary list/detail pages across `student/` and `teacher/`.

---

### [D4-4] Error Banner Divergence & Missing Retry Actions
- **Severity**: `Medium`
- **Student / Shared Evidence**:
  - `shared/lib/c-project-api.tsx:55` (`ApiFailure`): Student renders `<div role="alert" className="my-3 rounded-md border border-red-200 p-3">` + raw `apiButton` retry.
  - Pages using `<Feedback tone="error">` from `common.tsx` omit Retry buttons on initial load errors (`MilestonesApiPage.tsx:126`, `TasksApiPage.tsx:379`, `RequirementsApiPage.tsx:175`, `RiskApiPage.tsx:207`) and inconsistently wrap `<Feedback>` in `<div role="alert">` (`TasksApiPage.tsx:379` does; `MilestonesApiPage.tsx:126` does not).
- **Teacher / Shared Evidence**:
  - `shared/lib/c-project-api.tsx:44-53` (`ApiFailure`): Teacher branches to a `rounded-[12px]` card containing `<TeacherFeedbackPill tone="error">` + `<Button variant="outline" size="sm" pill>` retry.
  - Teacher pages (`TeacherActionsApiPage.tsx:388-392`, `TeacherProjectsApiPage.tsx:122-125`, `TeacherFilesApiPage.tsx:710-715`, `CoursesApiPages.tsx:158-163`) consistently surface an alert banner/card with an explicit `Retry` `<Button>`.
- **Exact Divergence**: `ApiFailure` forks markup by role (`isTeacher`), and Student's `common.tsx` error banners lack built-in `role="alert"` and retry triggers.
- **Recommended Unification Plan**: Unify `ApiFailure` (`c-project-api.tsx:39-56`) to render a single `<FeedbackBanner tone="error" role="alert" action={retry && ...} />` without branching JSX by role, and pass `retry` consistently on Student query errors (`MilestonesApiPage`, `TasksApiPage`, `RequirementsApiPage`, `RiskApiPage`).
- **Estimated Change Impact / Scope**: `shared/lib/c-project-api.tsx`, `shared/components/common.tsx`, and `4` Student query error states.

---

### [D4-5] Button Disabled & Loading Width-Preservation Divergence
- **Severity**: `Low`
- **Student / Shared Evidence**:
  - `b-ui.ts:2-4`, `c-project-api.tsx:11-12`, and `compactBtn` strings (`AcceptanceApiPage.tsx:55`, `TasksApiPage.tsx:49`, `RiskApiPage.tsx:37`) only apply `disabled:cursor-not-allowed disabled:opacity-50`, lacking `aria-busy`, spinner icon, or layout-shift protection; pages swap button labels manually (`ProjectFilesApiPage.tsx:150`, `TasksApiPage.tsx:221-223`, `RequirementsApiPage.tsx:145`).
- **Teacher / Shared Evidence**:
  - `shared/components/ui/button.tsx:31-35,57-89` provides `loading`, `aria-busy={loading || undefined}`, `Loader2 animate-spin`, and `preserveWidth` (utilized in `TeacherConfirmDialog.tsx:73-74`, `TeacherFilesApiPage.tsx:1125-1126`, `TeacherRulesApiPage.tsx:900-901`, `TeacherActionsApiPage.tsx:332`).
- **Exact Divergence**: Teacher gets consistent `aria-busy` and non-jittering loading buttons; Student buttons shift width when label text changes to `"正在…"` and do not expose `aria-busy`.
- **Recommended Unification Plan**: Automatically resolved as Student migrates action triggers onto `shared/components/ui/button.tsx` with `loading` (and `preserveWidth` for icon/compact toolbar buttons).
- **Estimated Change Impact / Scope**: Covered by `[D2-1]` Button unification.

---

## 5. Interaction & Accessibility

### [D5-1] Focus-Visible Coverage Gap in Teacher Scope (`0` Scoped `:focus-visible` Rules)
- **Severity**: `High`
- **Student / Shared Evidence**:
  - `app/globals.css:496`: `.gp-student-workspace :is(button, a, input, select, textarea):focus-visible { outline: 2px solid #0284c7; outline-offset: 2px; }` enforces keyboard focus rings globally across Student controls (and `.gp-shell-admin` defines its own rule at `524-527`).
  - `b-ui.ts:5` inputs apply `outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15`, and `button.tsx:8` uses `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-200`.
- **Teacher / Shared Evidence**:
  - `.gp-teacher-shell` and `.gp-teacher-portal` in `app/globals.css:560-781` define **zero** `:focus-visible` CSS rules, and static grep across all `48` files in `teacher/` returns **`0` `focus-visible` occurrences**.
  - Custom interactive `<button>` and `<input>` elements in Teacher — e.g., `teacher/components/TeacherClassLayout.tsx:300,364,380`, `teacher/components/ClassRosterSidebar.tsx:115,163-195`, and `teacher/components/TeacherQuickSwitcher.tsx:257-269` (which sets `outline-none` on the command search input without a focus ring on the input container) — miss unified keyboard focus styling, while `teacher/components/StudentEntity.tsx:115` relies on `focus:outline-none focus:ring-2` (showing rings on mouse click too).
- **Exact Divergence**: Student has a guaranteed workspace-wide `:focus-visible` outline (`2px solid`), whereas Teacher custom buttons/links outside `<Button>` rely on browser defaults or omit focus rings (`outline-none`).
- **Recommended Unification Plan**: Move the `:focus-visible` rule from `.gp-student-workspace` to base CSS (or mirror it for `.gp-teacher-shell, .gp-teacher-portal` using `2px solid var(--gp-action)`), audit `outline-none` inputs in `TeacherQuickSwitcher.tsx:268` to add `:focus-within` / `focus-visible` container rings, and standardize `button.tsx:8` to `focus-visible:ring-[var(--gp-action)]/40`.
- **Estimated Change Impact / Scope**: `app/globals.css` + `shared/components/ui/button.tsx` + `TeacherQuickSwitcher.tsx` + `StudentEntity.tsx`.

---

### [D5-2] Keyboard Navigation Asymmetry (`TeacherSegmentedTabs` & `Cmd/Ctrl+K` vs. Student Tabs & Raw Dialogs)
- **Severity**: `High`
- **Student / Shared Evidence**:
  - **Tablists (`13` raw `role="tablist"` in `student/` + `2` active in `shared/`)**: `CoursesApiPages.tsx:314`, `MyProjectsApiPage.tsx:371`, `ActivityApiPages.tsx:850,891`, `ProjectOverviewPanels.tsx:230,561`, `RequirementsApiPage.tsx:356`, `PlanningApiPage.tsx:437`, `ProjectDiscussionPreviewPage.tsx:362`, `GithubStatsChart.tsx:157,175`, `ContributionApiPage.tsx:266`, `ContributionCharts.tsx:81`, plus `shared/components/workspace-shell.tsx:289` and `shared/daily-inbox/HomeInboxPanel.tsx:253` (and `ReportApiPage.tsx:1433` uses plain buttons without `role="tablist"`). None implement WAI-ARIA `ArrowLeft`/`ArrowRight`/`Home`/`End` navigation or roving `tabIndex`.
  - **Raw Dialogs**: `TasksApiPage.tsx:355-373` has no `Escape` key handler and no focus trap; `MarkdownPreview.tsx:318-350` lightbox has no `Escape` handler or focus trap; `ReportApiPage.tsx:650-655,1406-1431` wires `Escape` manually on `document` but lacks focus trapping and trigger focus restoration when the drawer closes.
  - **Shortcut**: `Cmd/Ctrl+K` in `workspace-shell.tsx:571-594` returns early when `!isTeacher`.
- **Teacher / Shared Evidence**:
  - `teacher/components/TeacherSegmentedTabs.tsx:43-64,158-163`: implements `ArrowRight`, `ArrowLeft`, `Home`, `End` with `.focus()` + roving `tabIndex={active || isFirstEnabled ? 0 : -1}` (note `ClassRosterSidebar.tsx:162-196` is the exception).
  - Modals/Drawers use Radix `Dialog`/`Sheet` (`TeacherConfirmDialog`, `TeacherQuickSwitcher`, `TeacherRulesApiPage:812-968`), giving built-in `Escape`, Tab focus trapping, and focus return.
  - `Cmd/Ctrl+K` (`workspace-shell.tsx:573-590`) toggles `TeacherQuickSwitcher`, ignoring editable targets (`INPUT`, `TEXTAREA`, `SELECT`, `isContentEditable`).
- **Exact Divergence**: Teacher has keyboard-complete tabs, modals, and `⌘K` navigation; Student tabs, 3 raw dialogs, and global shell lack matching keyboard ergonomics and focus management.
- **Recommended Unification Plan**: Migrate Student tablists and `ClassRosterSidebar.tsx:162-196` to the shared `SegmentedTabs` component (`[D2-3]`), migrate raw Student dialogs (`TasksApiPage`, `ReportApiPage`, `MarkdownPreview`) to Radix `Dialog`/`Sheet` (`[D2-4]`), and enable `Cmd/Ctrl+K` for Student (opening quick switcher or focusing `.gp-search input`).
- **Estimated Change Impact / Scope**: Resolves automatically alongside `[D2-3]`, `[D2-4]`, and `[D3-3]`.

---

### [D5-3] Responsive Breakpoints & Narrow-Screen Behavior Mismatch (`720px` vs. `768px`, Shift vs. Overlay, `1720px` Thresholds)
- **Severity**: `Medium`
- **Student / Shared Evidence**:
  - `app/globals.css:531-557`: Mobile sidebar off-canvas slide-in, `.gp-mobile-menu`, and mobile topbar layout trigger at `@media (max-width: 720px)`, with Student `.gp-content` padding `20px 16px 40px` (`540`) and `.gp-page-title` `23px` (`541`).
  - `shared/components/workspace-shell.tsx:953`: Mobile sidebar backdrop uses Tailwind `md:hidden` (`768px`), creating a **`721px–767px` mismatch** vs. CSS `720px`.
  - `app/globals.css:487-490`: At `>=1024px`, open `.gp-detail-drawer` shrinks `.gp-content` (`padding-right: 584px`).
  - **Ad-hoc scroll wrappers vs. missing horizontal scroll**: Several raw tables wrap `<table>` manually instead of adopting `.gp-table-wrap` / `.gp-table` — `MilestonesApiPage.tsx:280-281`, `TasksApiPage.tsx:563-564` (`min-w-[900px]`), and `EvidenceApiPage.tsx:590-591` (`min-w-[780px]`) use `overflow-x-auto`, and `RequirementsApiPage.tsx:263-264` / `PlanningApiPage.tsx:379-380` use `overflow-auto` — whereas `RequirementsApiPage.tsx:479-482` (`data-testid="b-version-diff"`) wraps its comparison table in `overflow-hidden` without `overflow-x-auto`, risking clipped diff cells on narrow viewports.
- **Teacher / Shared Evidence**:
  - `app/globals.css:732,764-781`: Rail collapse applies at `@media (min-width: 721px)`, while `@media (max-width: 720px)` gives Teacher `.gp-topbar` `padding: 0 14px` (`766`), `.gp-content` `padding: 16px 14px 36px` (`769`), and `.gp-page-title` `18px` (`775`).
  - `teacher/components/TeacherClassLayout.tsx:354,374,501-541`: switches `ClassRosterSidebar` between inline desktop grid (`xl:grid-cols-[minmax(0,1fr)_280px]` at `>=1280px`) and overlay `Sheet` (`<1280px`), while introducing ultra-wide header breakpoints (`xl`, `2xl`, `min-[1720px]`), and `TeamPlazaApiPage.tsx:566-577` uses `@[560px]` container queries. `TeacherGroupDetailApiPage.tsx:290-291` hides its `overflow-x-auto` table below `md` (`hidden overflow-x-auto md:block`) in favor of stacked mobile cards (`226-288`), whereas `ActivityRanking.tsx:17-18` keeps an `overflow-x-auto` table (`min-w-[560px]`).
- **Exact Divergence**: CSS `720px` vs. Tailwind `md` (`768px`) creates a seam around tablet widths; mobile padding/typography (`16px`/`23px` vs `14px`/`18px`) and secondary-panel responsiveness (`1024px` content-shift vs `1280px` grid/overlay + `1720px` custom breakpoints) follow different responsive systems.
- **Recommended Unification Plan**: Align `@media (max-width: 720px)` / `(min-width: 721px)` in `app/globals.css` with Tailwind's `md` threshold (`767px` / `768px`), standardize mobile shell padding (`16px`) across roles, replace bespoke `min-[1720px]` breakpoints in `TeacherClassLayout.tsx` with clean flex/overflow rules, and wrap every table in `.gp-table-wrap` (`overflow-x-auto`).
- **Estimated Change Impact / Scope**: `app/globals.css`, `shared/components/workspace-shell.tsx`, `teacher/components/TeacherClassLayout.tsx`, plus raw Student table wrappers.

---

### [D5-4] Hover & Micro-Interaction Motion Divergence (`prefers-reduced-motion` + Dialog/Stat Animations)
- **Severity**: `Low`
- **Student / Shared Evidence**:
  - `shared/components/ui/dialog.tsx:19,25` & `shared/components/ui/sheet.tsx:34,44-45`: `gp-overlay-anim`, `gp-dialog-anim`, `gp-sheet-left`, and `gp-sheet-right` are **gated behind `isTeacher && ...`**, so Student dialogs/sheets pop open with zero transition.
  - `app/globals.css:346-350` adds `transform: translateY(-1px)` hover lift to every Student `.gp-stat` card; `b-ui.ts:2-3` adds `active:scale-[0.99]`.
  - `student/review/ReportApiPage.tsx:290,382,1109,1177-1201` explicitly includes `motion-reduce:animate-none` on `animate-pulse`.
- **Teacher / Shared Evidence**:
  - Teacher dialogs/sheets always play `gp-overlay-anim`, `gp-dialog-anim`, `gp-sheet-*` (`app/globals.css:84-102`).
  - `.gp-teacher-shell .gp-stat` stays static on hover, reserving `translateY(-1px)` exclusively for `.gp-card-interactive:hover` (`723-727`).
  - Teacher `animate-pulse` skeletons (`TeacherDashboardApiPage.tsx:65`, `TeacherActionsApiPage.tsx:385`, `TeacherClassesApiPage.tsx:535`, etc.) omit `motion-reduce:animate-none` (relying solely on the global `1ms` media override in `app/globals.css:106`).
- **Exact Divergence**: Stage-15 modal/sheet entry/exit animations and reduced-motion hygiene are applied asymmetrically depending on `isTeacher` and per-file habits.
- **Recommended Unification Plan**: Remove the `isTeacher` conditional gate on `gp-overlay-anim`, `gp-dialog-anim`, and `gp-sheet-left`/`right` in `dialog.tsx` and `sheet.tsx` so both Student and Teacher share consistent, reduced-motion-safe (`app/globals.css:103-107`) overlay transitions, and standardize `motion-reduce:animate-none` in the shared `<Skeleton>` primitive (`[D4-3]`).
- **Estimated Change Impact / Scope**: `shared/components/ui/dialog.tsx`, `shared/components/ui/sheet.tsx`, and `1` shared `<Skeleton>` primitive.

---

## Prioritized Unification Roadmap

### Phase 1: Foundational Tokens & Quick High-Impact Safety Wins
1. **Align `:root` & Scoped Tokens (`[D1-1]`, `[D1-2]`, `[D1-5]`)**: Export missing semantic soft/hover/shadow tokens to `:root` in `app/globals.css`, unify `--gp-radius-control` (`8px`) and `--gp-radius-panel` (`12px`), and remove hardcoded hex colors from `shared/components/ui/{button,input,textarea,dialog,sheet,dropdown-menu}.tsx`.
2. **Global `:focus-visible` & Responsive Seam Fix (`[D5-1]`, `[D5-3]`)**: Apply `:focus-visible` baseline across `.gp-teacher-shell, .gp-teacher-portal` (plus `TeacherQuickSwitcher` search input) and align `720px` media queries in `app/globals.css` with Tailwind's `768px` (`md`) breakpoint.
3. **Eliminate Student `window.confirm()` & Raw Dialogs (`[D4-1]`, `[D2-4]`)**: Promote `TeacherConfirmDialog` to `shared/components/ConfirmDialog.tsx` and replace the `5` `window.confirm()` calls (`ExecutionApiPage`, `ProjectOverviewPanels`, `ProjectSettingsApiPage`) plus inline/raw dialogs in `TasksApiPage`, `ReportApiPage`, and `MarkdownPreview`.

### Phase 2: Shared Primitive Convergence
4. **Promote Unified `SegmentedTabs` & `FeedbackBanner` (`[D2-3]`, `[D4-2]`, `[D4-4]`, `[D5-2]`)**: Move `TeacherSegmentedTabs` into `shared/components/ui/`, merge `Feedback` + `TeacherFeedbackPill` (`role="alert"` on error, optional dismiss/autoHide, loading tone), unify `ApiFailure`, and migrate Student's `13` raw `role="tablist"` controls.
5. **Unify `Button`, `Input`, `Textarea`, `Card` (`[D1-3]`, `[D2-1]`, `[D2-2]`, `[D4-5]`)**: Add `destructive-outline` to `Button`, migrate `b-ui.ts`/`apiButton`/`compactBtn`/`feishuInput`/`feishuCard` onto shared primitives, and remove the `b-ui` import leak in `ClassRosterSidebar.tsx` and `StudentProfileDrawer.tsx`.
6. **Collapse `shared/` Role-Split Chrome & Tables (`[D2-5]`, `[D2-6]`, `[D3-2]`)**: Clean up duplicated `if (scope === "teacher")` JSX trees in `DailyApiPages.tsx`, `InboxApiPages.tsx`, and `CoursesApiPages.tsx` using unified `PageHeader`, `EmptyState`, `ProgressBar`, and `.gp-table-wrap`/`.gp-table`.

### Phase 3: Shell Parity & Polish
7. **Header Command Search, Bell Popover & Skeletons (`[D3-1]`, `[D3-3]`, `[D3-4]`, `[D4-3]`, `[D5-4]`)**: Enable `NotificationCenterPopover` and topbar utility parity for Teacher, add `⌘K` + remote search parity across Student/Teacher, introduce `shared/components/ui/skeleton.tsx`, and turn on `dialog`/`sheet` entry animations for Student.
