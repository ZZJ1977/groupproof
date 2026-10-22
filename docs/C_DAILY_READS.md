# C1-01 / C1-04 canonical daily reads

These read models use existing canonical tables. No migration, private vendor
credentials or fabricated workspace-ID mapping is required.

## Home

`GET /api/v1/home/summary` returns `DailyHomeDTO`. Authentication is mandatory and
the service re-reads the actor's current account status. There is no actor ID or
role parameter. Responses and errors use the canonical envelope and private,
no-store cache policy.

- Courses: active student membership or current course ownership/teaching staff.
- Projects: current membership/teaching-team access to complete project content.
  Admin status alone grants none. Departed members/staff lose access immediately
  on the next query. Finalized/archived projects and ended courses remain readable.
- My tasks: current responsible assignments within those accessible projects.
  Completion is `status=completed`, never `progress=100`.
- Course/project counts cover all accessible records. Previews contain at most
  ten each, ordered by `updated_at DESC, id ASC`, and carry canonical destinations.
- Project progress reuses C2's tree-weighted `progress_projection`, so parents and
  children are not double counted. Missing weighted tasks or invalid trees return
  null plus `progress_status`; the UI does not substitute zero.
- Notification and pending-action totals reuse the current recipient's validated
  inbox queries through the same injected `InboxPort` as pages 05/06. Each reads
  one record plus the provider's complete total, not every page. A successful empty
  source returns zero. A missing, unavailable or invalid source returns null only
  for its own counter and is listed in `unavailable_sources`; unrelated home facts
  remain visible. Provider 401/403 errors fail the entire response. The default A
  adapter remains unavailable, and no counts are inferred from pending outbox data.

The query count is bounded rather than querying once per project. A new request
sees task mutations without stale workspace snapshots.

## Personal activity

`GET /api/v1/me/activity` accepts category `all|development|evidence|discussion`,
optional `project_id`, inclusive UTC `date_from`/`date_to`, and page/page_size
(default 1/10, maximum size 50). Invalid dates, ranges, UUIDs and extra filters
are rejected. Pagination is server-side; order is event time descending, event
type ascending and event UUID ascending, including deterministic timestamp ties.

- Development: real progress events and saved task-note versions.
- Evidence: submitted/adopted/withdrawn/source-changed decision records.
- Discussion: original discussions and appended replies.

Only the signed-in actor's events with an existing, currently accessible target
are returned. Leaving a project removes its old activity from this query. Event
timestamps are immutable creation times; a colleague's later edit does not become
the actor's activity. Titles are the current target titles. Links use real target
IDs; discussion links select the discussion, and evidence links open its task's
evidence tab. A target page still needs its own canonical data implementation.

The view explicitly excludes external GitHub/Feishu ingestion and discussion
importance-only events. It does not claim to be a complete external activity log.

## Frontend and rollout

`createCClient().homeSummary()` and `.personalActivity(query)` use generated types
and the ordinary credentialed transport. No demo-user header or role override is
sent. Set `NEXT_PUBLIC_API_FEATURES=daily=real` to select the real read-only pages
independently of unfinished workspace features. Existing overrides may be combined,
for example `admin=real,daily=real`.

`DailyApiPages.tsx` uses only server DTOs. Session-scoped query keys, zero retained
cache lifetime and hiding rows during refetch/error prevent stale successful data
from appearing after a rejected request. Empty/error responses never fall back to
seed users, project counts or activities. Filters and pagination live in the URL.

This flag does not implement A's production session-to-canonical-user mapping.
Until A delivers that mapping, production requests return 401. The surrounding
workspace and B's canonical project/course pages are separate integration work.
The feature must not be enabled as a claim that all those dependencies are ready.

## Verification

`tests/test_c_daily.py` covers SQL/HTTP permissions, current relationships, events
and object deletion, canonical progress updates, tree weighting, bounded query
counts, pagination, UTC ranges and production refusal. The separate
`test_c_daily_postgres.py` checks actual PostgreSQL UNION/UUID/timezone behavior,
cross-session membership revocation, tree weights and committed progress changes.
`e2e/c-daily-api.spec.ts`
checks refresh, links, filters, errors and recovery with intercepted API responses.
`test_c_inbox_http.py` also exercises actual fixture persistence across single
read, duplicate replay, all-read and switching recipients, verifying the home and
inbox routes return matching counts. This is a SQLite A-contract fixture, not A's
production delivery adapter. The home links distinguish zero from unavailable and
lead to the existing notification and action pages.
Run its isolated browser configuration after the ordinary C suite:

```sh
npx playwright test --config playwright.c-daily.config.ts
```

It shares loopback ports with `playwright.c.config.ts`, so do not run them in
parallel. Browser fixtures do not prove production identity or vendor integration.
