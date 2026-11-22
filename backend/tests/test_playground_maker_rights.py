"""In the Playground, the person who made a graph finishes it — and nobody else changes it.

* Its maker publishes its drafts, merges their reviews, loads it (bulk ingest) and has an import
  publish itself, without ``workspace:datasource:publish`` — and the reviews and branches they read
  say so (``viewerCan.merge``, ``access.canPublish``). A Playground or platform admin may too.
* Everything else that advances its main is theirs too: revert, restore, freeze and unfreeze,
  sync, update a fork of theirs from its parent, merge a fork's review into it — and the forks
  list says who may (``canPublish``).
* Another member may not open, stage or resolve a draft on it: 403 ``playground_not_yours``.
* Its drafts start private.
* A standard workspace is unchanged: making a graph there gives no publish, and anyone who
  manages its data sources opens drafts on it.

The version store is faked (it runs on Postgres only); the data sources and workspaces are real rows.
"""
from __future__ import annotations

import contextlib
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from httpx import AsyncClient

from backend.app.api.v1.endpoints import graph as graph_ep
from backend.app.api.v1.endpoints import versioning as versioning_ep
from backend.app.auth.dependencies import get_current_user, get_optional_user, get_permission_claims
from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.services import drafts_policy, playground_policy
from backend.app.services.feature_flags import feature_flags
from backend.app.services.permission_service import KeyScope, PermissionClaims
from backend.auth_service.interface import User

PG, TEAM = "ws_play", "ws_team"
MEMBER_PERMS = (
    "workspace:datasource:manage", "workspace:datasource:read", "workspace:ontology:read",
    "workspace:provider:read", "workspace:view:create", "workspace:view:delete",
    "workspace:view:edit", "workspace:view:read",
)


def _user(uid: str) -> User:
    return User(id=uid, email=f"{uid}@example.com", first_name="T", last_name="U", role="user",
                status="active", created_at="2024-01-01T00:00:00Z", updated_at="2024-01-01T00:00:00Z")


ADA, BEN, CY = _user("usr_ada"), _user("usr_ben"), _user("usr_cy")
#: A member of the Playground and of a standard workspace, publishing in neither.
MEMBER = PermissionClaims(sid="s_m", ws_perms={PG: MEMBER_PERMS, TEAM: MEMBER_PERMS})
PG_ADMIN = PermissionClaims(sid="s_a", ws_perms={PG: MEMBER_PERMS + ("workspace:admin",)})
PLATFORM_ADMIN = PermissionClaims(sid="s_p", global_perms=("system:admin",))
TEAM_PUBLISHER = PermissionClaims(sid="s_t", ws_perms={TEAM: MEMBER_PERMS + ("workspace:datasource:publish",)})

#: graph id → (workspace, data source). Both data sources are Ada's.
GRAPHS = {"g_ada": (PG, "ds_ada"), "g_team": (TEAM, "ds_team")}


