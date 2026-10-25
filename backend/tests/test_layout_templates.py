"""Layout templates: who can use, change and share each one, and its lifecycle.

Pins ``services/template_access.py`` and ``/api/v1/layout-templates``:

* the read rule as Python predicates and as the list's SQL agree, principal by
  principal — and a personal template stays with its owner and the people and
  groups it is shared with, administrators included (a template is a layout,
  not data: there is nothing behind it to audit);
* built-ins are read-only and only template managers hide them; organization
  templates are the managers' to change; workspace templates follow the
  workspace's view permissions; grants are how a team gets its own;
* deleting is a soft delete the deleter can undo — same id, same shares;
* a template keeps a view's structure, never the entities it placed;
* a view records the template it was built from only when its creator can use
  that template, and never shows a view reader someone else's personal one.
"""
from __future__ import annotations

import contextlib
import json

import pytest
from fastapi import HTTPException, status
from sqlalchemy import select

from backend.app.auth.dependencies import (
    get_current_user,
    get_optional_user,
    get_permission_claims,
)
from backend.app.common import activity_context
from backend.app.db.models import (
    ContextModelORM,
    GroupMemberORM,
    NotificationORM,
    OutboxEventORM,
    ResourceGrantORM,
    UserORM,
    ViewORM,
    WorkspaceORM,
)
from backend.app.db.repositories import grant_repo, group_repo
from backend.app.services import template_access
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.template_access import TemplateViewer
from backend.auth_service.interface import User

URL = "/api/v1/layout-templates"
WS, WS_OTHER = "ws_tpl", "ws_tpl_other"
MANAGE = "system:templates:manage"

_MEMBER = (
    "workspace:view:create", "workspace:view:edit",
    "workspace:view:delete", "workspace:view:read",
)
_ADMIN = ("workspace:admin", "workspace:view:*", "workspace:datasource:*")


def _claims(*global_perms, ws=None) -> PermissionClaims:
    return PermissionClaims(sid="sess_tpl", global_perms=tuple(global_perms), ws_perms=ws or {})


#: name → (user id, claims). The same people in every test below.
PEOPLE = {
    "alice": ("usr_alice", _claims(ws={WS: _MEMBER})),       # owns most templates
    "carol": ("usr_carol", _claims()),                       # in the group shared with
    "dave": ("usr_dave", _claims(ws={WS: _MEMBER})),         # a member of WS
    "wsadmin": ("usr_wsadmin", _claims(ws={WS: _ADMIN})),
    "outsider": ("usr_outsider", _claims()),
    "org_viewer": ("usr_orgviewer", _claims("system:org-viewer")),
    "org_admin": ("usr_orgadmin", _claims("system:org-admin")),
    "sysadmin": ("usr_sysadmin", _claims("system:admin")),
    "manager": ("usr_manager", _claims(MANAGE)),
}


def _user(name: str) -> User:
    user_id, _ = PEOPLE[name]
    return User(
        id=user_id, email=f"{name}@example.com", first_name=name.title(), last_name="T",
        role="user", status="active",
        created_at="2024-01-01T00:00:00Z", updated_at="2024-01-01T00:00:00Z",
    )


@contextlib.contextmanager
def _as(name: str):
    """Make the test client's requests ``name``'s."""
    from backend.app.main import app

    user, claims = _user(name), PEOPLE[name][1]

    async def _current():
        activity_context.bind_actor(user.id)
        return user

    prev = {dep: app.dependency_overrides.get(dep)
            for dep in (get_current_user, get_optional_user, get_permission_claims)}
    app.dependency_overrides[get_current_user] = _current
    app.dependency_overrides[get_optional_user] = _current
    app.dependency_overrides[get_permission_claims] = lambda: claims
    try:
        yield
    finally:
        for dep, fn in prev.items():
            app.dependency_overrides[dep] = fn


async def _viewer(session, name: str) -> TemplateViewer:
    user_id, claims = PEOPLE[name]
    return await TemplateViewer.build(session, user=type("U", (), {"id": user_id})(), claims=claims)


def _layers(*names: str) -> list[dict]:
    return [
        {"id": f"layer-{i}", "name": n, "color": "#3b82f6", "entityTypes": ["Table"], "order": i}
        for i, n in enumerate(names)
    ]


