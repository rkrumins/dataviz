"""The requests the browser sends to make a view from a query, pinned across the tiers.

``tests/fixtures/membership_requests.json`` holds each body exactly as the browser
builds it (the frontend's ``requests.contract.test.ts`` builds them from the same
inputs and must match). Here each must validate against the model its route reads —
which refuses any field it doesn't know — and come back out unchanged: nothing
dropped, nothing renamed. A field the browser starts sending before the server
accepts it fails here, not as a 422 under a reader's preview.
"""
import json
from pathlib import Path

import pytest

from backend.common.models.view_membership import FromMembersRequest, PlanRequest

FIXTURE = Path(__file__).parent / "fixtures" / "membership_requests.json"
CASES = json.loads(FIXTURE.read_text())["cases"]
MODELS = {"plan": PlanRequest, "create": FromMembersRequest}


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_the_server_takes_what_the_browser_sends(case):
    model = MODELS[case["builder"]].model_validate(case["body"])
    assert model.model_dump(mode="json", by_alias=True, exclude_unset=True) == case["body"]


def test_the_browser_side_still_reads_this_fixture():
    """The other half of the contract: if the frontend test stops reading the fixture,
    this one proves nothing about what the browser sends."""
    frontend = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "features" / "live-views"
                / "__tests__" / "requests.contract.test.ts")
    assert "backend/tests/fixtures/membership_requests.json" in frontend.read_text()
