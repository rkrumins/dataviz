"""A data source's drafts and reviews policy: the level a new draft starts at, the levels a draft
may have, and whether the person who opened a review may approve or merge it.

* Each field resolves on its own: the data source's override, else its workspace's setting, else
  the built-in default (public, any, allowed, allowed), and says which level it came from.
* A level that is the only one allowed is also where a new draft starts.
* Workspace admins set the policy for their workspace and for each of its data sources; anyone
  who reads a data source reads it. None of it is on the API-key surface.
* A real change is recorded in the activity log once, with what it was and what it became; saving
  what is already there records nothing. ``"inherit"`` clears a field, and a field left out stays.
"""
from __future__ import annotations

import json
import time
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from backend.app.api.v1.endpoints import versioning as V
from backend.app.auth import api_key_surface
from backend.app.db.models import OutboxEventORM, ProviderORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.main import app
from backend.app.services import drafts_policy
from backend.app.services.activity import catalogue
from backend.app.services.feature_flags import feature_flags

_EVENT = "workspace.versioning.drafts_policy_updated"


def _row(**values):
    columns = ("draft_default_visibility", "draft_levels", "review_self_approval", "review_self_merge")
    return SimpleNamespace(**{c: values.get(c) for c in columns})


def test_each_field_resolves_on_its_own():
    workspace = _row(draft_default_visibility="private", review_self_approval=False)
    source = _row(review_self_approval=True, review_self_merge=False)
    policy = drafts_policy.resolve(workspace, source)
    assert (policy.default_visibility, policy.levels, policy.self_approval, policy.self_merge) == (
        "private", "any", True, False)
    assert dict(policy.sources) == {"defaultVisibility": "workspace", "levels": "default",
                                    "selfApproval": "data_source", "selfMerge": "data_source"}
    built_in = drafts_policy.resolve(None, None)
    assert (built_in.default_visibility, built_in.levels, built_in.self_approval,
            built_in.self_merge) == ("public", "any", True, True)
    assert set(dict(built_in.sources).values()) == {"default"}


@pytest.mark.parametrize("levels, default, start", [
    ("public_only", "private", "public"), ("private_only", "public", "private"),
    ("any", "private", "private"),
])
def test_a_level_that_is_the_only_one_allowed_is_where_new_drafts_start(levels, default, start):
    policy = drafts_policy.resolve(_row(draft_default_visibility=default), _row(draft_levels=levels))
    assert policy.default_visibility == start
    assert policy.allows("public") is (levels != "private_only")
    assert policy.allows("private") is (levels != "public_only")
    if levels != "any":
        assert dict(policy.sources)["defaultVisibility"] == "data_source"


def _gate_perms(dependant) -> set:
    perms, stack = set(), [dependant]
    while stack:
        dep = stack.pop()
        perm = getattr(getattr(dep, "call", None), "required_permission", None)
        if perm:
            perms.add(perm)
        stack.extend(dep.dependencies)
    return perms


_WS = "/api/v1/{ws_id}/versioning/drafts-policy"
_DS = "/api/v1/{ws_id}/versioning/data-sources/{data_source_id}/drafts-policy"


@pytest.mark.parametrize("path, method, permission", [
    (_WS, "GET", "workspace:datasource:read"), (_WS, "PUT", "workspace:admin"),
    (_DS, "GET", "workspace:datasource:read"), (_DS, "PUT", "workspace:admin"),
])
def test_admins_set_the_policy_and_readers_read_it_never_with_a_key(path, method, permission):
    found = [(r, d) for m, p, r, d in api_key_surface.routes(app) if p == path and m == method]
    assert len(found) == 1, found
    route, dependant = found[0]
    assert permission in _gate_perms(dependant)
    assert (route.endpoint.__module__, route.endpoint.__name__) not in api_key_surface.SURFACE


@pytest.fixture
def versioning_on():
    feature_flags._cache = {"versioningEnabled": True}
    feature_flags._cache_ts = time.monotonic()
    yield
    feature_flags.invalidate()


@pytest.fixture
async def estate(db_session):
    db_session.add_all([
        WorkspaceORM(id="ws_1", name="Finance"),
        WorkspaceORM(id="ws_2", name="Elsewhere"),
        ProviderORM(id="prov_1", name="Prod graph", provider_type="falkordb"),
        WorkspaceDataSourceORM(id="ds_1", workspace_id="ws_1", provider_id="prov_1",
                               graph_name="g_fin", label="Ledger"),
        WorkspaceDataSourceORM(id="ds_9", workspace_id="ws_2", provider_id="prov_1",
                               graph_name="g_other", label="Other"),
    ])
    await db_session.commit()


async def _recorded(db_session) -> list[dict]:
    rows = (await db_session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type == _EVENT))).scalars().all()
    return [json.loads(r.payload) for r in rows]