async def _people_and_workspaces(session) -> str:
    """Users, the two workspaces, and the group Carol is in. Returns its id."""
    session.add_all([WorkspaceORM(id=WS, name="Finance"), WorkspaceORM(id=WS_OTHER, name="Ops")])
    session.add_all([
        UserORM(id=user_id, email=f"{name}@example.com", password_hash="x", status="active",
                first_name=name.title(), last_name="T",
                created_at="2024-01-01T00:00:00Z", updated_at="2024-01-01T00:00:00Z")
        for name, (user_id, _) in PEOPLE.items()
    ])
    group = await group_repo.create_group(session, name="Platform team")
    session.add(GroupMemberORM(group_id=group.id, user_id="usr_carol"))
    await session.flush()
    return group.id


@pytest.fixture
async def library(db_session):
    """One template of every kind, plus a deleted one and a non-template row."""
    group_id = await _people_and_workspaces(db_session)

    def tpl(tid, visibility, created_by=None, **kw):
        return ContextModelORM(
            id=tid, name=tid, is_template=True, visibility=visibility,
            created_by=created_by, layers_config=json.dumps(_layers("Source")), **kw,
        )

    db_session.add_all([
        tpl("t_builtin", "enterprise", system_key="k-shown"),
        tpl("t_builtin_hidden", "enterprise", system_key="k-hidden", is_active=False),
        tpl("t_org", "enterprise", "usr_manager"),
        tpl("t_ws", "workspace", "usr_alice", workspace_id=WS),
        tpl("t_ws_other", "workspace", "usr_erin", workspace_id=WS_OTHER),
        tpl("t_alice", "private", "usr_alice"),
        tpl("t_shared", "private", "usr_alice"),
        # Alice asked for this one to be offered to everyone: managers may read it.
        tpl("t_requested", "private", "usr_alice",
            promotion_requested_by="usr_alice", promotion_requested_at="2026-10-01T00:00:00Z"),
        tpl("t_deleted", "private", "usr_alice", deleted_at="2026-10-01T00:00:00Z"),
        ContextModelORM(id="cm_not_a_template", name="old instance", is_template=False,
                        visibility="enterprise"),
    ])
    await grant_repo.create_grant(
        db_session, resource_type="layout_template", resource_id="t_shared",
        subject_type="group", subject_id=group_id, role_name="viewer",
    )
    await db_session.flush()
    return group_id


# ── The read rule: predicates and SQL, principal by principal ────────

_EVERYONE = {"t_builtin", "t_org"}
_READS = {
    "alice": _EVERYONE | {"t_ws", "t_alice", "t_shared", "t_requested"},
    "carol": _EVERYONE | {"t_shared"},
    "dave": _EVERYONE | {"t_ws"},
    "wsadmin": _EVERYONE | {"t_ws"},
    "outsider": _EVERYONE,
    "org_viewer": _EVERYONE | {"t_ws", "t_ws_other"},
    "org_admin": _EVERYONE | {"t_ws", "t_ws_other"},
    # Managers (system:admin implies it) also see hidden built-ins — and
    # nobody's personal templates, except one its owner asked them to review.
    "sysadmin": _EVERYONE | {"t_builtin_hidden", "t_ws", "t_ws_other", "t_requested"},
    "manager": _EVERYONE | {"t_builtin_hidden", "t_requested"},
}


@pytest.mark.parametrize("name", sorted(_READS))
async def test_the_read_rule_is_the_same_in_python_and_in_sql(db_session, library, name):
    ctx = await _viewer(db_session, name)
    rows = (await db_session.execute(select(ContextModelORM))).scalars().all()
    by_predicate = {r.id for r in rows if template_access.can_read(ctx, r)}
    by_sql = set((await db_session.execute(
        select(ContextModelORM.id).where(template_access.readable_templates_clause(ctx))
    )).scalars())
    assert by_predicate == _READS[name]
    assert by_sql == _READS[name]


# (principal, template) → (edit, delete, share, hide)
_ACTIONS = {
    ("alice", "t_ws"): (True, True, True, False),        # owner
    ("dave", "t_ws"): (True, True, False, False),        # workspace member: no sharing
    ("wsadmin", "t_ws"): (True, True, True, False),      # workspace admin shares
    ("carol", "t_shared"): (False, False, False, False),  # a viewer grant only uses it
    ("alice", "t_alice"): (True, True, True, False),
    ("manager", "t_org"): (True, True, False, False),    # everyone's already: nothing to share
    ("outsider", "t_org"): (False, False, False, False),
    ("manager", "t_builtin"): (False, False, False, True),  # read-only; hide only
    ("sysadmin", "t_builtin"): (False, False, False, True),
    ("alice", "t_builtin"): (False, False, False, False),
}


