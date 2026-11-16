"""Run A's sync, author mapping and deletion checks through C's real services."""

from contextlib import nullcontext
from uuid import UUID, uuid4

import pytest
import test_a_github_activity as upstream
import test_c_discussions as discussions
import test_c_evidence as evidence
from sqlalchemy import select

from app.db.models import ProjectMember
from app.modules.a import github_activity
from app.modules.c.activity_ports import GithubActivityPort
from app.modules.c.activity_service import get_activity, query_activities
from app.modules.c.daily_schemas import DailyActivityFilters, DailyActivityPageDTO
from app.modules.c.daily_service import list_personal_activity
from app.modules.c.evidence_service import create_evidence, evidence_data, list_evidence
from app.modules.c.evidence_sources import WorkspaceEvidenceSources
from app.modules.c.models import Evidence, IntegrationOutbox
from app.modules.c.source_ports import UnavailableSourcePort

db = discussions.db
scope = evidence.scope


@pytest.mark.parametrize("changed_kind", ["pull_request", "commit"])
def test_synced_activity_attribution_and_evidence_change(db, scope, changed_kind):
    if changed_kind == "commit" and db.get_bind().dialect.name != "postgresql":
        pytest.skip("A's deleted-commit window requires PostgreSQL timestamptz")
    actor = scope.users["author"]
    scope.plan.snapshot_json = {"tasks": [{"id": str(scope.task.id), "code": "T-012"}]}
    github_activity.set_github_login(db, actor, "dev1")
    commit = upstream.commit("a" * 40, "Implement #T-012", login="dev1")
    other = upstream.commit("b" * 40, "Other member")
    network = upstream.FakeGithub([commit, other], [upstream.pull(7, "Feature")], [upstream.run(3)])
    totals = upstream.sync(db, scope, network)
    assert totals["associated"] == 1
    port = GithubActivityPort(github_activity.DatabaseGithubActivityPort(lambda: nullcontext(db)))
    reader = db, actor, scope.project.id
    activities = query_activities(*reader, "github", port, author_id=actor.id)
    assert activities["total"] == 3
    records = {item["kind"]: item for item in activities["items"]}
    assert records["pull_request"]["github_state"] == "open"
    assert records["ci_run"]["github_state"] == "success"
    source_id = UUID(records["commit"]["source_id"])
    assert get_activity(*reader, "github", source_id, port)["task_id"] == str(scope.task.id)
    assert query_activities(*reader, "github", port, task_id=scope.task.id)["total"] == 1
    assert upstream.sync(db, scope, network)["associated"] == 0

    def personal(**kwargs):
        result = list_personal_activity(db, actor, DailyActivityFilters(**kwargs))
        return DailyActivityPageDTO.model_validate(result)

    pages = [personal(page=n, page_size=1) for n in (1, 2, 3, 4)]
    assert all(page.total == 3 for page in pages) and pages[-1].items == []
    assert [page.items[0].event_type for page in pages[:3]] == [
        "github_pull_request",
        "github_ci_run",
        "github_commit",
    ]
    assert pages[2].items[0].href.endswith(f"/github?record={source_id}")
    assert personal(project_id=scope.other_project.id).total == 0

    sources = WorkspaceEvidenceSources(db, UnavailableSourcePort(), port)
    source_id = UUID(records[changed_kind]["source_id"])
    candidate = create_evidence(
        *reader,
        evidence.command(scope, source_type="github", source_id=source_id),
        str(uuid4()),
        sources,
    )
    formal = evidence.decide(db, scope, candidate)
    assert formal["effective"]
    if changed_kind == "commit":
        # GitHub confirms the old SHA is gone within the comparison window.
        network._commits = [other]
    else:
        network._pulls = [upstream.pull(7, "New title", merged=True)]
    assert upstream.sync(db, scope, network)["deleted_sources"] == int(changed_kind == "commit")
    stored = db.get(Evidence, UUID(formal["id"]))
    changed = evidence_data(db, stored, history=True)
    assert changed["source_changed"] and not changed["effective"]
    assert len(changed["source_snapshots"]) == 2
    assert changed["source_snapshots"][0]["content"]["availability"] == "available"
    assert changed["original_snapshot_id"] == candidate["original_snapshot_id"]
    assert list_evidence(*reader, task_id=scope.task.id, effective_only=True)["total"] == 0
    upstream.sync(db, scope, network)
    assert evidence_data(db, stored, history=True) == changed
    changes = db.scalars(
        select(IntegrationOutbox).where(
            IntegrationOutbox.aggregate_id == stored.id,
            IntegrationOutbox.event_type == "evidence.source_changed",
        )
    ).all()
    assert len(changes) == 1
    detail = get_activity(*reader, "github", source_id, port)
    assert detail["availability"] == ("deleted" if changed_kind == "commit" else "available")

    membership = db.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == scope.project.id, ProjectMember.user_id == actor.id
        )
    )
    membership.left_at = pages[2].items[0].occurred_at
    db.flush()
    assert personal().total == 0
