"""Versioning errors reach the client with their own status and JSON detail.

``BranchNotOpen`` is a ``ValueError``, which ``_domain_errors`` answers with
404 ("not found"). A write to a merged or abandoned draft is not a missing
resource: the client must be told the draft closed, so it can keep the edits
and move them to a new draft. These tests pin that every mapped error wins over
the generic clauses, in the versioning router and in the app-wide handlers.
"""
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from backend.app.api.v1.endpoints.versioning import _domain_errors
from backend.app.services.versioning.errors import (
    HTTP_MAPPED,
    BranchNotOpen,
    ContentionExhausted,
    CurationAtRisk,
    DraftRoleRequired,
    ForkNotRestorable,
    GraphNotWritable,
    GroupsUnavailable,
    IneligibleMember,
    JobActive,
    LiveForks,
    LockBusy,
    MainWriteForbidden,
    MassDeleteBlocked,
    NotAFork,
    NotDraftOwner,
    ProjectionKeyInUse,
    ProjectionKeyInvalid,
    ProjectionNotAdopted,
    SelfReview,
    VersionConflict,
)
from backend.app.services.versioning.service import (
    AccessDenied, ConcurrencyError, GraphVersioningService, Viewer)


def _raised(exc: Exception) -> HTTPException:
    def run():
        with _domain_errors():
            raise exc
    return pytest.raises(HTTPException, run).value


def test_a_closed_draft_is_409_branch_closed_not_404():
    err = _raised(BranchNotOpen("br_1", "merged"))
    assert err.status_code == 409
    assert err.detail["type"] == "branch_closed"
    assert err.detail["status"] == "merged"
    assert err.detail["branchId"] == "br_1"


def test_a_plain_value_error_is_still_404():
    assert _raised(ValueError("unknown graph g")).status_code == 404


def test_main_write_forbidden_is_409():
    err = _raised(MainWriteForbidden())
    assert (err.status_code, err.detail["type"]) == (409, "main_write_forbidden")


@pytest.mark.parametrize("exc", [LockBusy(), ContentionExhausted()])
def test_lock_contention_is_503_with_retry_after(exc):
    err = _raised(exc)
    assert err.status_code == 503
    assert err.detail["type"] == "lock_busy" and err.detail["retryable"] is True
    assert err.headers == {"Retry-After": "2"}


def test_job_active_names_the_job():
    err = _raised(JobActive("job_9"))
    assert (err.status_code, err.detail["type"], err.detail["jobId"]) == (409, "job_active", "job_9")


def test_sync_guards_are_409():
    assert _raised(CurationAtRisk("x")).detail["type"] == "curation_at_risk"
    err = _raised(MassDeleteBlocked(900, 500, "x"))
    assert (err.status_code, err.detail["deletes"], err.detail["limit"]) == (409, 900, 500)


def test_not_draft_owner_is_403_access_denied():
    err = _raised(NotDraftOwner("br_4", "alice"))
    assert err.status_code == 403
    assert err.detail["type"] == "access_denied" and err.detail["code"] == "not_draft_owner"
    assert (err.detail["branchId"], err.detail["owner"]) == ("br_4", "alice")


def test_a_shared_draft_refusal_names_the_role_it_needs():
    exc = DraftRoleRequired("br_1", "editor")
    assert isinstance(exc, AccessDenied) and isinstance(exc, HTTP_MAPPED)
    err = _raised(exc)
    assert err.status_code == 403
    assert {k: err.detail[k] for k in ("type", "code", "required", "branchId")} == {
        "type": "access_denied", "code": "not_owner_or_member", "required": "editor", "branchId": "br_1"}


def test_a_person_writing_main_without_publish_is_403_publish_required():
    from backend.app.services.versioning.errors import PublishRequired
    exc = PublishRequired()
    assert isinstance(exc, AccessDenied) and type(exc) in HTTP_MAPPED
    err = _raised(exc)
    assert err.status_code == 403
    assert {k: err.detail[k] for k in ("type", "code", "required")} == {
        "type": "access_denied", "code": "publish_required", "required": "workspace:datasource:publish"}
    assert "draft" in err.detail["message"]