@pytest.mark.parametrize("key", sorted(_ACTIONS))
async def test_what_each_person_may_do_with_a_template(db_session, library, key):
    name, tid = key
    ctx = await _viewer(db_session, name)
    t = await db_session.get(ContextModelORM, tid)
    got = (
        template_access.can_edit(ctx, t), template_access.can_delete(ctx, t),
        template_access.can_share(ctx, t), template_access.can_hide(ctx, t),
    )
    assert got == _ACTIONS[key]


async def test_an_editor_grant_lets_a_teammate_edit_but_not_share(db_session, library):
    await grant_repo.create_grant(
        db_session, resource_type="layout_template", resource_id="t_alice",
        subject_type="user", subject_id="usr_dave", role_name="editor",
    )
    ctx = await _viewer(db_session, "dave")
    t = await db_session.get(ContextModelORM, "t_alice")
    assert template_access.can_edit(ctx, t)
    assert not template_access.can_delete(ctx, t)
    assert not template_access.can_share(ctx, t)
    assert template_access.move_refusal(ctx, t, "workspace", WS)


# ── The API: create, read, list ──────────────────────────────────────

async def test_a_personal_template_is_its_owners_alone(test_client, db_session, library):
    with _as("alice"):
        created = await test_client.post(URL, json={"name": "  My flow ", "layers": _layers("A", "B")})
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["name"] == "My flow" and body["visibility"] == "private"
    assert body["access"] == {
        "via": "owner", "canEdit": True, "canDelete": True, "canShare": True, "canHide": False,
        "canFeature": False, "canRequestPromotion": True, "canDecidePromotion": False,
    }
    assert body["grantCount"] == 0

    for stranger in ("dave", "sysadmin", "manager"):
        with _as(stranger):
            assert (await test_client.get(f"{URL}/{body['id']}")).status_code == 404
            listed = (await test_client.get(URL)).json()
        assert body["id"] not in {t["id"] for t in listed["items"]}


async def test_the_list_holds_what_the_caller_can_use_and_says_how(test_client, db_session, library):
    with _as("carol"):
        resp = await test_client.get(URL)
    assert resp.status_code == 200, resp.text
    items = {t["id"]: t for t in resp.json()["items"]}
    assert set(items) == _READS["carol"]
    assert resp.json()["total"] == len(items)
    assert items["t_shared"]["access"]["via"] == "grant"
    assert items["t_builtin"]["builtIn"] is True and items["t_builtin"]["access"]["via"] == "builtin"
    assert items["t_org"]["access"]["via"] == "organization"
    # Shares are counted only for those who may change them.
    assert items["t_shared"]["grantCount"] is None


async def test_an_organization_template_needs_a_manager(test_client, db_session, library):
    payload = {"name": "House style", "visibility": "enterprise", "layers": _layers("A")}
    with _as("alice"):
        refused = await test_client.post(URL, json=payload)
    assert refused.status_code == 403
    assert "Manage templates" in refused.json()["detail"]

    with _as("manager"):
        created = await test_client.post(URL, json=payload)
    assert created.status_code == 201, created.text
    tid = created.json()["id"]

    with _as("outsider"):
        assert (await test_client.get(f"{URL}/{tid}")).status_code == 200
        assert (await test_client.put(f"{URL}/{tid}", json={"name": "Mine now"})).status_code == 403


async def test_a_workspace_template_follows_the_workspace(test_client, db_session, library):
    with _as("alice"):
        missing = await test_client.post(URL, json={
            "name": "Team", "visibility": "workspace", "layers": _layers("A"),
        })
        stray = await test_client.post(URL, json={
            "name": "Team", "visibility": "private", "workspaceId": WS, "layers": _layers("A"),
        })
        elsewhere = await test_client.post(URL, json={
            "name": "Team", "visibility": "workspace", "workspaceId": WS_OTHER, "layers": _layers("A"),
        })
        created = await test_client.post(URL, json={
            "name": "Team", "visibility": "workspace", "workspaceId": WS, "layers": _layers("A"),
        })
    assert missing.status_code == 422 and stray.status_code == 422
    assert elsewhere.status_code == 403
    assert created.status_code == 201, created.text
    assert created.json()["workspaceName"] == "Finance"

    with _as("dave"):
        assert (await test_client.get(f"{URL}/{created.json()['id']}")).status_code == 200
    with _as("outsider"):
        assert (await test_client.get(f"{URL}/{created.json()['id']}")).status_code == 404
    with _as("sysadmin"):
        ghost = await test_client.post(URL, json={
            "name": "Team", "visibility": "workspace", "workspaceId": "ws_nope", "layers": _layers("A"),
        })
    assert ghost.status_code == 404


