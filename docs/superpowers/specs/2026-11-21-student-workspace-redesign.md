# Student Workspace Redesign

## Intent

Rebuild the student experience around the work a student is trying to complete, rather than exposing every domain object as a flat navigation item. A project must be usable immediately after creation. Configuration, integrations, requirements analysis, and formal baseline governance remain available, but they no longer form one universal blocking wizard.

This redesign preserves existing business capabilities, real API contracts, audit history, course rules, teacher pages, and administrator pages. It changes the student information architecture, page composition, and the conditions under which a requirements baseline is required.

## Goals

- Replace the flat project menu with grouped, task-oriented navigation.
- Replace the five-step project initialization wizard with a non-blocking setup center.
- Send newly created projects to the project overview instead of forcing setup.
- Surface GitHub repository and Feishu chat binding near the beginning of project work.
- Keep materials, AI requirement extraction, conflict resolution, and baseline confirmation in the requirements workflow.
- Let independent projects plan and execute work without a frozen requirements baseline.
- Keep course-project baseline requirements and published course constraints intact.
- Use denser, responsive page layouts with clear primary actions, meaningful empty states, and visible explanations for unavailable actions.

## Non-goals

- Redesigning teacher or administrator workspaces.
- Replacing existing backend modules, audit records, or integration providers.
- Removing requirements baselines, task-plan confirmation, evidence, contribution, or reporting features.
- Claiming external GitHub or Feishu connectivity when the configured service reports it unavailable.
- Adding decorative animation before the functional and accessibility review is complete.

## Selected approach

The user selected a shared, policy-driven project setup center.

Alternatives considered:

1. Keep a shorter three-step wizard. This reduces screens but retains a linear gate and becomes long again when integrations grow.
2. Maintain separate independent and course project UIs. This is explicit but duplicates components and produces divergent navigation.
3. Use one setup center with policy-derived required items. This keeps one interface, makes independent-project setup optional, and shows course-only requirements only when they apply. This is the selected approach.

## Student information architecture

### Global workspace

- Home
- Courses
- Projects
- Action items
- Notifications
- Personal activity

The global navigation remains available in project context through a clear back-to-workspace control rather than repeating all global entries above every project item.

### Project workspace

- Overview
- Plan
  - Requirements
  - Tasks
  - Milestones
- Collaborate
  - Members
  - GitHub
  - Feishu activity
  - Files
  - Discussions
- Review
  - Evidence
  - Contribution
  - Reports
- Settings

The left navigation renders these as labelled groups with collapsible sections. The current page is visible from text, icon, and selected state. A project switcher at the top shows the active project and returns to the projects list.

## Project overview and setup center

The project overview is the default destination after creation. Its hierarchy is:

1. Project title, lifecycle state, and one context-sensitive primary action.
2. A compact work summary: tasks, progress, members, and next milestone.
3. A setup center titled “Start working” or “Project setup”, which contains actionable cards instead of ordered steps.
4. Current work and recent activity.

Setup cards:

| Card | Completion signal | Independent project | Course project |
|---|---|---|---|
| Project details | Name exists; optional metadata may be incomplete | Recommended | Required fields follow course rules |
| Members | Creator exists as leader | Complete for a solo project | Group membership is authoritative |
| GitHub | At least one repository binding exists | Optional | Required only when course rule requires it |
| Feishu | At least one chat binding exists | Optional | Optional unless a later course policy requires it |
| Materials | At least one usable source exists | Optional | Recommended or required by course submission rules |
| Requirements | At least one requirement/module exists | Optional | Required before a formal course baseline |
| Task plan | A plan draft or frozen plan exists | Recommended | Formal plan follows course baseline rules |

Cards have `not_started`, `in_progress`, `complete`, `required`, `unavailable`, or `attention` presentation. Progress counts only required and recommended cards; unavailable integrations do not count as user failure. Every card has a direct action and never hides the reason an action is unavailable.

The setup center may be dismissed after the user has entered the project. It remains reachable from Overview and Settings.

## Requirements and baseline workflow

Materials, AI extraction, conflict resolution, manual requirement editing, and baseline governance form one requirements workspace:

1. Add or review source materials.
2. Optionally run AI extraction.
3. Review generated modules and requirements.
4. Show conflict resolution only when unresolved conflicts exist.
5. Optionally create a baseline for independent projects.
6. Require baseline confirmation only for course projects where the existing policy requires it.

There is no empty conflict page. A zero-conflict analysis reports success inline. AI extraction is never required to add requirements manually.

### Independent projects

- A frozen requirements baseline is optional.
- Members may create and freeze a task plan while the baseline is absent.
- Requirements can be edited as normal working data until the user voluntarily creates a baseline.
- Task execution requires an active project and a frozen task plan, but not a requirements baseline.

### Course projects

- Existing course constraints remain authoritative.
- A requirements baseline remains required before freezing the formal task plan.
- All existing member confirmation, leader publication, course deadline, and audit rules remain.
- Draft collaboration and setup pages stay accessible before baseline freeze.

## Creation flow

Independent project creation asks only for a name and optional description, then routes to `/projects/{id}`.

Course project creation keeps server-side group, leader, course-rule, and group-size validation, but after creation also routes to `/projects/{id}`. The overview explains which course-controlled setup items are required.

## Interaction rules

- No “save and next” navigation outside a true sequential transaction.
- Forms save one concern at a time and retain input on failure.
- Dirty, saving, saved, and failed states are visible near the action.
- Disabled controls include adjacent explanatory text; a disabled control is never the only explanation.
- Empty states contain one relevant next action.
- Conflict sections appear conditionally.
- Long forms use two-column desktop layouts and one-column narrow layouts.
- Primary actions remain visible without forcing users to scroll through unrelated empty panels.
- Keyboard focus is visible; navigation groups use buttons with `aria-expanded`; mobile navigation closes after route selection.
- Reduced-motion preferences remain respected.

## Permissions

- Project leaders manage project settings and external bindings.
- Members can view binding status, add allowed materials, edit working requirements where current policies permit, and confirm assignments/baselines.
- Teachers and assistants retain their existing read-only or explicitly granted permissions.
- Archived/finalized projects remain read-only.
- Navigation visibility is not authorization; every destination continues to authorize server-side.

## Compatibility and migration

- Existing `/projects/{id}/setup` URLs remain valid and render the setup center/requirements entry rather than a five-step gate.
- Existing setup drafts, materials, requirements, conflicts, baselines, and histories are preserved.
- Frozen course projects remain frozen.
- Existing project routes remain valid; only their grouping and entry points change.
- The legacy `setup_status` field remains available during migration, but student usability is no longer derived from it for independent projects.

## Acceptance criteria

1. A newly created independent project opens its overview and can reach task planning without freezing a requirements baseline.
2. A newly created course project opens its overview and clearly identifies course-required setup items.
3. The project sidebar contains grouped Plan, Collaborate, Review, and Settings sections instead of fourteen flat items.
4. GitHub and Feishu setup are visible from the overview/setup center and use the real existing binding components.
5. Requirements analysis is optional; manual requirements remain possible.
6. Conflict UI is absent when no unresolved conflicts exist.
7. Course projects still reject formal plan freeze without a frozen baseline.
8. Independent projects can freeze a valid task plan without a frozen baseline.
9. Existing deep links, teacher pages, administrator pages, and server-side permission checks continue to work.
10. Desktop and mobile layouts have no horizontal page overflow, and all primary flows are keyboard-operable.

