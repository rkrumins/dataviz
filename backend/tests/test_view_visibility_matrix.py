"""The visibility tier × caller matrix, asserted twice over.

Every tier is checked against every shape of caller, through **both**
evaluation surfaces:

  * ``read_decision`` — one loaded view, used by the detail routes.
  * ``readable_views_predicate`` — the SQL form, used by every listing.

They must agree on every cell. A divergence is a real defect in either
direction: the list would surface a view the detail route then refuses
(confusing), or the detail route would open a view the list hides (a
leak that no listing test would ever catch).

The tiers form a strictly widening ladder — ``private`` ⊂ ``workspace``
⊂ ``enterprise`` ⊂ ``public`` — and ``test_the_ladder_is_monotonic``
asserts that directly, so a future edit cannot make a wider tier reach
fewer people than a narrower one.
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

from backend.app.db.models import ResourceGrantORM, ViewORM, WorkspaceORM
from backend.app.services import view_access
from backend.common.view_visibility import VISIBILITY_VALUES
from tests.common.view_scopes import scope_for, viewer_context

WS = "ws_finance"
OTHER_WS = "ws_marketing"
OWNER = "usr_owner"


# ── caller shapes ────────────────────────────────────────────────────

def _callers():
    """Every caller shape, narrowest reach first."""
    return {
        "anonymous": viewer_context(is_anonymous=True),
        # Authenticated, but holds no binding in any workspace — e.g. an
        # invited account that has not been added to anything yet.
        "no_binding": viewer_context(user_id="usr_nobody"),
        # A member of a DIFFERENT workspace: in the organisation, but with
        # no reach into this view's workspace.
        "other_ws_member": viewer_context(
            user_id="usr_other", ws_perms={OTHER_WS: ("workspace:view:read",)},
        ),
        "ws_viewer": viewer_context(
            user_id="usr_viewer", ws_perms={WS: ("workspace:view:read",)},
        ),
        "ws_admin": viewer_context(
            user_id="usr_wsadmin", ws_perms={WS: ("workspace:admin",)},
        ),
        "creator": viewer_context(user_id=OWNER, ws_perms={}),
        "org_admin": viewer_context(
            user_id="usr_orgadmin", global_perms=("system:org-admin",),
        ),
        "system_admin": viewer_context(
            user_id="usr_root", global_perms=("system:admin",),
        ),
    }


#: tier -> the callers that may read it. Anything not listed must NOT.
#: This is the specification; the code is checked against it, not the
#: other way round.
EXPECTED = {
    "private": {"creator", "ws_admin", "org_admin", "system_admin"},
    "workspace": {
        "creator", "ws_viewer", "ws_admin", "org_admin", "system_admin",
    },
    "enterprise": {
        "creator", "ws_viewer", "ws_admin", "other_ws_member",
        "org_admin", "system_admin",
    },
    "public": {
        "creator", "ws_viewer", "ws_admin", "other_ws_member", "no_binding",
        "org_admin", "system_admin",
    },
}


async def _seed(session, visibility: str, *, view_id: str = "view_x"):
    session.add(WorkspaceORM(id=WS, name="Finance"))
    session.add(WorkspaceORM(id=OTHER_WS, name="Marketing"))
    session.add(ViewORM(
        id=view_id, name=view_id, workspace_id=WS,
        visibility=visibility, created_by=OWNER,
    ))
    await session.commit()
    return (await session.execute(
        select(ViewORM).where(ViewORM.id == view_id)
    )).scalar_one()


async def _predicate_allows(session, ctx, view_id: str) -> bool:
    """Does the SQL predicate return this view for this caller?"""
    scope = await view_access.build_read_scope(session, ctx)
    rows = (await session.execute(
        select(ViewORM.id).where(
            view_access.readable_views_predicate(scope),
        )
    )).scalars().all()
    return view_id in rows


# ── the matrix ───────────────────────────────────────────────────────

@pytest.mark.parametrize("visibility", sorted(EXPECTED))
@pytest.mark.parametrize("caller", sorted(_callers()))
@pytest.mark.asyncio
async def test_tier_matrix_single_view(db_session, visibility, caller):
    view = await _seed(db_session, visibility)
    ctx = _callers()[caller]

    decision = await view_access.read_decision(db_session, ctx, view)
    expected = caller in EXPECTED[visibility]
    assert decision.allowed is expected, (
        f"{caller} reading a {visibility} view: "
        f"got {decision.allowed} (reason={decision.reason}), want {expected}"
    )
    if expected:
        assert decision.reason is not None, "an allow must say why"


@pytest.mark.parametrize("visibility", sorted(EXPECTED))
@pytest.mark.parametrize("caller", sorted(_callers()))
@pytest.mark.asyncio
async def test_tier_matrix_sql_predicate_agrees(db_session, visibility, caller):
    """The SQL form must produce the same answer as the single-view form."""
    await _seed(db_session, visibility)
    ctx = _callers()[caller]

    allowed = await _predicate_allows(db_session, ctx, "view_x")
    assert allowed is (caller in EXPECTED[visibility]), (
        f"SQL predicate for {caller} on a {visibility} view: "
        f"got {allowed}, want {caller in EXPECTED[visibility]}"
    )


@pytest.mark.asyncio
async def test_the_ladder_is_monotonic(db_session):
    """Each tier reaches everyone the narrower tier reaches, and no fewer.

    Guards the property the whole model rests on. Without it a future edit
    could make e.g. ``enterprise`` unreachable by a workspace member while
    ``workspace`` stays reachable — a widening that narrows.
    """
    order = [v for v in VISIBILITY_VALUES]
    for narrower, wider in zip(order, order[1:]):
        assert EXPECTED[narrower] <= EXPECTED[wider], (
            f"{wider} does not reach everyone {narrower} reaches: "
            f"lost {sorted(EXPECTED[narrower] - EXPECTED[wider])}"
        )


# ── the specific reported defects ────────────────────────────────────

@pytest.mark.asyncio
async def test_private_is_not_readable_by_a_workspace_member(db_session):
    """Problem 2, stated directly.

    Workspace membership used to be an independent grant evaluated without
    reference to the tier, so every member of a workspace could read every
    private view in it.
    """
    view = await _seed(db_session, "private")
    ctx = _callers()["ws_viewer"]
    assert not (await view_access.read_decision(db_session, ctx, view)).allowed
    assert not await _predicate_allows(db_session, ctx, "view_x")


@pytest.mark.asyncio
async def test_enterprise_reaches_other_workspaces_but_not_strangers(db_session):
    """``enterprise`` means "in the organisation", not "authenticated".

    It used to mean the latter, which made it identical to what ``public``
    now is and left no tier in between.
    """
    view = await _seed(db_session, "enterprise")
    member_elsewhere = _callers()["other_ws_member"]
    unbound = _callers()["no_binding"]

    assert (await view_access.read_decision(db_session, member_elsewhere, view)).allowed
    assert not (await view_access.read_decision(db_session, unbound, view)).allowed


@pytest.mark.asyncio
async def test_public_reaches_an_account_with_no_workspace_at_all(db_session):
    """Problem 3: a tier anyone signed in can reach, workspace or not."""
    view = await _seed(db_session, "public")
    unbound = _callers()["no_binding"]
    decision = await view_access.read_decision(db_session, unbound, view)
    assert decision.allowed
    assert decision.reason == "tier:public"


@pytest.mark.asyncio
async def test_public_stops_at_authenticated(db_session):
    """``public`` is not anonymous. There is no logged-out access to views."""
    view = await _seed(db_session, "public")
    ctx = _callers()["anonymous"]
    assert not (await view_access.read_decision(db_session, ctx, view)).allowed
    assert not await _predicate_allows(db_session, ctx, "view_x")


@pytest.mark.asyncio
async def test_org_auditor_reads_workspace_tier_but_not_private(db_session):
    """``system:org-viewer`` short-circuits ``:read`` permissions only.

    So an org_auditor reaches every ``workspace``-tier view without a
    binding, but ``private`` checks ``workspace:admin``, which is not a
    read permission and therefore does not short-circuit. Asserted so the
    asymmetry is a decision on the record rather than an accident.
    """
    auditor = viewer_context(
        user_id="usr_auditor", global_perms=("system:org-viewer",),
    )
    ws_view = await _seed(db_session, "workspace", view_id="view_ws")
    assert (await view_access.read_decision(db_session, auditor, ws_view)).allowed

    priv = ViewORM(
        id="view_priv", name="priv", workspace_id=WS,
        visibility="private", created_by=OWNER,
    )
    db_session.add(priv)
    await db_session.commit()
    assert not (await view_access.read_decision(db_session, auditor, priv)).allowed


# ── explicit grants are additive at every tier ───────────────────────

@pytest.mark.asyncio
async def test_an_explicit_grant_reaches_a_private_view(db_session):
    """Layer 3 still extends access to a named subject regardless of tier
    or workspace membership — that is what sharing means."""
    view = await _seed(db_session, "private")
    db_session.add(ResourceGrantORM(
        id="grt_1", resource_type="view", resource_id=view.id,
        subject_type="user", subject_id="usr_nobody", role_name="viewer",
    ))
    await db_session.commit()

    ctx = _callers()["no_binding"]  # usr_nobody
    decision = await view_access.read_decision(db_session, ctx, view)
    assert decision.allowed
    assert decision.reason == "grant"
    assert await _predicate_allows(db_session, ctx, "view_x")


@pytest.mark.asyncio
async def test_a_grant_to_a_different_view_does_not_leak(db_session):
    """A grant is per-resource; holding one must not widen the rest."""
    await _seed(db_session, "private", view_id="view_a")
    db_session.add(ViewORM(
        id="view_b", name="view_b", workspace_id=WS,
        visibility="private", created_by=OWNER,
    ))
    db_session.add(ResourceGrantORM(
        id="grt_2", resource_type="view", resource_id="view_a",
        subject_type="user", subject_id="usr_nobody", role_name="viewer",
    ))
    await db_session.commit()

    ctx = _callers()["no_binding"]
    assert await _predicate_allows(db_session, ctx, "view_a")
    assert not await _predicate_allows(db_session, ctx, "view_b")


# ── reasons ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_granted_by_reports_the_branch_that_allowed_it(db_session):
    """``grantedBy`` has to be accurate to be worth surfacing — a wrong
    explanation is worse than none."""
    cases = [
        ("private", "creator", "creator"),
        ("private", "ws_admin", "workspace-admin"),
        ("workspace", "ws_viewer", "tier:workspace"),
        ("enterprise", "other_ws_member", "tier:enterprise"),
        ("public", "no_binding", "tier:public"),
        ("private", "system_admin", "system-admin"),
    ]
    for visibility, caller, expected_reason in cases:
        view = ViewORM(
            id=f"view_{visibility}_{caller}", name="v", workspace_id=WS,
            visibility=visibility, created_by=OWNER,
        )
        db_session.add(view)
        await db_session.commit()

        decision = await view_access.read_decision(
            db_session, _callers()[caller], view,
        )
        assert decision.allowed, f"{caller} should read {visibility}"
        assert decision.reason == expected_reason, (
            f"{caller} on {visibility}: reason was {decision.reason!r}, "
            f"expected {expected_reason!r}"
        )