async def test_layers_must_be_named_unique_and_few(test_client, db_session, library):
    twins = _layers("A", "B")
    twins[1]["id"] = twins[0]["id"]
    with _as("alice"):
        for bad in (
            {"name": "x", "layers": twins},
            {"name": "x", "layers": _layers(*["L"] * 31)},
            {"name": "x", "layers": []},
            {"name": "   ", "layers": _layers("A")},
            {"name": "x", "layers": [{"id": "a", "name": ""}]},
        ):
            assert (await test_client.post(URL, json=bad)).status_code == 422, bad


async def test_a_template_keeps_structure_never_placements(test_client, db_session, library):
    layer = {
        "id": "domains", "name": "Domains", "entityTypes": ["Domain"], "order": 0,
        "anchorUrn": "urn:li:domain:finance",
        # Saved from a view built from another template: that is the view's history.
        "templateLayerId": "medallion-bronze",
        "entityAssignments": [{"entityId": "urn:li:dataset:1", "layerId": "domains"}],
        "rules": [
            {"id": "r-exact", "urnPattern": "urn:li:dataset:1", "priority": 1},
            {"id": "r-shape", "urnPattern": "urn:li:dataset:*", "priority": 1},
        ],
        "logicalNodes": [{
            "id": "ln", "name": "Group", "type": "group",
            "rules": [{"id": "ln-exact", "urnPattern": "urn:li:dataset:2", "priority": 1}],
            "children": [{
                "id": "ln-child", "name": "Child", "type": "group",
                "rules": [{"id": "child-exact", "urnPattern": "urn:li:dataset:3", "priority": 1}],
            }],
        }],
    }
    with _as("alice"):
        resp = await test_client.post(URL, json={"name": "Shape", "layers": [layer]})
    assert resp.status_code == 201, resp.text
    kept = resp.json()["layers"][0]
    assert "anchorUrn" not in kept and "entityAssignments" not in kept
    assert "templateLayerId" not in kept
    assert [r["id"] for r in kept["rules"]] == ["r-shape"]
    assert kept["logicalNodes"][0]["rules"] == []
    assert kept["logicalNodes"][0]["children"][0]["rules"] == []
    assert kept["entityTypes"] == ["Domain"] and kept["logicalNodes"][0]["type"] == "group"


# ── Edit, move, built-ins ────────────────────────────────────────────

async def test_editing_is_partial_and_audiences_move_only_for_those_who_may(
    test_client, db_session, library,
):
    with _as("alice"):
        renamed = await test_client.put(f"{URL}/t_alice", json={"description": "Why", "category": "flow"})
        assert renamed.status_code == 200, renamed.text
        assert (renamed.json()["name"], renamed.json()["description"]) == ("t_alice", "Why")
        moved = await test_client.put(f"{URL}/t_alice", json={"visibility": "workspace", "workspaceId": WS})
        assert moved.status_code == 200, moved.text
        promoted = await test_client.put(f"{URL}/t_alice", json={"visibility": "enterprise"})
    assert promoted.status_code == 403
    with _as("dave"):  # the workspace's member now sees it, and may edit — not move
        assert (await test_client.put(f"{URL}/t_alice", json={"name": "Better"})).status_code == 200
        assert (await test_client.put(f"{URL}/t_alice", json={"visibility": "private"})).status_code == 403
    with _as("alice"):
        back = await test_client.put(f"{URL}/t_alice", json={"visibility": "private"})
    assert back.status_code == 200 and back.json()["workspaceId"] is None