class _VersionStore:
    """The versioning calls the routes make, recorded."""

    def __init__(self):
        self.calls: list = []

    def _did(self, name, kwargs):
        self.calls.append((name, kwargs))

    def did(self, name):
        return [kwargs for called, kwargs in self.calls if called == name]

    async def get_graph(self, graph_id):
        if graph_id not in GRAPHS:
            return None
        ws_id, ds_id = GRAPHS[graph_id]
        return {"graph_id": graph_id, "workspace_id": ws_id, "data_source_id": ds_id, "kind": "manual",
                "provider_id": None, "main_branch_id": f"main_{graph_id}"}

    async def get_pr(self, pr_id):
        """``pr_<graph>``: a draft's review on it; ``pr_fork_<graph>``: a fork's review into it."""
        fork = pr_id.startswith("pr_fork_")
        graph_id = pr_id.removeprefix("pr_fork_" if fork else "pr_")
        return {"pr_id": pr_id, "target_graph_id": graph_id,
                "source_graph_id": f"g_fork_of_{graph_id}" if fork else graph_id,
                "source_branch_id": f"br_{graph_id}", "actor": BEN.id if fork else ADA.id,
                "reviewers": [], "status": "open"}

    async def revert_commit(self, **kwargs):
        self._did("revert_commit", kwargs)
        return "c_new"

    async def restore_to_commit(self, **kwargs):
        self._did("restore_to_commit", kwargs)
        return "c_new"

    async def set_frozen(self, **kwargs):
        self._did("set_frozen", kwargs)
        return {"graph_id": kwargs["graph_id"], "state": "frozen" if kwargs["frozen"] else "active",
                "rev": kwargs["expected_rev"] + 1, "changed": True}

    async def list_forks(self, **_kwargs):
        def fork(graph_id, deleted_at=None):
            return {"graph_id": graph_id, "workspace_id": PG, "data_source_id": "ds_ada", "kind": "fork",
                    "fork_parent_graph_id": "g_ada", "main_head_commit_seq": 1, "created_by": ADA.id,
                    "created_at": "t", "deleted_at": deleted_at, "deleted_by": None, "purging": False}
        return [fork("g_fork_live"), fork("g_fork_trashed", deleted_at="2026-11-20T00:00:00+00:00")]

    async def branch_change_count(self, **_kwargs):
        return 1

    async def publish(self, **kwargs):
        self._did("publish", kwargs)
        return "c_new"

    async def merge_mr(self, **kwargs):
        self._did("merge_mr", kwargs)
        return "c_new"

    async def publish_outcome(self, *, graph_id, commit_id, at_revision=None):
        return {"outcome": "published", "commit_id": commit_id, "revision_id": 2}

    async def bulk_ingest(self, **kwargs):
        self._did("bulk_ingest", kwargs)
        return {"commit_id": "c_new", "commit_seq": 2, "ingested": len(kwargs["rows"]), "rejected": []}

    async def open_draft(self, **kwargs):
        self._did("open_draft", kwargs)
        return "br_new"

    async def resolve_graph(self, **kwargs):
        self._did("resolve_graph", kwargs)
        return {"graph_id": "g_ada", "main_branch_id": "main_g_ada", "main_head_commit_seq": 2,
                "my_draft": {"branch_id": "br_new"}, "kind": "blank"}

    async def stage_changes(self, **kwargs):
        self._did("stage_changes", kwargs)
        return {}

    async def list_branches(self, **_kwargs):
        branch = {"branch_id": "br_g_ada", "kind": "draft", "owner": ADA.id, "status": "open",
                  "visibility": "private", "created_at": "t", "updated_at": "t",
                  "access": {"canRead": True, "canWrite": True, "canManage": True}}
        return [branch], None


@contextlib.contextmanager
def _as(user: User, claims: PermissionClaims):
    from backend.app.main import app

    async def _u():
        return user

    saved = {k: app.dependency_overrides.get(k) for k in (get_current_user, get_optional_user, get_permission_claims)}
    app.dependency_overrides[get_current_user] = _u
    app.dependency_overrides[get_optional_user] = _u
    app.dependency_overrides[get_permission_claims] = lambda: claims
    try:
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                app.dependency_overrides.pop(k, None)
            else:
                app.dependency_overrides[k] = v


@pytest.fixture
async def world(db_session, monkeypatch):
    """The Playground and a standard workspace, each with a data source of Ada's on a faked graph;
    everything a publish or merge does after it is allowed, a no-op."""
    from backend.app.main import app

    db_session.add_all([
        ProviderORM(id="prov_sandbox", name="Sandbox", provider_type="falkordb", host="sandbox", port=6379),
        WorkspaceORM(id=PG, name="Playground", kind="playground", request_policy="open", publish_policy="request",
                     playground_settings=json.dumps({"sandboxProviderId": "prov_sandbox"})),
        WorkspaceORM(id=TEAM, name="Team"),
    ])
    await db_session.flush()
    for ds_id, ws_id in (("ds_ada", PG), ("ds_team", TEAM)):
        db_session.add(WorkspaceDataSourceORM(id=ds_id, workspace_id=ws_id, provider_id="prov_sandbox",
                                              graph_name=f"blank_{ds_id}", label=ds_id, created_by=ADA.id))
    await db_session.commit()

    async def _nothing(*_args, **_kwargs):
        return None

    async def _told(*_args, **_kwargs):
        return set()

    for helper in ("_bump_main_cache", "_touch_views_data_updated", "_promote_view_layout_overlay",
                   "_tell_review_people", "_live_containment_types", "_rules_for_meta",
                   "_node_identity_for_meta", "_pr_containment_types", "_pr_ontology_rules",
                   "_ensure_view_layout_overlay", "project_now", "nudge_projection"):
        monkeypatch.setattr(versioning_ep, helper, _nothing)
    monkeypatch.setattr(versioning_ep, "_tell_draft_people", _told)
    store = _VersionStore()
    app.dependency_overrides[versioning_ep.get_versioning_service] = lambda: store
    yield store
    app.dependency_overrides.pop(versioning_ep.get_versioning_service, None)


