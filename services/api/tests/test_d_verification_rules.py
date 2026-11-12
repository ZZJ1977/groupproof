"""D1-03 deterministic rules use saved trusted source snapshots."""

from types import SimpleNamespace
from uuid import uuid4

from app.modules.d.verification import deterministic_result


class SourceSession:
    def __init__(self, source: dict, file=None):
        self.snapshot = SimpleNamespace(
            content_json={"availability": "available", "source": source}
        )
        self.file = file

    def scalar(self, _statement):
        return self.snapshot

    def get(self, _model, _id):
        return self.file


def evidence(kind: str):
    return SimpleNamespace(id=uuid4(), project_id=uuid4(), source_type=kind)


def test_pr_and_ci_require_recorded_success():
    pr = evidence("github")
    assert (
        deterministic_result(SourceSession({"kind": "pull_request", "state": "merged"}), pr)[0]
        == "passed"
    )
    assert (
        deterministic_result(SourceSession({"kind": "pull_request", "state": "open"}), pr)[0]
        == "failed"
    )
    ci = evidence("github")
    assert (
        deterministic_result(SourceSession({"kind": "ci_run", "state": "success"}), ci)[0]
        == "passed"
    )
    assert (
        deterministic_result(SourceSession({"kind": "ci_run", "state": "failure"}), ci)[0]
        == "failed"
    )


def test_file_requires_designated_official_version():
    item = evidence("file")
    file_id = uuid4()
    source = {"file_id": str(file_id), "version_no": 2}
    file = SimpleNamespace(project_id=item.project_id, official_version_no=2)
    assert deterministic_result(SourceSession(source, file), item)[0] == "passed"
    file.official_version_no = 1
    assert deterministic_result(SourceSession(source, file), item)[0] == "failed"


def test_other_evidence_needs_review():
    item = evidence("feishu")
    assert deterministic_result(SourceSession({}), item)[0] == "uncertain"