async def test_builtins_are_read_only_and_managers_hide_them(test_client, db_session, library):
    with _as("sysadmin"):
        edit = await test_client.put(f"{URL}/t_builtin", json={"name": "Ours"})
        delete = await test_client.delete(f"{URL}/t_builtin")
    assert edit.status_code == 403 and "Duplicate" in edit.json()["detail"]
    assert delete.status_code == 403

    with _as("alice"):
        assert (await test_client.put(f"{URL}/t_builtin/hidden", json={"hidden": True})).status_code == 403
    with _as("manager"):
        hidden = await test_client.put(f"{URL}/t_builtin/hidden", json={"hidden": True})
        assert hidden.status_code == 200 and hidden.json()["hidden"] is True
        default_list = {t["id"] for t in (await test_client.get(URL)).json()["items"]}
        full_list = {t["id"] for t in (await test_client.get(URL, params={"includeHidden": True})).json()["items"]}
        assert (await test_client.put(f"{URL}/t_org/hidden", json={"hidden": True})).status_code == 403
    assert "t_builtin" not in default_list and {"t_builtin", "t_builtin_hidden"} <= full_list
    with _as("alice"):
        assert (await test_client.get(f"{URL}/t_builtin")).status_code == 404
        assert "t_builtin" not in {t["id"] for t in (await test_client.get(URL)).json()["items"]}
    with _as("manager"):
        assert (await test_client.put(f"{URL}/t_builtin/hidden", json={"hidden": False})).status_code == 200
    with _as("alice"):
        assert (await test_client.get(f"{URL}/t_builtin")).status_code == 200


# ── Delete and undo ──────────────────────────────────────────────────

async def test_delete_is_undone_with_the_same_id_and_shares(test_client, db_session, library):
    with _as("carol"):
        assert (await test_client.delete(f"{URL}/t_shared")).status_code == 403
    with _as("alice"):
        assert (await test_client.delete(f"{URL}/t_shared")).status_code == 204
        assert (await test_client.get(f"{URL}/t_shared")).status_code == 404
    with _as("carol"):
        assert (await test_client.get(f"{URL}/t_shared")).status_code == 404
        assert (await test_client.post(f"{URL}/t_shared/restore")).status_code == 404
    with _as("alice"):
        restored = await test_client.post(f"{URL}/t_shared/restore")
    assert restored.status_code == 200 and restored.json()["id"] == "t_shared"
    with _as("carol"):  # the group's share came back with it
        assert (await test_client.get(f"{URL}/t_shared")).status_code == 200


# ── Shares ───────────────────────────────────────────────────────────

async def test_sharing_with_a_group_reaches_its_members(test_client, db_session, library):
    group_id = library
    with _as("dave"):  # may use t_ws, may not share it
        assert (await test_client.get(f"{URL}/t_ws/grants")).status_code == 403
    with _as("alice"):
        shared = await test_client.post(f"{URL}/t_alice/grants", json={
            "subjectType": "group", "subjectId": group_id, "role": "viewer",
        })
        again = await test_client.post(f"{URL}/t_alice/grants", json={
            "subjectType": "group", "subjectId": group_id, "role": "viewer",
        })
    assert shared.status_code == 201, shared.text
    assert shared.json()["subject"]["displayName"] == "Platform team"
    assert again.status_code == 409
    note = (await db_session.execute(
        select(NotificationORM).where(NotificationORM.kind == "layout_template.shared")
    )).scalars().all()
    assert [(n.user_id, n.link) for n in note] == [("usr_carol", "/templates/t_alice")]

    with _as("carol"):
        assert (await test_client.get(f"{URL}/t_alice")).json()["access"]["via"] == "grant"
        assert (await test_client.put(f"{URL}/t_alice", json={"name": "x"})).status_code == 403

    grant_id = shared.json()["grantId"]
    with _as("alice"):
        promoted = await test_client.put(f"{URL}/t_alice/grants/{grant_id}", json={"role": "editor"})
        assert promoted.status_code == 200 and promoted.json()["role"] == "editor"
        assert (await test_client.get(f"{URL}/t_alice")).json()["grantCount"] == 1
    with _as("carol"):
        assert (await test_client.put(f"{URL}/t_alice", json={"name": "Team flow"})).status_code == 200
    with _as("alice"):
        assert (await test_client.delete(f"{URL}/t_shared/grants/{grant_id}")).status_code == 404
        assert (await test_client.delete(f"{URL}/t_alice/grants/{grant_id}")).status_code == 204
    with _as("carol"):
        assert (await test_client.get(f"{URL}/t_alice")).status_code == 404