def _url(ws_id: str, path: str) -> str:
    return f"/api/v1/{ws_id}/versioning{path}"


def _refusal(r) -> str:
    detail = r.json()["detail"]
    return detail.get("type") if detail.get("type") != "access_denied" else detail.get("code") or detail["type"]


# ── The maker finishes their own work ────────────────────────────────────

@pytest.mark.asyncio
async def test_the_maker_publishes_their_draft_and_merges_its_review_without_publish(
        test_client: AsyncClient, world):
    with _as(ADA, MEMBER):
        published = await test_client.post(_url(PG, "/graphs/g_ada/branches/br_g_ada/publish"),
                                           json={"message": "My change"})
        merged = await test_client.post(_url(PG, "/merge-requests/pr_g_ada/merge"), json={"message": "Merge"})
    assert published.status_code == 200, published.text
    assert merged.status_code == 200, merged.text
    assert [c["actor"] for c in world.did("publish")] == [ADA.id]
    assert [c["mr_id"] for c in world.did("merge_mr")] == ["pr_g_ada"]


@pytest.mark.asyncio
async def test_another_member_may_not_publish_or_merge_it(test_client: AsyncClient, world):
    with _as(BEN, MEMBER):
        published = await test_client.post(_url(PG, "/graphs/g_ada/branches/br_g_ada/publish"),
                                           json={"message": "Not mine"})
        merged = await test_client.post(_url(PG, "/merge-requests/pr_g_ada/merge"), json={"message": "Merge"})
    assert published.status_code == 403 and merged.status_code == 403, (published.text, merged.text)
    assert world.did("publish") == [] and world.did("merge_mr") == []


@pytest.mark.asyncio
async def test_the_maker_loads_their_graph_and_has_an_import_publish_itself(
        test_client: AsyncClient, world, monkeypatch):
    jobs = SimpleNamespace(created=[])

    async def create_import_job(**kwargs):
        jobs.created.append(kwargs)
        return {"job_id": "vjob_1", "branch_id": "br_1", "source_uri": "f"}

    async def stored(*_args, **_kwargs):
        return {"jobId": "vjob_1", "branchId": "br_1", "sourceUri": "f", "status": "pending"}

    async def no_job(*_args, **_kwargs):
        return None

    from backend.app.main import app
    app.dependency_overrides[versioning_ep.get_import_export_service] = lambda: SimpleNamespace(
        create_import_job=create_import_job)
    monkeypatch.setattr(versioning_ep, "_store_and_start", stored)
    monkeypatch.setattr(versioning_ep, "_job_for_key", no_job)
    try:
        with _as(ADA, MEMBER):
            loaded = await test_client.post(_url(PG, "/graphs/g_ada/bulk-ingest"),
                                            content=b'{"kind":"node","urn":"urn:a","entityType":"t"}\n')
            imported = await test_client.post(_url(PG, "/graphs/g_ada/imports"), params={"autoPublish": "true"},
                                              content=b"{}\n")
        with _as(BEN, MEMBER):
            refused_load = await test_client.post(_url(PG, "/graphs/g_ada/bulk-ingest"), content=b"{}\n")
            refused_import = await test_client.post(_url(PG, "/graphs/g_ada/imports"),
                                                    params={"autoPublish": "true"}, content=b"{}\n")
    finally:
        app.dependency_overrides.pop(versioning_ep.get_import_export_service, None)
    assert loaded.status_code == 200, loaded.text
    assert imported.status_code == 202, imported.text
    assert [j["auto_publish"] for j in jobs.created] == [True]
    assert jobs.created[0]["draft_visibility"] == "private"          # the Playground's drafts start private
    assert refused_load.status_code == 403 and _refusal(refused_load) == "publish_required"
    assert refused_import.status_code == 403 and _refusal(refused_import) == "playground_not_yours"
    assert len(world.did("bulk_ingest")) == 1