@pytest.mark.asyncio
async def test_a_workspace_sets_its_policy_and_a_change_is_recorded_once(
        test_client, db_session, estate, versioning_on):
    base = "/api/v1/ws_1/versioning/drafts-policy"
    start = await test_client.get(base)
    assert start.status_code == 200, start.text
    assert start.json()["settings"] == {"defaultVisibility": None, "levels": None,
                                        "selfApproval": None, "selfMerge": None}
    assert start.json()["effective"]["defaultVisibility"] == "public"

    changed = await test_client.put(base, json={"defaultVisibility": "private", "selfApproval": False})
    assert changed.status_code == 200, changed.text
    body = changed.json()
    assert body["settings"] == {"defaultVisibility": "private", "levels": None,
                                "selfApproval": False, "selfMerge": None}
    assert (body["effective"]["defaultVisibility"], body["effective"]["selfApproval"],
            body["effective"]["sources"]["selfApproval"]) == ("private", False, "workspace")
    [event] = await _recorded(db_session)
    assert (event["workspace_id"], event["target_type"], event["target_id"]) == ("ws_1", "workspace", "ws_1")
    assert event["details"] == {"scope": "workspace", "from": {"defaultVisibility": None, "selfApproval": None},
                                "to": {"defaultVisibility": "private", "selfApproval": False}}
    projected = catalogue.project(event_type=_EVENT, payload=event, event_version=2)
    assert (projected["audience"], projected["workspace_id"]) == ("workspace", "ws_1")

    again = await test_client.put(base, json={"defaultVisibility": "private"})
    assert again.status_code == 200 and len(await _recorded(db_session)) == 1

    cleared = await test_client.put(base, json={"defaultVisibility": "inherit"})
    assert cleared.json()["settings"]["defaultVisibility"] is None
    assert cleared.json()["settings"]["selfApproval"] is False          # left out: it stays
    assert len(await _recorded(db_session)) == 2

    bad = await test_client.put(base, json={"levels": "everyone"})
    assert bad.status_code == 422


@pytest.mark.asyncio
async def test_a_data_source_overrides_its_workspace(test_client, db_session, estate, versioning_on):
    await test_client.put("/api/v1/ws_1/versioning/drafts-policy", json={"selfMerge": False})
    path = "/api/v1/ws_1/versioning/data-sources/ds_1/drafts-policy"
    changed = await test_client.put(path, json={"levels": "private_only"})
    assert changed.status_code == 200, changed.text
    body = changed.json()
    assert body["overrides"]["levels"] == "private_only"
    assert body["workspace"]["selfMerge"] is False
    effective = body["effective"]
    assert (effective["levels"], effective["defaultVisibility"], effective["selfMerge"]) == (
        "private_only", "private", False)
    assert (effective["sources"]["levels"], effective["sources"]["selfMerge"]) == ("data_source", "workspace")
    events = await _recorded(db_session)
    assert events[-1]["data_source_id"] == "ds_1"
    assert events[-1]["details"] == {"scope": "data_source", "from": {"levels": None},
                                     "to": {"levels": "private_only"}}
    assert (await test_client.get(path)).json() == body


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["GET", "PUT"])
async def test_a_data_source_of_another_workspace_is_not_found(
        test_client, db_session, estate, versioning_on, method):
    resp = await test_client.request(method, "/api/v1/ws_1/versioning/data-sources/ds_9/drafts-policy",
                                     json={"levels": "public_only"} if method == "PUT" else None)
    assert resp.status_code == 404, resp.text
    assert await _recorded(db_session) == []


@pytest.mark.asyncio
async def test_load_reads_the_source_and_its_workspace(db_session, estate):
    ds = await db_session.get(WorkspaceDataSourceORM, "ds_1")
    ds.review_self_approval = False
    await db_session.flush()
    policy = await drafts_policy.load(db_session, "ds_1")
    assert (policy.self_approval, dict(policy.sources)["selfApproval"]) == (False, "data_source")
    with pytest.raises(LookupError):
        await drafts_policy.load(db_session, "ds_missing")
    assert V.get_workspace_drafts_policy is not None


#: Every call that can open a draft, and the keyword that carries the level it opens it at.
_OPENS_A_DRAFT = {"open_draft": "visibility", "_add_draft": "visibility",
                  "create_import_job": "draft_visibility", "resolve_graph": "draft_visibility"}


def test_every_draft_the_app_opens_is_opened_at_its_policys_level():
    """A caller that leaves the level out opens a private draft whatever the data source's policy
    says: every one in the app passes it. ``resolve_graph`` opens one unless told not to."""
    import ast
    from pathlib import Path

    app = Path(__file__).resolve().parents[1] / "app"
    missing = []
    for path in sorted(app.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(), str(path))):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
                continue                                # a bare name is a callback the route passes
            name = node.func.attr
            needed = _OPENS_A_DRAFT.get(name)
            if needed is None:
                continue
            keywords = {k.arg: k.value for k in node.keywords}
            if name == "resolve_graph":
                if "data_source_id" not in keywords:            # a FalkorDB client's, not ours
                    continue
                flag = keywords.get("open_draft_if_absent")
                if isinstance(flag, ast.Constant) and flag.value is False:
                    continue
            if needed not in keywords:
                missing.append(f"{path.relative_to(app)}:{node.lineno} {name}")
    assert missing == [], missing
