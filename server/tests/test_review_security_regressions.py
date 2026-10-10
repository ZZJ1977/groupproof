"""Regression coverage for security defects found during the 2026-10-10 review."""
from urllib.parse import parse_qs, urlparse

from fastapi.testclient import TestClient
from sqlalchemy import select

from tests.conftest import csrf_headers, session_csrf, latest_code, latest_reset_token, complete_oauth
from tests.flows import GOOD_PASSWORD, ORIGIN, register_via_email, register_student, register_teacher_to_review, login_admin


def test_oauth_callback_requires_initiating_browser(client, stub, db_session):
    from app.main import app
    from app.models import OAuthTransaction
    from app.security import token_digest

    start = client.get('/api/v1/auth/google/start', follow_redirects=False)
    state = parse_qs(urlparse(start.headers['location']).query)['state'][0]
    tx = db_session.execute(select(OAuthTransaction).where(OAuthTransaction.state_digest == token_digest(state))).scalar_one()
    code = stub.mint_code(state=state, nonce=tx.nonce, code_verifier=tx.code_verifier, sub='attacker-review', email='attacker@example.com', email_verified=True, name='Attacker')
    with TestClient(app, base_url='http://localhost:8000', raise_server_exceptions=False) as victim:
        result = victim.get('/api/v1/auth/google/callback', params={'state': state, 'code': code}, follow_redirects=False)
        session = victim.get('/api/v1/auth/session').json()
        assert result.status_code == 401 and session == {'authenticated': False}
    # A foreign callback must not consume the legitimate transaction.
    allowed = client.get('/api/v1/auth/google/callback', params={'state': state, 'code': code}, follow_redirects=False)
    assert allowed.status_code == 302
    assert client.get('/api/v1/auth/session').json()['user']['name'] == 'Attacker'
    assert 'gp_oauth_state' not in client.cookies
    assert client.get('/api/v1/auth/google/callback', params={'state': state, 'code': code}, follow_redirects=False).status_code == 401


def test_password_change_revokes_old_recovery_tokens_and_other_sessions(client, stub):
    register_via_email(client, 'review-reset@example.com', 'reviewreset')
    from app.main import app
    stale_cookie = client.cookies.get('gp_session')
    assert client.post('/api/v1/auth/password/forgot', json={'email': 'review-reset@example.com'}, headers=ORIGIN).status_code == 200
    token = latest_reset_token('review-reset@example.com')
    changed = client.post('/api/v1/me/password', json={'currentPassword': GOOD_PASSWORD, 'newPassword': GOOD_PASSWORD + '-new'}, headers=csrf_headers(session_csrf(client)))
    assert changed.status_code == 200
    replay = client.post('/api/v1/auth/password/reset', json={'token': token, 'newPassword': GOOD_PASSWORD + '-old-token'}, headers=ORIGIN)
    assert replay.status_code == 400
    assert client.get('/api/v1/auth/session').json()['authenticated'] is True
    with TestClient(app, base_url='http://localhost:8000') as stale:
        stale.cookies.set('gp_session', stale_cookie)
        assert stale.get('/api/v1/auth/session').json() == {'authenticated': False}
    login = client.post('/api/v1/auth/password/login', json={'identifier': 'reviewreset', 'password': GOOD_PASSWORD + '-new'}, headers=ORIGIN)
    assert login.status_code == 200


def test_school_email_change_authorization_is_bound_to_challenge_target(client, stub, db_session):
    from datetime import timedelta
    from app.models import User, utcnow

    register_student(client, stub)
    me = client.get('/api/v1/me').json()
    user = db_session.get(User, me['user']['id'])
    user.last_login_at = utcnow() - timedelta(hours=1)
    db_session.commit()
    version = me['user']['version']
    csrf = csrf_headers(session_csrf(client))
    target = 'next@student.must.edu.mo'
    body = {'schoolEmail': target, 'expectedVersion': version}
    # No recent authentication: the separate old-mail approval path must work.
    denied = client.post('/api/v1/me/school-email/change', json=body, headers=csrf)
    assert denied.status_code == 403 and denied.json()['code'] == 'REAUTH_REQUIRED'
    created = client.post('/api/v1/me/school-email/change-authorization/challenges', json=body, headers=csrf)
    assert created.status_code == 200, created.text
    verified = client.post('/api/v1/me/school-email/change-authorization/verify', json={
        'challengeId': created.json()['challengeId'], 'code': latest_code('2023123456@student.must.edu.mo')
    }, headers=csrf)
    assert verified.status_code == 200, verified.text
    # The code grants exactly the original requested destination.
    wrong = client.post('/api/v1/me/school-email/change', json={'schoolEmail': 'other@student.must.edu.mo', 'expectedVersion': version}, headers=csrf)
    assert wrong.status_code == 403
    changed = client.post('/api/v1/me/school-email/change', json=body, headers=csrf)
    assert changed.status_code == 200, changed.text
    assert changed.json()['registration']['schoolEmailVerified'] is True
    current = client.get('/api/v1/me').json()
    reused = client.post('/api/v1/me/school-email/change', json={'schoolEmail': target, 'expectedVersion': current['user']['version']}, headers=csrf)
    assert reused.status_code == 403


def test_teacher_email_change_invalidates_approval_and_session_scope(client, stub):
    from app.main import app
    register_teacher_to_review(client, stub, sub='review-teacher', email='review-teacher@must.edu.mo', username='reviewteacher')
    with TestClient(app, base_url='http://localhost:8000', raise_server_exceptions=False) as admin:
        login_admin(admin, stub, sub='review-admin', username='reviewadmin', email='review-admin@must.edu.mo')
        application = admin.get('/api/v1/admin/teacher-applications').json()['items'][0]
        approved = admin.post('/api/v1/admin/teacher-applications/' + application['id'] + '/review', json={'decision': 'approve', 'expectedVersion': application['applicationVersion']}, headers=csrf_headers(session_csrf(admin)))
        assert approved.status_code == 200
    complete_oauth(client, stub, sub='review-teacher', email='review-teacher@must.edu.mo')
    me = client.get('/api/v1/me').json()
    assert me['registration']['accountState'] == 'active'
    changed = client.post('/api/v1/me/school-email/change', json={'schoolEmail': 'different-teacher@must.edu.mo', 'expectedVersion': me['user']['version']}, headers=csrf_headers(session_csrf(client)))
    assert changed.status_code == 200
    challenge = client.post('/api/v1/me/school-email/challenges', json={}, headers=csrf_headers(session_csrf(client))).json()
    verified = client.post('/api/v1/me/school-email/verify', json={'challengeId': challenge['challengeId'], 'code': latest_code('different-teacher@must.edu.mo')}, headers=csrf_headers(session_csrf(client)))
    assert verified.status_code == 200
    me = client.get('/api/v1/me').json()
    assert me['registration']['accountState'] == 'review_required'
    assert me['registration']['identityConfirmed'] is False
    assert 'teacher' not in me['user']['roles']
    assert not any(item['kind'] == 'teacher_approval' for item in me['registration']['verificationBasis'])
    assert client.get('/api/v1/home/summary').status_code == 403
    assert client.get('/api/v1/auth/session').json()['sessionScope'] == 'onboarding'
