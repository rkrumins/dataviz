"""Who writes a shared draft (doc 13 ``members`` visibility, Stage 2) — over HTTP, needs Postgres.

Alice owns a shared draft. Bob is a member editor, Dave a member viewer, and the group ``grp_eng``
(Erin is in it) a member editor; Carol holds workspace manage but is no member. Bob and Erin write
it through every draft-write route; Carol and Dave are refused with 403 ``not_owner_or_member``
naming the role they lack, and nothing they send lands. Publishing and abandoning need maintainer,
so an editor is refused those, a queued publish at request time. Frank is a maintainer only through
``grp_ops``: he manages members, renames and publishes, in the request or as a queued job.

Groups are looked up by the service itself, only when a group row could decide the answer. When
that lookup fails the answer is 503 ``groups_unavailable``, never a refusal, while the owner and a
direct member write on without it.

Only the owner changes who a draft is shared with, and every change starts from no members: making
it private removes them, and member rows left on a private draft grant nothing, not even after it is
shared again. Whoever is added must exist and, to write, hold workspace manage; that is checked only
for a caller allowed to manage members, under the draft's lock. The group lookup, users, groups and
their permissions are faked here.
"""
import asyncio
import os
from types import SimpleNamespace

import pytest

from sqlalchemy import select

from backend.app.services.versioning import config, db, models, service
from backend.app.services.versioning.errors import GroupsUnavailable

from .test_api_graph_draft_journey import _IMPORT_NDJSON, _StubCache, _StubManager, _build_app

_GROUPS = {"erin": ("grp_eng",), "frank": ("grp_ops",)}
_USERS = {"alice", "bob", "carol", "dave", "erin", "frank", "viola"}
_GROUP_NAMES = {"grp_eng": "Eng", "grp_ops": "Ops"}


def _app():
    from fastapi import Request
    from backend.app.auth.dependencies import get_current_user, get_optional_user, get_permission_claims
    from backend.app.api.v1.endpoints import versioning as V
    from backend.app.services.permission_service import PermissionClaims
    from backend.app.services.versioning.import_export.service import ImportExportService

    app, G = _build_app()

    async def header_user(request: Request):         # X-User picks the caller
        uid = request.headers.get("X-User", "alice")
        return SimpleNamespace(id=uid, email=f"{uid}@example.com")

    async def header_claims(request: Request):       # X-Manage: 0 leaves read only
        perms = ("workspace:datasource:read",)
        if request.headers.get("X-Manage", "1") == "1":
            perms += ("workspace:datasource:manage", "workspace:datasource:publish")
        return PermissionClaims(sid="", global_perms=(), ws_perms={"ws1": perms})
    app.dependency_overrides[get_current_user] = header_user
    app.dependency_overrides[get_optional_user] = header_user
    app.dependency_overrides[get_permission_claims] = header_claims
    # The queued-publish route is refused before the store is touched.
    app.dependency_overrides[V.get_import_export_service] = lambda: ImportExportService(
        versioning=V.get_versioning_service(), store=object())
    return app, G, V


def _groups(monkeypatch):
    """The management DB's group lookup, counted per caller; ``down`` makes it fail."""
    state = SimpleNamespace(calls=[], down=False)

    async def load(actor):
        state.calls.append(actor)
        if state.down:
            raise GroupsUnavailable()
        return _GROUPS.get(actor, ())
    monkeypatch.setattr(service, "_load_actor_groups", load)
    return state