def test_writing_main_directly_needs_publish_held_by_the_person_or_the_keys_owner():
    from backend.app.api.v1.versioning_gate import require_publish_for_main
    from backend.app.services.versioning.errors import PublishRequired
    from backend.app.services.permission_service import KeyScope, PermissionClaims
    manage = ("workspace:datasource:read", "workspace:datasource:manage")
    person = PermissionClaims(sid="s", ws_perms={"ws1": manage})
    with pytest.raises(PublishRequired):
        require_publish_for_main(person, "ws1")
    require_publish_for_main(PermissionClaims(
        sid="s", ws_perms={"ws1": manage + ("workspace:datasource:publish",)}), "ws1")

    def key(**owner):                               # a key holds manage at most, never publish
        return PermissionClaims(sid="", ws_perms={"ws1": manage},
                                key_scope=KeyScope(key_id="k", data="write", **owner))
    with pytest.raises(PublishRequired):            # its owner manages but cannot publish
        require_publish_for_main(key(), "ws1")
    with pytest.raises(PublishRequired):            # its owner publishes, but elsewhere
        require_publish_for_main(key(owner_publish_workspaces=frozenset({"ws2"})), "ws1")
    require_publish_for_main(key(owner_publish_workspaces=frozenset({"ws1"})), "ws1")
    require_publish_for_main(key(owner_publishes_everywhere=True), "ws1")
    with pytest.raises(HTTPException) as unknown:     # no grants could be read: ask again, not 403
        require_publish_for_main(PermissionClaims(sid="s", ws_available=False), "ws1")
    assert unknown.value.status_code == 503


def test_approving_your_own_draft_or_review_is_403_self_review():
    exc = SelfReview("pr_1")
    assert isinstance(exc, AccessDenied) and isinstance(exc, HTTP_MAPPED)
    err = _raised(exc)
    assert err.status_code == 403
    assert {k: err.detail[k] for k in ("type", "code", "prId")} == {
        "type": "access_denied", "code": "self_review", "prId": "pr_1"}


def test_a_group_lookup_outage_is_503_with_retry_after():
    err = _raised(GroupsUnavailable())
    assert err.status_code == 503
    assert err.detail["type"] == "groups_unavailable" and err.detail["retryable"] is True
    assert err.headers == {"Retry-After": "2"}


def test_an_ineligible_member_is_422_with_the_reason():
    err = _raised(IneligibleMember("usr_v", "no_manage"))
    assert err.status_code == 422
    assert {k: err.detail[k] for k in ("type", "subjectId", "reason")} == {
        "type": "ineligible_member", "subjectId": "usr_v", "reason": "no_manage"}


@pytest.mark.asyncio
async def test_managing_someone_elses_private_draft_is_not_draft_owner():
    svc = GraphVersioningService.__new__(GraphVersioningService)
    draft = SimpleNamespace(id="br_6", kind="draft", owner="alice", is_shared=False)
    with pytest.raises(NotDraftOwner):               # decided before any query: no session needed
        await svc._require_manage(None, draft, "bob", ())


@pytest.mark.asyncio
async def test_a_draft_the_caller_cannot_read_is_404_like_an_unknown_branch():
    svc = GraphVersioningService.__new__(GraphVersioningService)

    async def unreadable(s, branch, viewer):
        return False
    svc._branch_readable = unreadable
    with pytest.raises(AccessDenied) as info:        # READ_DRAFT (doc 13): its existence doesn't leak
        await svc._assert_branch_readable(None, SimpleNamespace(id="br_7"), Viewer("bob"))
    err = _raised(info.value)
    assert (err.status_code, err.detail) == (404, "unknown branch")
    unknown = _raised(ValueError("unknown branch"))
    assert (err.status_code, err.detail) == (unknown.status_code, unknown.detail)


@pytest.mark.asyncio
async def test_a_private_draft_is_written_only_by_its_owner():
    svc = GraphVersioningService.__new__(GraphVersioningService)
    draft = SimpleNamespace(id="br_5", kind="draft", owner="alice", is_shared=False)
    await svc._require_edit(None, draft, "alice", ())
    with pytest.raises(AccessDenied) as info:        # a manager reads it, but does not write it
        await svc._require_edit(None, draft, "bob", ())
    assert isinstance(info.value, NotDraftOwner)
    await svc._require_edit(None, SimpleNamespace(id="br_m", kind="main", owner=None, is_shared=False),
                            "bob", ())


