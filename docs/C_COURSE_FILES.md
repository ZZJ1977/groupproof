# C5-04 canonical course files

The C course-file service persists logical files, immutable byte metadata,
publication decisions and pending integration facts in `services/api`. Actual
uploads and signed previews/downloads require an A adapter. The default
course-scoped storage port returns **503**, without creating fake file records
or claiming uploaded bytes. No third-party credentials are included.

## Files and integration

- `app/modules/c/course_files_models.py`: five C-owned tables:
  `c_course_files`, `c_course_file_versions`, `c_course_file_decisions`,
  `c_course_file_outbox`, `c_course_file_requests`.
- `course_files_permissions.py`: canonical course ownership, enrollment and staff authority.
- `course_files_service.py`: scoped reads, upload-receipt registration, replacement
  versions, explicit publication, conditional updates and signed-link access.
- `course_files_events.py`: course-owned request replay and pending outbox facts.
- `course_files_storage.py`: `CourseStoragePort`, `CourseUploadReceipt`,
  `CourseStorageLink`, validation and unavailable default.
- `course_files_router.py` and `course_files_schemas.py`: HTTP and typed DTOs.
- `migrations/versions/0011_c_course_files.py`: revision `0011`, parent `0010`.

Mount `course_files_router.router` at `/api/v1` through the existing C router;
import `course_files_models` into canonical migration metadata. Preserve the
existing `get_current_user` authentication dependency. Only trusted application
wiring may override `get_course_storage_port`. The project-file API and tables,
A's existing files model, B baselines/plans and D verification data are unchanged.
Course-owned records never invent a `project_id` to satisfy a project foreign key.

## Routes and DTOs

Paths below start with `/api/v1/courses/{course_id}`.

| Method and path | Input / response |
| --- | --- |
| `GET /files` | Combined filters → `CourseFilePageDTO` |
| `GET /files/{file_id}` | `CourseFileDetailDTO`, including visible versions and decisions |
| `POST /files` | `RegisterCourseFile` → `CourseFileDTO` (201) |
| `POST /files/{file_id}/versions` | `AppendCourseFileVersion` → `CourseFileDTO` (201) |
| `POST /files/{file_id}/publish` | `PublishCourseFileVersion` → `CourseFileDTO` |
| `GET /files/{file_id}/versions/{version_id}/link` | `purpose=preview|download` → `SignedCourseFileLinkDTO` |

All writes need `Idempotency-Key` and a nonblank `reason`. Registration accepts
`receipt_id`, `reason`, and `category` (default `documents`). Replacement accepts
`receipt_id`, `reason`, and `expected_version`. Publication accepts `version_id`,
`reason`, and `expected_version`. This version is the logical course file's
`lock_version`; it is not the course or project planning version. Extra fields,
including client-supplied hashes, paths, actor IDs and URLs, are rejected.

`CourseFileDTO` contains `id`, `course_id`, `name`, `category`,
`latest_version_no`, `official_version_no`, `lock_version`, `created_by`,
`created_at`, `updated_at`, and `versions`. Version entries contain `id`,
`file_id`, `version_no`, `original_name`, `extension`, `mime_type`, `size_bytes`,
`content_hash`, `uploaded_by`, `status`, and `created_at`. Raw receipt IDs and
storage coordinates are not exposed. Status is `draft`, `current`, or
`superseded`, derived without rewriting immutable version rows.

`CourseFileDetailDTO` adds `decisions`: each entry has `id`, `version_id`,
`actor_id`, `action` (`created`, `appended`, `published`), `reason`,
`resulting_lock_version`, `previous_official_version_no`, and `created_at`.

`CourseFilePageDTO` contains `items`, `total`, `page`, `page_size`, and
`can_write`. Items extend version entries with `course_id`, the logical `name`,
`category`, and logical `lock_version`. UI mutations should use the server's
`can_write`, not a role inferred from local mock state. Authorization is still
rechecked by every write. `SignedCourseFileLinkDTO` contains `version_id`,
`purpose`, `url`, and `expires_at`.

List parameters: `category=all|documents|images|exports|archived`, `q`,
`file_type` (extension), `status=draft|current|superseded`,
`sort=updated_desc|updated_asc|name_asc|size_desc`, `page`, and `page_size`
(default 10, range 1–100). Filters and visibility run before counts/pagination.
Search treats SQL wildcards literally. Excess pages clamp; empty results use
page 1. All responses use canonical envelopes and private/no-store headers.

## Authority and publication isolation

- Active, verified users whose global role is teacher and who own the course
  may create, replace and publish. Draft courses allow preparation/publication;
  ended courses are read-only. Owning a project gives no course-file write right.
- Active course staff (teachers or TA) can inspect drafts/history but cannot
  write unless they are the course owner. TA authorization never expands to writes.
- Active students need an active, non-departed `CourseMember` enrollment in the
  exact course. Students can only read/download versions that have an explicit
  publication decision. A global role, project membership or an unrelated course
  membership does not grant access. Administrators get no content bypass.
- Every list, detail and signed-link request reloads current course relations.
  Unknown IDs never fall back to a first course. Withdrawn enrollment or staff
  membership immediately blocks new reads/links. Previously issued links expire
  within 15 minutes; revoking already issued links is A's storage responsibility.

