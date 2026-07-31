"""Unit matrix for the reworked view-access evaluator.

Locked semantics (view-sharing rework, 2026-07-31):

  ``private``    → creator + explicit grants + workspace admins
                   (NOT plain workspace members — that was the leak)
  ``workspace``  → the above + holders of ``workspace:view:read`` in
                   the view's workspace
  ``enterprise`` → any authenticated user
  anonymous      → nothing, ever
  unknown tier   → falls closed for everyone but system:admin

Publishing (any transition to/from ``enterprise``) requires the
dedicated ``workspace:view:publish`` permission; grant management stays
creator ∨ workspace:admin ∨ system:admin.

Claims below are built the way the resolver actually emits them:
workspace admins carry the auto-implied leaf set collapsed to
wildcards; members carry four explicit view leaves (publish missing →
no collapse).
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

from backend.app.db.models import GroupMemberORM, ViewORM, WorkspaceORM
from backend.app.db.repositories import grant_repo, group_repo
from backend.app.services import view_access
from backend.app.services.permission_service import PermissionClaims


WS = "ws_matrix"
CREATOR = "usr_creator"


# ── seed helpers ─────────────────────────────────────────────────────

async def _seed_view(session, *, view_id, visibility, workspace_id=WS,
                     created_by=CREATOR) -> ViewORM:
    if (await session.get(WorkspaceORM, workspace_id)) is None:
        session.add(WorkspaceORM(id=workspace_id, name=workspace_id))
    session.add(ViewORM(
        id=view_id,
        name=view_id,
        workspace_id=workspace_id,
        visibility=visibility,
        created_by=created_by,
    ))
    await session.commit()
    return (await session.execute(
        select(ViewORM).where(ViewORM.id == view_id)
    )).scalar_one()


def _claims(*, global_perms=(), ws_perms=None) -> PermissionClaims:
    return PermissionClaims(
        sid="sess_matrix",
        global_perms=tuple(global_perms),
        ws_perms=ws_perms or {},
    )


# Realistic post-resolver claim shapes per principal.
_MEMBER_LEAVES = (
    "workspace:view:create", "workspace:view:edit",
    "workspace:view:delete", "workspace:view:read",
)
_ADMIN_LEAVES = ("workspace:admin", "workspace:view:*", "workspace:datasource:*")


async def _ctx(session, *, user_id, claims) -> view_access.ViewerContext:
    user = type("U", (), {"id": user_id})()
    return await view_access.ViewerContext.build(
        session, user=user, claims=claims,
    )


async def _anon_ctx(session) -> view_access.ViewerContext:
    return await view_access.ViewerContext.build(
        session, user=None, claims=_claims(),
    )


def _principal_builders():
    """(name, needs_grant, ctx factory). Kept as data so the matrix
    below reads as the spec."""
    return {
        "creator": lambda s: _ctx(s, user_id=CREATOR, claims=_claims()),
        "member": lambda s: _ctx(
            s, user_id="usr_member",
            claims=_claims(ws_perms={WS: _MEMBER_LEAVES}),
        ),
        "ws_admin": lambda s: _ctx(
            s, user_id="usr_wsadmin",
            claims=_claims(ws_perms={WS: _ADMIN_LEAVES}),
        ),
        "org_viewer": lambda s: _ctx(
            s, user_id="usr_orgviewer",
            claims=_claims(global_perms=("system:org-viewer",)),
        ),
        "org_admin": lambda s: _ctx(
            s, user_id="usr_orgadmin",
            claims=_claims(global_perms=("system:org-admin",)),
        ),
        "system_admin": lambda s: _ctx(
            s, user_id="usr_sysadmin",
            claims=_claims(global_perms=("system:admin",)),
        ),
        "outsider": lambda s: _ctx(s, user_id="usr_outsider", claims=_claims()),
    }


# ── can_read_view matrix ─────────────────────────────────────────────

# (tier, principal) -> expected read
_READ_MATRIX = {
    ("private", "creator"): True,
    ("private", "member"): False,          # the original leak, inverted
    ("private", "ws_admin"): True,
    ("private", "org_viewer"): False,      # read-everything must NOT reach private
    ("private", "org_admin"): True,
    ("private", "system_admin"): True,
    ("private", "outsider"): False,
    ("workspace", "creator"): True,
    ("workspace", "member"): True,
    ("workspace", "ws_admin"): True,
    ("workspace", "org_viewer"): True,
    ("workspace", "org_admin"): True,
    ("workspace", "system_admin"): True,
    ("workspace", "outsider"): False,
    ("enterprise", "creator"): True,
    ("enterprise", "member"): True,
    ("enterprise", "ws_admin"): True,
    ("enterprise", "org_viewer"): True,
    ("enterprise", "org_admin"): True,
    ("enterprise", "system_admin"): True,
    ("enterprise", "outsider"): True,      # any signed-in user
}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "tier,principal",
    sorted(_READ_MATRIX),
    ids=[f"{t}-{p}" for t, p in sorted(_READ_MATRIX)],
)
async def test_read_matrix(db_session, tier, principal):
    view = await _seed_view(
        db_session, view_id=f"view_{tier}_{principal}", visibility=tier,
    )
    ctx = await _principal_builders()[principal](db_session)
    expected = _READ_MATRIX[(tier, principal)]
    got = await view_access.can_read_view(db_session, ctx, view)
    assert got is expected, (
        f"{principal} reading a {tier} view: expected {expected}, got {got}"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("tier", ["private", "workspace", "enterprise"])
async def test_anonymous_reads_nothing(db_session, tier):
    view = await _seed_view(
        db_session, view_id=f"view_anon_{tier}", visibility=tier,
    )
    ctx = await _anon_ctx(db_session)
    assert not await view_access.can_read_view(db_session, ctx, view)


@pytest.mark.asyncio
@pytest.mark.parametrize("tier", ["private", "workspace"])
async def test_user_grant_extends_read_across_workspace(db_session, tier):
    view = await _seed_view(
        db_session, view_id=f"view_grant_{tier}", visibility=tier,
    )
    await grant_repo.create_grant(
        db_session, resource_type="view", resource_id=view.id,
        subject_type="user", subject_id="usr_grantee", role_name="viewer",
    )
    await db_session.commit()
    ctx = await _ctx(db_session, user_id="usr_grantee", claims=_claims())
    assert await view_access.can_read_view(db_session, ctx, view)


@pytest.mark.asyncio
async def test_group_grant_extends_read(db_session):
    view = await _seed_view(
        db_session, view_id="view_group_grant", visibility="private",
    )
    group = await group_repo.create_group(db_session, name="analysts")
    db_session.add(GroupMemberORM(group_id=group.id, user_id="usr_in_group"))
    await grant_repo.create_grant(
        db_session, resource_type="view", resource_id=view.id,
        subject_type="group", subject_id=group.id, role_name="viewer",
    )
    await db_session.commit()
    ctx = await _ctx(db_session, user_id="usr_in_group", claims=_claims())
    assert await view_access.can_read_view(db_session, ctx, view)


@pytest.mark.asyncio
async def test_unknown_tier_falls_closed_even_with_grant(db_session):
    """``ck_views_visibility`` makes an unknown tier unrepresentable in
    the database, so exercise the evaluator's fall-closed branch on a
    transient (never persisted) ORM object. Grants are keyed by bare
    resource_id, so the grant row exists without the view row."""
    await grant_repo.create_grant(
        db_session, resource_type="view", resource_id="view_unknown_t",
        subject_type="user", subject_id="usr_grantee2", role_name="editor",
    )
    await db_session.commit()
    phantom = ViewORM(
        id="view_unknown_t", name="view_unknown_t", workspace_id=WS,
        visibility="mystery", created_by="usr_other",
    )
    ctx = await _ctx(db_session, user_id="usr_grantee2", claims=_claims())
    assert not await view_access.can_read_view(db_session, ctx, phantom)


# ── grant-index memoization ──────────────────────────────────────────

@pytest.mark.asyncio
async def test_grant_lookup_is_memoized_per_context(db_session, monkeypatch):
    """N views checked against one ViewerContext must cost exactly one
    grants query — the per-view lookup was an N+1 on every list path."""
    views = [
        await _seed_view(
            db_session, view_id=f"view_memo_{i}", visibility="private",
        )
        for i in range(3)
    ]
    calls = {"n": 0}
    real = grant_repo.list_grants_for_user_with_groups

    async def counting(*args, **kwargs):
        calls["n"] += 1
        return await real(*args, **kwargs)

    monkeypatch.setattr(
        grant_repo, "list_grants_for_user_with_groups", counting,
    )
    ctx = await _ctx(db_session, user_id="usr_counted", claims=_claims())
    for view in views:
        await view_access.can_read_view(db_session, ctx, view)
    assert calls["n"] == 1, f"expected 1 grants query, saw {calls['n']}"


# ── publish + grant-management predicates ────────────────────────────

@pytest.mark.asyncio
async def test_publish_matrix(db_session):
    view = await _seed_view(
        db_session, view_id="view_publish", visibility="workspace",
    )
    build = _principal_builders()

    creator = await build["creator"](db_session)
    member = await build["member"](db_session)
    ws_admin = await build["ws_admin"](db_session)
    org_viewer = await build["org_viewer"](db_session)
    org_admin = await build["org_admin"](db_session)
    system_admin = await build["system_admin"](db_session)

    # Creator without the permission may NOT publish.
    assert not view_access.can_publish(creator, view)
    # Member tier never publishes (explicit leaves, no wildcard).
    assert not view_access.can_publish(member, view)
    # Admin claims carry the collapsed workspace:view:* → publish OK.
    assert view_access.can_publish(ws_admin, view)
    assert not view_access.can_publish(org_viewer, view)
    assert view_access.can_publish(org_admin, view)
    assert view_access.can_publish(system_admin, view)


def test_publish_in_workspace_mirrors_view_predicate():
    admin_claims = _claims(ws_perms={WS: _ADMIN_LEAVES})
    member_claims = _claims(ws_perms={WS: _MEMBER_LEAVES})
    assert view_access.can_publish_in_workspace(admin_claims, WS)
    assert not view_access.can_publish_in_workspace(member_claims, WS)


@pytest.mark.asyncio
async def test_legacy_wildcard_sessions_satisfy_publish(db_session):
    """Documents the accepted staleness window: a pre-deploy session
    whose claims still hold the collapsed ``workspace:view:*`` passes a
    publish check until its next refresh."""
    view = await _seed_view(
        db_session, view_id="view_stale", visibility="workspace",
    )
    stale = await _ctx(
        db_session, user_id="usr_stale",
        claims=_claims(ws_perms={WS: ("workspace:view:*",)}),
    )
    assert view_access.can_publish(stale, view)


@pytest.mark.asyncio
async def test_manage_grants_matrix(db_session):
    view = await _seed_view(
        db_session, view_id="view_manage", visibility="workspace",
    )
    build = _principal_builders()
    assert view_access.can_manage_grants(
        await build["creator"](db_session), view)
    assert view_access.can_manage_grants(
        await build["ws_admin"](db_session), view)
    assert view_access.can_manage_grants(
        await build["system_admin"](db_session), view)
    assert not view_access.can_manage_grants(
        await build["member"](db_session), view)
    assert not view_access.can_manage_grants(
        await build["outsider"](db_session), view)

    # An editor grant lets you edit, not manage sharing.
    await grant_repo.create_grant(
        db_session, resource_type="view", resource_id=view.id,
        subject_type="user", subject_id="usr_editor_grantee",
        role_name="editor",
    )
    await db_session.commit()
    editor = await _ctx(
        db_session, user_id="usr_editor_grantee", claims=_claims())
    assert await view_access.can_edit_view(db_session, editor, view)
    assert not view_access.can_manage_grants(editor, view)


# ── read scope → SQL clause ──────────────────────────────────────────

async def _readable_ids(session, scope) -> set[str]:
    rows = await session.execute(
        select(ViewORM.id).where(view_access.readable_views_clause(scope))
    )
    return {r[0] for r in rows}


@pytest.mark.asyncio
async def test_readable_clause_matches_evaluator(db_session):
    """The SQL clause and the per-view evaluator must agree — they are
    two renderings of one rule."""
    tiers = ("private", "workspace", "enterprise")
    for tier in tiers:
        await _seed_view(
            db_session, view_id=f"view_sql_{tier}", visibility=tier,
        )
    # A view in a workspace the member is NOT part of:
    await _seed_view(
        db_session, view_id="view_sql_foreign", visibility="workspace",
        workspace_id="ws_other",
    )
    # A view granted explicitly:
    granted = await _seed_view(
        db_session, view_id="view_sql_granted", visibility="private",
        workspace_id="ws_other",
    )
    await grant_repo.create_grant(
        db_session, resource_type="view", resource_id=granted.id,
        subject_type="user", subject_id="usr_member", role_name="viewer",
    )
    await db_session.commit()

    for name, build in _principal_builders().items():
        ctx = await build(db_session)
        scope = await view_access.build_read_scope(db_session, ctx)
        sql_ids = await _readable_ids(db_session, scope)
        all_views = (await db_session.execute(select(ViewORM))).scalars().all()
        eval_ids = {
            v.id for v in all_views
            if await view_access.can_read_view(db_session, ctx, v)
        }
        assert sql_ids == eval_ids, (
            f"principal {name}: SQL clause selects {sorted(sql_ids)} but "
            f"the evaluator grants {sorted(eval_ids)}"
        )


@pytest.mark.asyncio
async def test_readable_clause_anonymous_selects_nothing(db_session):
    await _seed_view(
        db_session, view_id="view_sql_anon", visibility="enterprise",
    )
    ctx = await _anon_ctx(db_session)
    scope = await view_access.build_read_scope(db_session, ctx)
    assert await _readable_ids(db_session, scope) == set()
