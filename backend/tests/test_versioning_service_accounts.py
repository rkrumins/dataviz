"""A service account in a review and in a shared draft: #567's rules on Stage 2's routes.

A service account acts only through ``nxsat_`` keys that the people who manage it make. So:

- it is never asked to review: naming one, when raising a review or in either PATCH, is 403
  ``person_required``;
- it never approves (403 ``person_required``), on either head-bound approve route;
- nobody who manages it, or made a key for it, approves what it opened, or what its draft
  proposes: that is their own work (403 ``self_review``, as for an author);
- a draft is never shared with one, whether it is added or its role is changed (a change
  re-POSTs the members route): 409 ``ineligible_member``, reason ``service_account``.

The routes run the real review rules over a store nothing may read, so each refusal comes
before anything is read.
"""
from __future__ import annotations

import pytest

from backend.app.api.v1.endpoints.versioning import _not_their_own, get_versioning_service
from backend.app.auth.dependencies import get_current_user
from backend.app.db.models import ApiKeyORM
from backend.app.db.repositories import service_account_repo
from backend.app.services.versioning.service import GraphVersioningService

BASE = "/api/v1/ws1/versioning"
SVC = "svc_0123456789ab"
NOT_A_REVIEWER = {"type": "access_denied", "code": "person_required",
                  "message": "a service account cannot review a PR: name a person"}


def _untouched():
    raise AssertionError("refused before anything is read")


class _Rules(GraphVersioningService):
    """The real service over an unreadable store, with the reads the route guards make stubbed."""

    def __init__(self, pr: dict):
        super().__init__(session_factory=_untouched)
        self._pr = {"target_graph_id": "g1", "actor": "u_author", **pr}

    async def get_graph(self, graph_id):
        return {"graph_id": graph_id, "workspace_id": "ws1", "data_source_id": "ds1"}

    async def get_pr(self, pr_id):
        return {**self._pr, "pr_id": pr_id}


@pytest.fixture
def rules():
    from backend.app.main import app

    def install(**pr):
        app.dependency_overrides[get_versioning_service] = lambda: _Rules(pr)

    yield install
    app.dependency_overrides.pop(get_versioning_service, None)


@pytest.mark.parametrize("method, path", [
    ("POST", f"{BASE}/graphs/g1/pulls"),
    ("POST", f"{BASE}/graphs/g1/branches/br_1/merge-requests"),
    ("PATCH", f"{BASE}/pulls/pr_1"),
    ("PATCH", f"{BASE}/merge-requests/pr_1"),
])
async def test_a_service_account_is_never_asked_to_review(test_client, rules, method, path):
    rules()
    r = await test_client.request(method, path, json={"reviewers": ["u_ada", SVC]})
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == NOT_A_REVIEWER


@pytest.mark.parametrize("route", ["pulls", "merge-requests"])
async def test_a_service_account_never_approves(test_client, rules, fake_user, route):
    from backend.app.main import app

    rules()
    app.dependency_overrides[get_current_user] = lambda: fake_user.model_copy(update={"id": SVC})
    r = await test_client.post(f"{BASE}/{route}/pr_1/approve", json={"expectedHeadCommitId": "c_1"})
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == {
        "type": "access_denied", "code": "person_required",
        "message": "a service account cannot approve a PR: approving is a person's call"}


@pytest.mark.parametrize("route", ["pulls", "merge-requests"])
@pytest.mark.parametrize("through", ["author", "draft_owner"])
async def test_nobody_approves_what_a_service_account_they_manage_opened_or_proposes(
    test_client, db_session, rules, fake_user, route, through,
):
    account = await service_account_repo.create(
        db_session, name="Nightly sync", description=None, created_by=fake_user.id)
    await service_account_repo.add_manager(db_session, account, user_id=fake_user.id,
                                           added_by=fake_user.id)
    await db_session.commit()
    rules(**({"actor": account} if through == "author" else {"source_branch_owner": account}))
    r = await test_client.post(f"{BASE}/{route}/pr_1/approve", json={"expectedHeadCommitId": "c_1"})
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == {
        "type": "access_denied", "code": "self_review", "prId": "pr_1",
        "message": "You manage the service account that opened this, or made a key for it, "
                   "so someone else approves it"}


def _key(account: str, made_by: str, *, revoked: bool) -> ApiKeyORM:
    return ApiKeyORM(user_id=account, kind="service", created_by=made_by, name="CI",
                     token_prefix="nxsat_ab12", token_hash="h", permissions="{}", resources='"all"',
                     revoked_at="2026-10-25T00:00:00+00:00" if revoked else None)


@pytest.mark.parametrize("route", ["pulls", "merge-requests"])
@pytest.mark.parametrize("revoked", [False, True])
async def test_nobody_approves_what_a_service_account_opened_through_a_key_they_made(
    test_client, db_session, rules, fake_user, route, revoked,
):
    """A manager can leave the account and keep the keys they made (#572), and a purge removes
    every manager and revokes the keys: whoever made one could act as it, so the approval would
    still be of their own work."""
    account = await service_account_repo.create(
        db_session, name="Nightly sync", description=None, created_by=fake_user.id)
    db_session.add(_key(account, fake_user.id, revoked=revoked))
    await db_session.commit()
    rules(actor=account)
    r = await test_client.post(f"{BASE}/{route}/pr_1/approve", json={"expectedHeadCommitId": "c_1"})
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["code"] == "self_review"


async def test_a_key_made_for_another_account_is_no_reason_to_refuse(db_session, fake_user):
    opened = await service_account_repo.create(
        db_session, name="Nightly sync", description=None, created_by=fake_user.id)
    other = await service_account_repo.create(
        db_session, name="Weekly report", description=None, created_by=fake_user.id)
    db_session.add(_key(other, fake_user.id, revoked=False))
    await db_session.commit()
    await _not_their_own(db_session, {"actor": opened, "pr_id": "pr_1"}, fake_user.id)


@pytest.mark.parametrize("role", ["viewer", "editor", "maintainer"])
async def test_a_draft_is_never_shared_with_a_service_account(test_client, rules, role):
    rules()
    r = await test_client.post(f"{BASE}/graphs/g1/branches/br_1/members",
                               json={"subjectType": "user", "subjectId": SVC, "role": role})
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert {k: detail[k] for k in ("type", "subjectId", "reason")} == {
        "type": "ineligible_member", "subjectId": SVC, "reason": "service_account"}
    assert "under Service accounts" in detail["message"]