@pytest.mark.asyncio
async def test_the_review_and_the_branches_say_who_may_publish(test_client: AsyncClient, world, db_session):
    pr = await world.get_pr("pr_g_ada")
    can = await versioning_ep._viewer_can(world, db_session, pr, ADA.id, MEMBER, PG)
    cannot = await versioning_ep._viewer_can(world, db_session, pr, BEN.id, MEMBER, PG)
    assert (can["merge"], can["mergeReason"]) == (True, None)
    assert (cannot["merge"], cannot["mergeReason"]) == (False, "publish_required")

    async def can_publish(user, claims, ws_id, graph_id):
        with _as(user, claims):
            r = await test_client.get(_url(ws_id, f"/graphs/{graph_id}/branches"))
        assert r.status_code == 200, r.text
        return r.json()[0]["access"]["canPublish"]

    assert await can_publish(ADA, MEMBER, PG, "g_ada") is True
    assert await can_publish(BEN, MEMBER, PG, "g_ada") is False
    assert await can_publish(ADA, MEMBER, TEAM, "g_team") is False        # made it, but not in the Playground
    assert await can_publish(BEN, TEAM_PUBLISHER, TEAM, "g_team") is True


# ── Everything else that advances main ───────────────────────────────────

#: Every route that advances a graph's main, and so is its Playground maker's without publish.
_MAKERS_ROUTES = (
    ("POST", "/graphs/{graph_id}/branches/{branch_id}/publish"),
    ("POST", "/merge-requests/{pr_id}/merge"),
    ("POST", "/pulls/{pr_id}/merge"),
    ("POST", "/graphs/{graph_id}/lifecycle/freeze"),
    ("POST", "/graphs/{graph_id}/lifecycle/unfreeze"),
    ("POST", "/graphs/{graph_id}/commits/{commit_id}/revert"),
    ("POST", "/graphs/{graph_id}/commits/{commit_id}/restore"),
    ("POST", "/graphs/{graph_id}/sync"),
    ("POST", "/graphs/{graph_id}/update-from-parent"),
)


def _calls(dependant) -> set:
    found = set()
    for dep in dependant.dependencies:
        found.add(dep.call)
        found |= _calls(dep)
    return found


def test_every_route_that_advances_main_is_the_makers_too():
    gates = {(method, route.path): versioning_ep.require_publish_or_maker in _calls(route.dependant)
             for route in versioning_ep.router.routes for method in getattr(route, "methods", ())
             if (method, route.path) in _MAKERS_ROUTES}
    assert gates == {r: True for r in _MAKERS_ROUTES}


@pytest.mark.asyncio
async def test_the_maker_reverts_restores_and_freezes_their_graph(test_client: AsyncClient, world):
    with _as(ADA, MEMBER):
        rs = [await test_client.post(_url(PG, f"/graphs/g_ada/commits/c_1/{verb}"), json={"message": "Back"})
              for verb in ("revert", "restore")]
        rs += [await test_client.post(_url(PG, f"/graphs/g_ada/lifecycle/{verb}"), json={"expectedRev": 0})
               for verb in ("freeze", "unfreeze")]
    for r in rs:
        assert r.status_code == 200, r.text
    assert [c["actor"] for c in world.did("revert_commit") + world.did("restore_to_commit")] == [ADA.id] * 2
    assert [c["frozen"] for c in world.did("set_frozen")] == [True, False]


@pytest.mark.parametrize("who, claims, ws_id, graph_id", [
    (BEN, MEMBER, PG, "g_ada"),         # another member, on Ada's graph
    (ADA, MEMBER, TEAM, "g_team"),      # Ada made it, but a standard workspace needs publish
], ids=["another-member", "standard-workspace"])
@pytest.mark.asyncio
async def test_nobody_else_reverts_restores_or_freezes_it(test_client: AsyncClient, world, who, claims,
                                                          ws_id, graph_id):
    with _as(who, claims):
        rs = [await test_client.post(_url(ws_id, f"/graphs/{graph_id}/commits/c_1/{verb}"), json={"message": "B"})
              for verb in ("revert", "restore")]
        rs += [await test_client.post(_url(ws_id, f"/graphs/{graph_id}/lifecycle/{verb}"), json={"expectedRev": 0})
               for verb in ("freeze", "unfreeze")]
    for r in rs:
        assert r.status_code == 403, r.text
    assert world.did("revert_commit") == world.did("restore_to_commit") == world.did("set_frozen") == []