@pytest.fixture(autouse=True)
def directory(monkeypatch):
    """The management DB's users, groups and permissions: Viola only reads, everyone else also
    manages. ``resolved`` lists whose permissions were looked up."""
    from backend.app.api.v1.endpoints import versioning as V
    from backend.app.db.repositories import group_repo, user_repo
    from backend.app.services import permission_service
    from backend.app.services.permission_service import PermissionClaims
    state = SimpleNamespace(resolved=[])

    async def get_user(_s, uid):
        return SimpleNamespace(id=uid) if uid in _USERS else None

    async def get_group(_s, gid):
        return SimpleNamespace(id=gid, name=_GROUP_NAMES[gid]) if gid in _GROUP_NAMES else None

    async def resolve(_s, uid, **_kw):
        state.resolved.append(uid)
        perms = ("workspace:datasource:read",) + (() if uid == "viola" else ("workspace:datasource:manage",))
        return PermissionClaims(sid="", global_perms=(), ws_perms={"ws1": perms})

    async def names(_s, ids):
        return {uid: (uid.capitalize(), f"{uid}@example.com") for uid in ids if uid in _USERS}
    monkeypatch.setattr(user_repo, "get_user_by_id", get_user)
    monkeypatch.setattr(group_repo, "get_group_by_id", get_group)
    monkeypatch.setattr(permission_service, "resolve", resolve)
    monkeypatch.setattr(V, "resolve_user_ids", names)
    return state


def _as(user, manage=True):
    return {"X-User": user, "X-Manage": "1" if manage else "0"}


def _refused(r, required, branch_id):
    assert r.status_code == 403, (r.request.url, r.text)
    detail = r.json()["detail"]
    assert (detail["type"], detail["code"]) == ("access_denied", "not_owner_or_member"), detail
    assert (detail["required"], detail["branchId"]) == (required, branch_id), detail


def _not_owner(r, branch_id):
    assert r.status_code == 403, (r.request.url, r.text)
    detail = r.json()["detail"]
    assert (detail["code"], detail["branchId"], detail["owner"]) == ("not_draft_owner", branch_id, "alice"), detail


def _ineligible(r, subject_id, reason):
    assert r.status_code == 422, (r.request.url, r.text)
    detail = r.json()["detail"]
    assert (detail["type"], detail["subjectId"], detail["reason"]) == ("ineligible_member", subject_id, reason)


async def _members(c, branch_url, who="alice"):
    r = await c.get(f"{branch_url}/members", headers=_as(who))
    assert r.status_code == 200, r.text
    return r.json()


async def _scenario(body) -> None:
    from httpx import ASGITransport, AsyncClient

    await models.create_schema_and_partitions()
    app, G, V = _app()
    orig_pm, orig_cache, orig_sync_max = G.provider_manager, G.get_graph_cache, V.vconfig.SYNC_PUBLISH_MAX_CHANGES
    G.provider_manager = _StubManager()
    G.get_graph_cache = lambda: _StubCache()
    ds = "ds_" + os.urandom(4).hex()
    V1 = "/api/v1/ws1/versioning"
    try:
        c = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        async with c:
            r = await c.post(f"{V1}/graphs", json={"dataSourceId": ds, "workspaceId": "ws1"}, headers=_as("alice"))
            assert r.status_code == 201, r.text
            gid = r.json()["graphId"]
            r = await c.post(f"{V1}/graphs/{gid}/bulk-ingest", content=_IMPORT_NDJSON, headers=_as("alice"))
            assert r.status_code == 200, r.text

            async def shared_draft(**members):
                r = await c.post(f"{V1}/graphs/{gid}/branches", json={"shared": True}, headers=_as("alice"))
                assert r.status_code in (200, 201), r.text
                d = r.json()["branchId"]
                for subject, role in members.items():
                    kind = "group" if subject.startswith("grp_") else "user"
                    r = await c.post(f"{V1}/graphs/{gid}/branches/{d}/members", headers=_as("alice"),
                                     json={"subjectType": kind, "subjectId": subject, "role": role})
                    assert r.status_code == 200, r.text
                return d

            await body(c, V, ds, gid, shared_draft)
    finally:
        G.provider_manager, G.get_graph_cache = orig_pm, orig_cache
        V.vconfig.SYNC_PUBLISH_MAX_CHANGES = orig_sync_max
        await db.dispose_engine()


