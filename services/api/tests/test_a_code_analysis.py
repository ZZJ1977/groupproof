"""A5×A7：从已同步的代码里挑相关文件，并分析需求是否实现。"""

from __future__ import annotations

from uuid import uuid4

import a_fixtures as fixtures
import pytest
from test_a_github_sync import URL, FakeGithub

from app.api.errors import ApiError
from app.modules.a import ai, code_analysis, github_sync

db = fixtures.db
scope = fixtures.scope

LOGIN = "def login(user):\n    return check_password(user)\n"


class Recorder:
    name = "rec"
    is_placeholder = False

    def __init__(self):
        self.payload = None

    def generate(self, feature, payload, *, timeout):
        self.payload = payload
        req = payload["requirements"][0]["id"]
        return {
            "findings": [
                {
                    "requirement_id": req,
                    "status": "implemented",
                    "confidence": 0.9,
                    "reasons": ["有登录函数"],
                    "evidence": [{"path": "src/auth.py", "quote": "return check_password(user)"}],
                    "missing": [],
                }
            ]
        }


def _synced(db, scope):
    client = FakeGithub(
        {
            "src/auth.py": LOGIN.encode(),
            "src/other.py": b"print('nothing related')\n",
        }
    )
    github_sync.link_repo(db, scope.users["leader"], scope.project.id, URL, client)
    github_sync.sync_project_repos(db, scope.users["leader"], scope.project.id, client)


def _req(text):
    return [ai.ImplRequirement(id=uuid4(), text=text)]


def test_analysis_sends_only_relevant_files(db, scope):
    _synced(db, scope)
    recorder = Recorder()
    result = code_analysis.analyze_project_code(
        db, scope.users["member"], scope.project.id, _req("用户可以 login 登录"), provider=recorder
    )
    assert result.findings[0].status == "implemented"
    assert [f["path"] for f in recorder.payload["files"]] == ["src/auth.py"]


def test_analysis_errors_and_permissions(db, scope):
    with pytest.raises(ApiError) as exc:
        code_analysis.analyze_project_code(
            db, scope.users["member"], scope.project.id, _req("login")
        )
    assert exc.value.code == "GITHUB_NOT_SYNCED"
    _synced(db, scope)
    with pytest.raises(ApiError) as exc:
        code_analysis.analyze_project_code(
            db, scope.users["member"], scope.project.id, _req("zzzzqqqq 完全无关")
        )
    assert exc.value.code == "NO_RELEVANT_CODE"
    with pytest.raises(ApiError) as exc:
        code_analysis.analyze_project_code(
            db, scope.users["outsider"], scope.project.id, _req("login")
        )
    assert exc.value.status_code == 404
