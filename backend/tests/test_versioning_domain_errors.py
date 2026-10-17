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
    JobActive,
    LockBusy,
    MainWriteForbidden,
    MassDeleteBlocked,
)
from backend.app.services.versioning.service import GraphVersioningService


def _raised(exc: Exception) -> HTTPException:
    with pytest.raises(HTTPException) as info:
        with _domain_errors():
            raise exc
    return info.value


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