def _save(name):
    return {"ops": [{"op": "update", "kind": "node", "id": "urn:t:child", "payload": {"displayName": name}}]}


def _stage(who):
    return {"ops": [{"op": "create", "entityKind": "node", "entityId": f"urn:t:{who}",
                     "payload": {"urn": f"urn:t:{who}", "entityType": "Table", "displayName": who}}]}


def _node(who):
    return {"entityType": "Table", "displayName": f"{who} node", "parentUrn": "urn:t:root"}


async def _write_matrix(c, V, ds, gid, shared_draft) -> None:
    V1, GP = "/api/v1/ws1/versioning", "/api/v1/ws1/graph"
    d = await shared_draft(bob="editor", dave="viewer", grp_eng="editor")
    qd, B = {"dataSourceId": ds, "branchId": d}, f"{V1}/graphs/{gid}/branches/{d}"

    # Carol (a manager, no member) and Dave (a viewer) are refused every write, naming editor.
    for who in ("carol", "dave"):
        h = _as(who)
        _refused(await c.post(f"{GP}/changes", params=qd, json=_save(who), headers=h), "editor", d)
        _refused(await c.post(f"{GP}/nodes/create", params=qd, json=_node(who), headers=h), "editor", d)
        _refused(await c.post(f"{B}/changes", json=_stage(who), headers=h), "editor", d)
        _refused(await c.post(f"{B}/commit", json={}, headers=h), "editor", d)
        _refused(await c.post(f"{B}/rebase", json={}, headers=h), "editor", d)
        _refused(await c.post(f"{B}/merge-requests", json={}, headers=h), "editor", d)
    st = (await c.get(f"{B}/state", headers=_as("alice"))).json()["nodes"]
    assert not {"urn:t:carol", "urn:t:dave"} & set(st), st
    assert not any(n.get("displayName") in ("carol", "dave", "carol node", "dave node") for n in st.values())

    # Bob (a member) and Erin (through grp_eng) write it.
    for who in ("bob", "erin"):
        h = _as(who)
        r = await c.post(f"{GP}/changes", params=qd, json=_save(who), headers=h)
        assert r.status_code == 200, r.text
        r = await c.post(f"{GP}/nodes/create", params=qd, json=_node(who), headers=h)
        assert r.status_code == 200 and r.json()["success"] is True, r.text
        r = await c.post(f"{B}/changes", json=_stage(who), headers=h)
        assert r.status_code == 200, r.text
        r = await c.post(f"{B}/commit", json={}, headers=h)
        assert r.status_code == 200, r.text
        r = await c.post(f"{B}/rebase", json={}, headers=h)
        assert r.status_code == 200, r.text
    r = await c.post(f"{B}/merge-requests", json={}, headers=_as("erin"))
    assert r.status_code == 201, r.text
    r = await c.post(f"{B}/merge-requests", json={}, headers=_as("bob"))   # authorized; one PR per draft
    assert r.status_code == 409 and r.json()["detail"]["type"] == "pull_request_exists", r.text
    st = (await c.get(f"{B}/state", headers=_as("alice"))).json()["nodes"]
    assert {"urn:t:bob", "urn:t:erin"} <= set(st), st

    # Publishing and abandoning need maintainer: Bob is refused, a queued publish before its 202.
    _refused(await c.post(f"{B}/publish", json={"message": "m"}, headers=_as("bob")), "maintainer", d)
    V.vconfig.SYNC_PUBLISH_MAX_CHANGES = 0
    _refused(await c.post(f"{B}/publish", json={"message": "m"}, headers=_as("bob")), "maintainer", d)
    _refused(await c.post(f"{B}/abandon", headers=_as("bob")), "maintainer", d)
    branches = {b["branchId"]: b for b in (await c.get(f"{V1}/graphs/{gid}/branches", headers=_as("alice"))).json()}
    assert branches[d]["status"] == "open", branches[d]

    # Workspace RBAC still gates the write: Bob without manage is refused at the route.
    r = await c.post(f"{GP}/changes", params=qd, json=_save("bob"), headers=_as("bob", manage=False))
    assert r.status_code == 403, r.text

    commits = (await c.get(f"{V1}/graphs/{gid}/commits", params={"branchId": d}, headers=_as("alice"))).json()
    for cm in commits["commits"]:
        assert cm["actor"] not in ("carol", "dave"), cm
        assert not {"carol", "dave"} & set(cm.get("contributors") or []), cm