def test_fork_errors_carry_their_answer():
    for exc, detail in [
        (NotAFork("g"), {"type": "not_a_fork", "graphId": "g"}),
        (LiveForks("g", 2), {"type": "live_forks", "graphId": "g", "forks": 2}),
        (ForkNotRestorable("g", "purging"),
         {"type": "fork_not_restorable", "graphId": "g", "reason": "purging"}),
    ]:
        assert type(exc) in HTTP_MAPPED
        err = _raised(exc)
        assert err.status_code == 409
        assert {k: err.detail[k] for k in detail} == detail and err.detail["message"]


def test_a_refused_move_answers_with_its_reason():
    for exc, status, detail in [
        (ProjectionNotAdopted("customer_key"), 409,
         {"type": "projection_not_adopted", "reason": "customer_key"}),
        (ProjectionKeyInUse("prov_b", "gvp_g{abcd1234.1}"), 409,
         {"type": "graph_key_in_use", "providerId": "prov_b", "key": "gvp_g{abcd1234.1}"}),
        (ProjectionKeyInvalid("nexus"), 422, {"type": "invalid_target_key", "key": "nexus"}),
    ]:
        assert type(exc) in HTTP_MAPPED
        err = _raised(exc)
        assert err.status_code == status
        assert {k: err.detail[k] for k in detail} == detail and err.detail["message"]


def test_graph_not_writable_is_409_with_state_reason_retryable():
    exc = GraphNotWritable("frozen")
    assert type(exc) in HTTP_MAPPED
    assert not isinstance(exc, (ConcurrencyError, ValueError))   # neither 'integrity' nor 404
    err = _raised(exc)
    assert err.status_code == 409
    assert {k: err.detail[k] for k in ("type", "state", "reason", "retryable")} == {
        "type": "graph_not_writable", "state": "frozen", "reason": "frozen", "retryable": False}
    assert "paused" in err.detail["message"]


def test_a_lifecycle_state_this_code_does_not_know_is_still_409():
    """A later schema stores more states (doc 14 §3); one this code has no words for is refused
    the same way, not a KeyError and a 500."""
    err = _raised(GraphNotWritable("live_legacy"))
    assert err.status_code == 409
    assert (err.detail["type"], err.detail["state"]) == ("graph_not_writable", "live_legacy")
    assert err.detail["message"]


def test_version_conflict_names_the_resource_and_current_version():
    exc = VersionConflict("lifecycle", 3)
    assert type(exc) in HTTP_MAPPED
    err = _raised(exc)
    assert err.status_code == 409
    assert {k: err.detail[k] for k in ("type", "resource", "currentVersion")} == {
        "type": "version_conflict", "resource": "lifecycle", "currentVersion": 3}


@pytest.mark.parametrize("status", ["merged", "abandoned", "publishing"])
def test_require_open_raises_branch_not_open(status):
    with pytest.raises(BranchNotOpen) as info:
        GraphVersioningService._require_open(SimpleNamespace(id="br_2", status=status))
    assert info.value.status == status


def test_require_open_lets_an_open_draft_through():
    GraphVersioningService._require_open(SimpleNamespace(id="br_3", status="open"))


@pytest.mark.asyncio
async def test_the_app_registers_a_handler_for_every_mapped_error():
    main = pytest.importorskip("backend.app.main")
    for cls in HTTP_MAPPED:
        assert cls in main.app.exception_handlers, f"no handler for {cls.__name__}"
    handler = main.app.exception_handlers[LockBusy]
    resp = await handler(None, ContentionExhausted())
    assert resp.status_code == 503
    assert resp.headers["retry-after"] == "2"
    assert json.loads(bytes(resp.body))["detail"]["type"] == "lock_busy"


@pytest.mark.asyncio
async def test_a_plain_access_denied_outside_the_versioning_router_is_403_not_500():
    main = pytest.importorskip("backend.app.main")
    assert main.app.exception_handlers.get(AccessDenied) is not None, "a plain AccessDenied would answer 500"
    resp = await main.app.exception_handlers[AccessDenied](None, AccessDenied("author cannot approve their own PR"))
    assert resp.status_code == 403
    assert json.loads(bytes(resp.body))["detail"] == {"type": "access_denied",
                                                      "message": "author cannot approve their own PR"}
    assert main.app.exception_handlers[NotDraftOwner] is not main.app.exception_handlers[AccessDenied]