@pytest.mark.asyncio
async def test_the_parent_graphs_maker_merges_a_forks_review_into_it(world, db_session):
    from starlette.requests import Request

    def merging(pr_id):
        return Request({"type": "http", "path_params": {"ws_id": PG, "pr_id": pr_id}})

    assert await versioning_ep.require_publish_or_maker(merging("pr_fork_g_ada"), ADA, MEMBER, world, db_session) is ADA
    with pytest.raises(HTTPException) as refused:
        await versioning_ep.require_publish_or_maker(merging("pr_fork_g_ada"), BEN, MEMBER, world, db_session)
    assert refused.value.status_code == 403
    pr = await world.get_pr("pr_fork_g_ada")
    can = await versioning_ep._viewer_can(world, db_session, pr, ADA.id, MEMBER, PG)
    cannot = await versioning_ep._viewer_can(world, db_session, pr, BEN.id, MEMBER, PG)
    assert (can["merge"], can["mergeReason"]) == (True, None)
    assert (cannot["merge"], cannot["mergeReason"]) == (False, "publish_required")


@pytest.mark.asyncio
async def test_the_forks_list_says_who_may_update_each(test_client: AsyncClient, world):
    async def can_publish(user):
        with _as(user, MEMBER):
            r = await test_client.get(_url(PG, "/graphs/g_ada/forks"))
        assert r.status_code == 200, r.text
        return [f.get("canPublish") for f in r.json()]

    assert await can_publish(ADA) == [True, None]       # a trashed fork says nothing
    assert await can_publish(BEN) == [False, None]


# ── Others' graphs are read-only to them ─────────────────────────────────

@pytest.mark.asyncio
async def test_another_member_may_not_open_resolve_or_stage_a_draft_on_it(test_client: AsyncClient, world):
    with _as(BEN, MEMBER):
        opened = await test_client.post(_url(PG, "/graphs/g_ada/branches"), json={})
        resolved = await test_client.post(_url(PG, "/resolve"), json={"dataSourceId": "ds_ada"})
        staged = await test_client.post(_url(PG, "/graphs/g_ada/branches/br_g_ada/changes"), json={
            "ops": [{"op": "create", "entityKind": "node", "payload": {"entityType": "t"}}]})
    for r in (opened, resolved, staged):
        assert r.status_code == 403, r.text
        assert r.json()["detail"]["type"] == "playground_not_yours"
    assert world.calls == []


@pytest.mark.asyncio
async def test_a_draft_write_on_the_canvas_is_refused_too(test_client: AsyncClient, world, db_session):
    from backend.app.main import app

    engine = SimpleNamespace(_db_session=db_session, _data_source_id="ds_ada", _branch_id="br_g_ada",
                             _actor=BEN.id, _writes_main=False)
    feature_flags._cache["editModeEnabled"] = True
    app.dependency_overrides[graph_ep.get_context_engine] = lambda: engine
    try:
        with _as(BEN, MEMBER):
            saved = await test_client.post(f"/api/v1/{PG}/graph/changes",
                                           params={"dataSourceId": "ds_ada", "branchId": "br_g_ada"},
                                           json={"ops": []})
    finally:
        app.dependency_overrides.pop(graph_ep.get_context_engine, None)
    assert saved.status_code == 403 and saved.json()["detail"]["type"] == "playground_not_yours", saved.text
    # The per-entity writes, through the gate every one of them shares (``require_main_writer``).
    with pytest.raises(HTTPException) as refused:
        await graph_ep.require_playground_maker(ws_id=PG, dataSourceId="ds_ada", branchId="br_g_ada",
                                                user=BEN, claims=MEMBER, session=db_session)
    assert refused.value.detail["type"] == "playground_not_yours"
    await graph_ep.require_playground_maker(ws_id=PG, dataSourceId="ds_ada", branchId="br_g_ada",
                                            user=ADA, claims=MEMBER, session=db_session)
    await graph_ep.require_playground_maker(ws_id=PG, dataSourceId="ds_ada", branchId=None,   # main: publish's
                                            user=BEN, claims=MEMBER, session=db_session)