async def _group_maintainer(c, V, ds, gid, shared_draft) -> None:
    V1, GP = "/api/v1/ws1/versioning", "/api/v1/ws1/graph"
    d = await shared_draft(bob="editor", grp_ops="maintainer")
    B = f"{V1}/graphs/{gid}/branches/{d}"
    r = await c.post(f"{B}/members", json={"subjectType": "user", "subjectId": "dave", "role": "viewer"},
                     headers=_as("frank"))
    assert r.status_code == 200, r.text
    r = await c.patch(B, json={"name": "renamed by frank"}, headers=_as("frank"))
    assert r.status_code == 200, r.text
    _not_owner(await c.patch(B, json={"isShared": False}, headers=_as("frank")), d)   # visibility: owner only
    _refused(await c.delete(f"{B}/members/user/dave", headers=_as("bob")), "maintainer", d)
    r = await c.post(f"{GP}/changes", params={"dataSourceId": ds, "branchId": d}, json=_save("frank"),
                     headers=_as("frank"))
    assert r.status_code == 200, r.text
    r = await c.post(f"{B}/publish", json={"message": "frank ships"}, headers=_as("frank"))
    assert r.status_code == 200, r.text

    # The same publish run as a queued job, for Frank.
    q = await shared_draft(grp_ops="maintainer")
    r = await c.post(f"{GP}/changes", params={"dataSourceId": ds, "branchId": q}, json=_save("queued"),
                     headers=_as("alice"))
    assert r.status_code == 200, r.text
    out = await V._publish_from_job({"graphId": gid, "branchId": q, "actor": "frank", "message": "queued",
                                     "workspaceId": "ws1"})
    assert out.get("commitId") and "error" not in out, out


async def _groups_unavailable(c, V, ds, gid, shared_draft, groups) -> None:
    V1, GP = "/api/v1/ws1/versioning", "/api/v1/ws1/graph"
    d = await shared_draft(bob="editor", grp_eng="editor", grp_ops="maintainer")
    qd = {"dataSourceId": ds, "branchId": d}
    log = {"branchId": d}
    commits = len((await c.get(f"{V1}/graphs/{gid}/commits", params=log, headers=_as("alice"))).json()["commits"])
    groups.down, groups.calls[:] = True, []

    # Whoever's answer turns on a group row is told to retry, not refused.
    for who in ("erin", "carol"):
        r = await c.post(f"{GP}/changes", params=qd, json=_save(who), headers=_as(who))
        assert r.status_code == 503, r.text
        assert r.json()["detail"]["type"] == "groups_unavailable" and r.headers["retry-after"] == "2", r.text
    r = await c.get(f"{V1}/graphs/{gid}/branches/{d}/members", headers=_as("erin", manage=False))
    assert r.status_code == 503 and r.json()["detail"]["type"] == "groups_unavailable", r.text
    assert len((await c.get(f"{V1}/graphs/{gid}/commits", params=log, headers=_as("alice"))).json()["commits"]) == commits
    with pytest.raises(GroupsUnavailable):         # a queued publish fails resumable, not refused
        await V._publish_from_job({"graphId": gid, "branchId": d, "actor": "frank", "message": "m",
                                   "workspaceId": "ws1"})

    # The owner and a direct member never need the lookup.
    groups.calls[:] = []
    for who in ("alice", "bob"):
        r = await c.post(f"{GP}/changes", params=qd, json=_save(who), headers=_as(who))
        assert r.status_code == 200, r.text
    assert groups.calls == [], groups.calls