async def test_a_template_is_never_shared_with_a_service_account(test_client, db_session, library):
    db_session.add(UserORM(
        id="svc_0123456789ab", email="svc_0123456789ab@service-account.invalid", password_hash="x",
        status="active", first_name="Metadata sync", last_name="",
        created_at="2024-01-01T00:00:00Z", updated_at="2024-01-01T00:00:00Z",
    ))
    await db_session.flush()
    with _as("alice"):
        shared = await test_client.post(f"{URL}/t_alice/grants", json={
            "subjectType": "user", "subjectId": "svc_0123456789ab", "role": "viewer",
        })
    assert shared.status_code == 409, shared.text


async def test_every_change_is_recorded_as_the_person_who_made_it(test_client, db_session, library):
    with _as("alice"):
        tid = (await test_client.post(URL, json={"name": "Audit me", "layers": _layers("A")})).json()["id"]
        await test_client.put(f"{URL}/{tid}", json={"name": "Audited"})
        await test_client.delete(f"{URL}/{tid}")
        await test_client.post(f"{URL}/{tid}/restore")
    rows = (await db_session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type.like("visualization.layout_template.%"))
    )).scalars().all()
    events = [(r.event_type.rsplit(".", 1)[1], json.loads(r.payload)) for r in rows]
    assert [e for e, _ in events] == ["created", "updated", "deleted", "restored"]
    for _, payload in events:
        assert payload["actor_id"] == "usr_alice"
        assert (payload["target_type"], payload["target_id"]) == ("layout_template", tid)


# ── Views built from a template ──────────────────────────────────────

async def test_usage_counts_only_live_views_the_caller_can_open(test_client, db_session, library):
    db_session.add_all([
        ViewORM(id="v_open", name="open", workspace_id=WS, visibility="enterprise",
                created_by="usr_alice", context_model_id="t_org"),
        ViewORM(id="v_private", name="private", workspace_id=WS, visibility="private",
                created_by="usr_alice", context_model_id="t_org"),
        ViewORM(id="v_gone", name="gone", workspace_id=WS, visibility="enterprise",
                created_by="usr_alice", context_model_id="t_org", deleted_at="2026-10-01T00:00:00Z"),
    ])
    await db_session.flush()
    with _as("alice"):
        assert (await test_client.get(f"{URL}/t_org")).json()["usageCount"] == 2
    with _as("outsider"):
        assert (await test_client.get(f"{URL}/t_org")).json()["usageCount"] == 1


async def test_a_view_records_only_a_template_its_creator_can_use(test_client, db_session, library):
    async def create(name: str, template_id: str):
        with _as(name):
            resp = await test_client.post("/api/v1/views/", json={
                "name": f"from {template_id}", "workspaceId": WS, "viewType": "graph",
                "visibility": "workspace", "contextModelId": template_id,
            })
        assert resp.status_code == 201, resp.text
        return resp.json()

    assert (await create("dave", "t_ws"))["contextModelId"] == "t_ws"
    assert (await create("dave", "t_alice"))["contextModelId"] is None   # someone's personal
    assert (await create("dave", "cm_missing"))["contextModelId"] is None

    view = await create("alice", "t_alice")
    assert (view["contextModelId"], view["contextModelName"]) == ("t_alice", "t_alice")
    with _as("dave"):  # reads the view, but the personal template's name is not his to see
        seen = (await test_client.get(f"/api/v1/views/{view['id']}")).json()
    assert seen["contextModelName"] is None


async def test_the_retired_template_routes_are_gone(test_client, db_session, library):
    for path in (f"/api/v1/{WS}/context-models/templates", "/api/v1/admin/context-model-templates"):
        assert (await test_client.get(path)).status_code == 404, path
    # Grants on templates are their own resource type: never a view's.
    grants = (await db_session.execute(select(ResourceGrantORM.resource_type))).scalars().all()
    assert set(grants) == {"layout_template"}


async def test_analytics_counts_the_templates_people_made(db_session, library):
    """Built-ins ship with the product and a deleted template is kept only for
    Undo: neither is adoption."""
    from backend.app.db.repositories import analytics_repo

    summary = await analytics_repo.platform_summary(db_session, days=30)
    assert summary["totals"]["layoutTemplates"]["total"] == 6
    detail = await analytics_repo.workspace_detail(db_session, WS, days=30)
    assert detail["totals"]["layoutTemplates"]["total"] == 1