A new upload starts as an unpublished draft. Replacement appends a new immutable
version and keeps the previous published pointer unchanged. The original local
filename may differ (for example `brief-v2.pdf`); the logical name remains stable.
Only the latest draft may be explicitly published with a reason. Old published
versions remain readable and downloadable so frozen project references stay
valid. A draft replaced before publication never becomes visible to students,
including through archived filters, guessed IDs, detail history or signed links.
Student detail exposes only published versions/decisions; its `latest_version_no`
is the latest published version visible to that student.

## Transactions and pending integration

Writers lock the course row and conditionally update the logical file's
`lock_version`. Name keys are case-insensitively unique within the course;
receipt IDs are unique across course file versions. All version metadata,
publication pointers, audit decisions, replay records and outbox facts commit
together. Storage failures, stale versions and transaction failures leave no
partial records. Services do not commit; routers use the canonical command
transaction boundary. Same-input retries return current state, never reactivate
an older published version, and recheck authority before replay.

One `course_file.created`, `course_file.appended` or `course_file.published` fact
is recorded per successful command in `c_course_file_outbox`. It contains the
course-scoped aggregate, version/actor/decision IDs, reason, previous/current
official pointer and resulting file lock version. `delivered_at` remains null.
Dispatch, recipient resolution and A notification delivery are still pending.
Neither a pending event nor a local frontend message means users were notified.

B's frozen project source references are never rewritten to the latest course
file. This service exposes immutable version IDs; choosing a newer course file
for a B baseline is an explicit B-owned change. D validation results and project
evidence are not modified by course-file publication.

## A course-storage contract

`CourseStoragePort.resolve_receipt(course_id, actor_id, receipt_id)` is an
independent course adapter. It must validate actual completed bytes, uploader
and course ownership, immutable provider/object/revision, SHA-256, inspected
MIME and size, clean scan result and an aware future expiry. C validates all
returned fields again, safe filenames and extension/MIME pairs, a maximum
50 MiB size, and normalized-name length. A project receipt cannot substitute
for a course receipt. Resolution must support safe retry without consuming a
receipt before the C transaction commits.

`sign_version(course_id, actor_id, provider, object_id, revision, purpose)` must
authorize that exact immutable object. C accepts only scope-bound HTTPS links
whose hostname belongs to the adapter's trusted `allowed_download_hosts`, with
no credentials, fragment, nonstandard port or control characters, and an expiry
within 15 minutes. Clients cannot select a host/allowlist. A handles safe preview
headers/content disposition, storage deletion and physical byte integrity.
The default port returns `COURSE_FILE_STORAGE_UNAVAILABLE`; malformed adapter
output returns explicit `INVALID_COURSE_STORAGE_RECEIPT` or
`INVALID_COURSE_STORAGE_LINK` errors, not a successful fake upload/download.

## Validation and migration retention

Local SQLite/HTTP validation: **96 tests passed**. Scoped Ruff passes. Tests use
real SQLAlchemy persistence/FKs/rollback and a clearly named test-only storage
port. No bytes are uploaded by those tests and no external server is started.

The root agent ran the seven PostgreSQL tests against the scheduled disposable
database: **7 passed**. They cover three concurrency races and four migration
cases (empty downgrade/reapply and retained history, outbox or replay refusal),
using isolated UUID schemas. This is a separate PostgreSQL result, not inferred
from SQLite.

Migration downgrade refuses to discard any course file/version/decision,
pending event or replay row. Empty downgrade/reapply restores all five tables
and their constraints/indexes. Populated data requires an explicit preservation
or migration plan, never silent loss of course-file provenance.

## Course-file API page

`features/c/CourseFilesApiPage.tsx` accepts a canonical `courseId` and uses
`lib/api/c-course-files-client.ts`; it never translates mock IDs or displays
receipt IDs, storage object IDs or editable UUID fields. Root routing selects
the real page with the course-files feature flag. Existing materials, permitted
version history, URL-persisted combined filters and pagination come from the
API. The server's `can_write` capability controls publication actions; student
responses and signed-link authorization exclude unpublished versions.

Publication requires a reason and file version. Duplicate clicks are blocked;
unchanged retries preserve their idempotency key. A version conflict preserves
the reason and requires explicit refresh/reconfirmation. Refresh, identity or
course changes hide prior data, and access denial removes action controls and
signed links. Signed responses must match the requested version and purpose,
use safe HTTPS and expire within 15 minutes. Upload and replacement remain
explicitly unavailable until A provides the actual course-scoped upload flow.

Scoped ESLint passes for the page, client and eight browser-contract cases in
`e2e/c-course-files-api.spec.ts`. The cases cover filtering/pagination, student
visibility, failed/repeated publication, version conflict recovery, unsafe
links, denied refresh, invalid mock IDs and malformed response envelopes.
The course-file browser cases passed **8/8**, included in the completed **45/45**
new API browser suite; the last pending inbox filter locator also passed its rerun. The
current-batch production build and daily **4/4** rerun also passed. These HTTP
fixtures do not claim a live A login, byte storage integration or complete
C5-04 acceptance. The implementation and handoff are published in
[merged PR #11](https://github.com/ZZJ1977/groupproof/pull/11); latest CI and remaining
review/acceptance are tracked in [the delivery record](C_DELIVERY.md).