def _add(c, branch_url, who, subject, role, kind="user"):
    return c.post(f"{branch_url}/members", json={"subjectType": kind, "subjectId": subject, "role": role},
                  headers=_as(who))


async def _unshare_and_reshare(c, V, ds, gid, shared_draft) -> None:
    GP = "/api/v1/ws1/graph"
    d = await shared_draft(bob="editor")
    B, qd = f"/api/v1/ws1/versioning/graphs/{gid}/branches/{d}", {"dataSourceId": ds, "branchId": d}

    # The modal sends isShared with every save: the same value changes nothing.
    r = await c.patch(B, json={"name": "x", "isShared": True}, headers=_as("alice"))
    assert r.status_code == 200, r.text
    assert [m["subjectId"] for m in (await _members(c, B))["members"]] == ["bob"]

    r = await c.patch(B, json={"isShared": False}, headers=_as("alice"))
    assert r.status_code == 200 and r.json()["isShared"] is False, r.text
    assert (await _members(c, B))["members"] == []
    _not_owner(await c.post(f"{GP}/changes", params=qd, json=_save("bob"), headers=_as("bob")), d)

    # Sharing it again starts from no members: Bob is not back.
    r = await c.patch(B, json={"isShared": True}, headers=_as("alice"))
    assert r.status_code == 200 and r.json()["isShared"] is True, r.text
    assert (await _members(c, B))["members"] == []
    _refused(await c.post(f"{GP}/changes", params=qd, json=_save("bob"), headers=_as("bob")), "editor", d)


async def _leftover_rows_grant_nothing(c, V, ds, gid, shared_draft) -> None:
    V1, GP = "/api/v1/ws1/versioning", "/api/v1/ws1/graph"
    r = await c.post(f"{V1}/graphs/{gid}/branches", json={}, headers=_as("alice"))
    assert r.status_code in (200, 201), r.text
    d = r.json()["branchId"]
    B, qd = f"{V1}/graphs/{gid}/branches/{d}", {"dataSourceId": ds, "branchId": d}
    async with db.graphver_session() as s:          # left by an un-share before members were removed
        s.add(models.BranchMemberORM(branch_id=d, subject_type="user", subject_id="bob", role="maintainer"))

    _not_owner(await _add(c, B, "bob", "carol", "editor"), d)
    branches = {b["branchId"]: b for b in (await c.get(f"{V1}/graphs/{gid}/branches", headers=_as("alice"))).json()}
    assert branches[d]["isShared"] is False, branches[d]
    _not_owner(await c.post(f"{GP}/changes", params=qd, json=_save("bob"), headers=_as("bob")), d)

    # Alice shares it by adding Carol: the leftover row goes, it does not come back to life.
    r = await _add(c, B, "alice", "carol", "editor")
    assert r.status_code == 200, r.text
    assert [m["subjectId"] for m in (await _members(c, B))["members"]] == ["carol"]
    _refused(await c.post(f"{GP}/changes", params=qd, json=_save("bob"), headers=_as("bob")), "editor", d)