@pytest.mark.asyncio
async def test_the_maker_opens_drafts_on_it_and_they_start_private(test_client: AsyncClient, world):
    with _as(ADA, MEMBER):
        opened = await test_client.post(_url(PG, "/graphs/g_ada/branches"), json={})
        resolved = await test_client.post(_url(PG, "/resolve"), json={"dataSourceId": "ds_ada"})
    assert opened.status_code == 201 and resolved.status_code == 200, (opened.text, resolved.text)
    assert [c["visibility"] for c in world.did("open_draft")] == ["private"]
    assert [c["draft_visibility"] for c in world.did("resolve_graph")] == ["private"]


@pytest.mark.parametrize("who, claims", [(CY, PG_ADMIN), (CY, PLATFORM_ADMIN)], ids=["playground", "platform"])
@pytest.mark.asyncio
async def test_an_admin_still_opens_and_publishes_on_anyones_graph(test_client: AsyncClient, world, who, claims):
    with _as(who, claims):
        opened = await test_client.post(_url(PG, "/graphs/g_ada/branches"), json={})
        published = await test_client.post(_url(PG, "/graphs/g_ada/branches/br_g_ada/publish"),
                                           json={"message": "Admin's fix"})
    assert opened.status_code == 201 and published.status_code == 200, (opened.text, published.text)


# ── A standard workspace is unchanged ────────────────────────────────────

@pytest.mark.asyncio
async def test_a_standard_workspace_is_unchanged(test_client: AsyncClient, world):
    with _as(BEN, MEMBER):                  # Ada's graph: anyone who manages its data sources opens drafts
        opened = await test_client.post(_url(TEAM, "/graphs/g_team/branches"), json={})
    with _as(ADA, MEMBER):                  # making it gives no publish there
        published = await test_client.post(_url(TEAM, "/graphs/g_team/branches/br_g_team/publish"),
                                           json={"message": "Mine"})
        merged = await test_client.post(_url(TEAM, "/merge-requests/pr_g_team/merge"), json={"message": "M"})
        loaded = await test_client.post(_url(TEAM, "/graphs/g_team/bulk-ingest"), content=b"{}\n")
    assert opened.status_code == 201, opened.text
    assert [c["visibility"] for c in world.did("open_draft")] == ["public"]     # the built-in default
    for r in (published, merged, loaded):
        assert r.status_code == 403, r.text
    assert world.did("publish") == [] and world.did("merge_mr") == [] and world.did("bulk_ingest") == []


# ── Who counts as the maker ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_who_counts_as_the_maker(db_session, world):
    ada_pg = await db_session.get(WorkspaceDataSourceORM, "ds_ada")
    ada_team = await db_session.get(WorkspaceDataSourceORM, "ds_team")

    async def maker(ds, user, claims):
        return await playground_policy.is_playground_maker(db_session, ds, user.id, claims)

    assert await maker(ada_pg, ADA, MEMBER) is True
    assert await maker(ada_pg, BEN, MEMBER) is False
    assert await maker(ada_pg, CY, PG_ADMIN) is True
    assert await maker(ada_pg, CY, PLATFORM_ADMIN) is True
    assert await maker(ada_team, ADA, MEMBER) is False                     # not in the Playground
    assert await maker(ada_pg, ADA, PermissionClaims(sid="s_l")) is False   # left the Playground
    key = PermissionClaims(sid="s_k", ws_perms={PG: MEMBER_PERMS},
                           key_scope=KeyScope(key_id="key_1"))
    assert await maker(ada_pg, ADA, key) is False                            # a person, never a key
    assert await maker(None, ADA, MEMBER) is False


def test_the_playgrounds_drafts_start_private_unless_it_says_otherwise():
    playground = SimpleNamespace(kind="playground")
    policy = drafts_policy.resolve(playground)
    assert (policy.default_visibility, dict(policy.sources)["defaultVisibility"]) == ("private", "default")
    assert policy.allows("public")                                           # a maker may still share one
    playground.draft_default_visibility = "public"
    assert drafts_policy.resolve(playground).default_visibility == "public"
    assert drafts_policy.resolve(SimpleNamespace(kind="standard")).default_visibility == "public"