async def _eligibility(c, V, ds, gid, shared_draft, directory) -> None:
    d = await shared_draft(bob="editor", grp_eng="editor")
    B = f"/api/v1/ws1/versioning/graphs/{gid}/branches/{d}"

    _ineligible(await _add(c, B, "alice", "viola", "editor"), "viola", "no_manage")
    r = await _add(c, B, "alice", "viola", "viewer")            # reading needs only read
    assert r.status_code == 200, r.text
    _ineligible(await _add(c, B, "alice", "alice", "editor"), "alice", "owner")
    _ineligible(await _add(c, B, "alice", "ghost", "viewer"), "ghost", "unknown_user")
    _ineligible(await _add(c, B, "alice", "grp_missing", "viewer", kind="group"), "grp_missing", "unknown_group")
    for bad in ({"role": "admin"}, {"subjectType": "team"}):
        r = await c.post(f"{B}/members", headers=_as("alice"),
                         json={"subjectType": "user", "subjectId": "dave", "role": "viewer", **bad})
        assert r.status_code == 422 and isinstance(r.json()["detail"], list), r.text

    # Authorization comes first: a caller who may not manage members costs no lookup.
    directory.resolved[:] = []
    _refused(await _add(c, B, "carol", "viola", "editor"), "maintainer", d)
    assert directory.resolved == []

    listed = await _members(c, B)
    assert {m["subjectId"]: (m["role"], m["name"]) for m in listed["members"]} == {
        "bob": ("editor", "Bob"), "grp_eng": ("editor", "Eng"), "viola": ("viewer", "Viola")}
    roles = {who: (await _members(c, B, who))["myRole"] for who in ("alice", "bob", "erin", "carol")}
    assert roles == {"alice": "owner", "bob": "editor", "erin": "editor", "carol": None}, roles


async def _membership_takes_the_branch_lock(c, V, ds, gid, shared_draft) -> None:
    d = await shared_draft(bob="editor")
    B = f"/api/v1/ws1/versioning/graphs/{gid}/branches/{d}"
    async with db.graphver_session() as holder:     # another writer of the draft holds its lock
        await holder.execute(select(models.BranchORM.id).where(models.BranchORM.id == d)
                             .with_for_update(key_share=True))
        for send in (lambda: _add(c, B, "alice", "carol", "viewer"),
                     lambda: c.patch(B, json={"isShared": False}, headers=_as("alice"))):
            r = await asyncio.wait_for(send(), 10)
            assert r.status_code == 503 and r.json()["detail"]["type"] == "lock_busy", r.text
        await holder.rollback()

    r = await _add(c, B, "alice", "carol", "viewer")
    assert r.status_code == 200, r.text
    r = await c.patch(B, json={"isShared": False}, headers=_as("alice"))
    assert r.status_code == 200, r.text
    async with db.graphver_session() as s:          # a private draft keeps no members
        assert (await s.get(models.BranchORM, d)).is_shared is False
        assert (await s.execute(select(models.BranchMemberORM).where(
            models.BranchMemberORM.branch_id == d))).scalars().all() == []


_E2E = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")


@_E2E
def test_write_matrix(data_sources, monkeypatch):
    _groups(monkeypatch)
    asyncio.run(_scenario(_write_matrix))


@_E2E
def test_group_maintainer(data_sources, monkeypatch):
    _groups(monkeypatch)
    asyncio.run(_scenario(_group_maintainer))


@_E2E
def test_groups_unavailable(data_sources, monkeypatch):
    groups = _groups(monkeypatch)
    asyncio.run(_scenario(lambda *a: _groups_unavailable(*a, groups)))


@_E2E
def test_unshare_and_reshare(data_sources, monkeypatch):
    _groups(monkeypatch)
    asyncio.run(_scenario(_unshare_and_reshare))


@_E2E
def test_leftover_rows_grant_nothing(data_sources, monkeypatch):
    _groups(monkeypatch)
    asyncio.run(_scenario(_leftover_rows_grant_nothing))


@_E2E
def test_eligibility(data_sources, monkeypatch, directory):
    _groups(monkeypatch)
    asyncio.run(_scenario(lambda *a: _eligibility(*a, directory)))


@_E2E
def test_membership_takes_the_branch_lock(data_sources, monkeypatch):
    _groups(monkeypatch)
    monkeypatch.setattr(config, "GRAPH_LOCK_TIMEOUT_MS", 200, raising=False)
    asyncio.run(_scenario(_membership_takes_the_branch_lock))
