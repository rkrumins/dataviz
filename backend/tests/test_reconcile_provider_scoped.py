"""Reconcile revocation is scoped to the provider doing the asserting.

``source='sso'`` rows carry no provider of their own, and the
reconciler used to compare ALL of them against the asserted targets of
whichever provider the user happened to log in through. With two
connections, every login through B read A's grants as "no longer
asserted" and stripped them; the next login through A stripped B's and
re-granted its own. Access flapped with sign-in order, which reads as
"groups randomly stop working".

The rule now: reconcile may only expire/remove a target that one of the
acting provider's OWN mappings (or a NULL-provider wildcard) could have
granted. Grants were always scoped by ``list_active_for_groups``; this
gives revocation the same boundary.
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

from backend.app.db.models import GroupMemberORM, RoleBindingORM
from backend.app.db.repositories import (
    group_repo,
    idp_group_mapping_repo,
    idp_provider_repo,
    user_repo,
)
from backend.app.services.permission_service import reconcile_sso_targets
from backend.auth_service.core.password import disabled_password_hash


async def _provider(db_session, slug):
    return await idp_provider_repo.create_provider(
        db_session, slug=slug, display_name=slug, kind="oidc", settings={},
    )


async def _user(db_session, email):
    user = await user_repo.create_sso_user(
        db_session, email=email, first_name="U", last_name="Ser",
        password_hash=disabled_password_hash(),
    )
    return user


async def _sso_bindings(db_session, user_id):
    rows = (await db_session.execute(
        select(RoleBindingORM).where(
            RoleBindingORM.subject_id == user_id,
            RoleBindingORM.subject_type == "user",
            RoleBindingORM.source == "sso",
        )
    )).scalars().all()
    return {
        (b.scope_type, b.scope_id, b.role_name): b.expires_at for b in rows
    }


async def _sso_memberships(db_session, user_id):
    rows = (await db_session.execute(
        select(GroupMemberORM).where(
            GroupMemberORM.user_id == user_id,
            GroupMemberORM.source == "sso",
        )
    )).scalars().all()
    return {m.group_id for m in rows}


@pytest.mark.asyncio
async def test_logging_in_through_b_keeps_what_a_granted(db_session):
    """The flap itself, role-binding branch."""
    a = await _provider(db_session, "conn-a")
    b = await _provider(db_session, "conn-b")
    ws = "ws_1"
    await idp_group_mapping_repo.create_role_binding_mapping(
        db_session, idp_group="a-analysts", role_name="workspace_member",
        scope_type="workspace", scope_id=ws, provider_id=a.id,
    )
    await idp_group_mapping_repo.create_role_binding_mapping(
        db_session, idp_group="b-viewers", role_name="workspace_viewer",
        scope_type="workspace", scope_id=ws, provider_id=b.id,
    )
    user = await _user(db_session, "both@corp.example")

    await reconcile_sso_targets(
        db_session, user_id=user.id, idp_groups=["a-analysts"],
        provider_id=a.id,
    )
    out = await reconcile_sso_targets(
        db_session, user_id=user.id, idp_groups=["b-viewers"],
        provider_id=b.id,
    )

    assert out["revoked"] == 0, "B just stripped what A granted"
    bindings = await _sso_bindings(db_session, user.id)
    assert bindings[("workspace", ws, "workspace_member")] is None
    assert bindings[("workspace", ws, "workspace_viewer")] is None


@pytest.mark.asyncio
async def test_the_acting_provider_still_revokes_its_own(db_session):
    """Scoping must not blunt the point of reconcile: a group the
    directory took away stops granting on the very next login."""
    a = await _provider(db_session, "conn-own")
    await idp_group_mapping_repo.create_role_binding_mapping(
        db_session, idp_group="analysts", role_name="workspace_member",
        scope_type="workspace", scope_id="ws_1", provider_id=a.id,
    )
    user = await _user(db_session, "own@corp.example")

    await reconcile_sso_targets(
        db_session, user_id=user.id, idp_groups=["analysts"],
        provider_id=a.id,
    )
    out = await reconcile_sso_targets(
        db_session, user_id=user.id, idp_groups=[], provider_id=a.id,
    )

    assert out["revoked"] == 1
    bindings = await _sso_bindings(db_session, user.id)
    assert bindings[("workspace", "ws_1", "workspace_member")] is not None


@pytest.mark.asyncio
async def test_membership_branch_is_scoped_the_same_way(db_session):
    a = await _provider(db_session, "conn-ga")
    b = await _provider(db_session, "conn-gb")
    ga = await group_repo.create_group(db_session, name="From A", description="")
    gb = await group_repo.create_group(db_session, name="From B", description="")
    await idp_group_mapping_repo.create_group_membership_mapping(
        db_session, idp_group="a-team", target_group_id=ga.id, provider_id=a.id,
    )
    await idp_group_mapping_repo.create_group_membership_mapping(
        db_session, idp_group="b-team", target_group_id=gb.id, provider_id=b.id,
    )
    user = await _user(db_session, "teams@corp.example")

    await reconcile_sso_targets(
        db_session, user_id=user.id, idp_groups=["a-team"], provider_id=a.id,
    )
    out = await reconcile_sso_targets(
        db_session, user_id=user.id, idp_groups=["b-team"], provider_id=b.id,
    )

    assert out["memberships_removed"] == 0
    assert await _sso_memberships(db_session, user.id) == {ga.id, gb.id}

    # And B still removes ITS OWN when the directory stops asserting it.
    out = await reconcile_sso_targets(
        db_session, user_id=user.id, idp_groups=[], provider_id=b.id,
    )
    assert out["memberships_removed"] == 1
    assert await _sso_memberships(db_session, user.id) == {ga.id}


@pytest.mark.asyncio
async def test_a_shared_target_stays_while_either_provider_asserts_it(
    db_session,
):
    """Two connections mapping onto the SAME internal group: the second
    provider governs the target, so its login re-judges it — and keeps
    it, because its own mapping asserts it."""
    a = await _provider(db_session, "conn-sa")
    b = await _provider(db_session, "conn-sb")
    shared = await group_repo.create_group(
        db_session, name="Shared", description="",
    )
    await idp_group_mapping_repo.create_group_membership_mapping(
        db_session, idp_group="alpha", target_group_id=shared.id,
        provider_id=a.id,
    )
    await idp_group_mapping_repo.create_group_membership_mapping(
        db_session, idp_group="beta", target_group_id=shared.id,
        provider_id=b.id,
    )
    user = await _user(db_session, "shared@corp.example")

    await reconcile_sso_targets(
        db_session, user_id=user.id, idp_groups=["alpha"], provider_id=a.id,
    )
    out = await reconcile_sso_targets(
        db_session, user_id=user.id, idp_groups=["beta"], provider_id=b.id,
    )
    assert out["memberships_removed"] == 0
    assert await _sso_memberships(db_session, user.id) == {shared.id}

    # B stops asserting it: B governs the shared target, so B removes
    # it. Accepted semantics — the row does not remember which provider
    # granted it, and A's next login re-adds it.
    out = await reconcile_sso_targets(
        db_session, user_id=user.id, idp_groups=[], provider_id=b.id,
    )
    assert out["memberships_removed"] == 1


@pytest.mark.asyncio
async def test_a_wildcard_mapping_is_governed_by_every_provider(db_session):
    """NULL-provider mappings keep the old cross-provider semantics:
    every login judges them, whichever connection it came through."""
    a = await _provider(db_session, "conn-wa")
    b = await _provider(db_session, "conn-wb")
    await idp_group_mapping_repo.create_role_binding_mapping(
        db_session, idp_group="everyone", role_name="workspace_viewer",
        scope_type="workspace", scope_id="ws_9", provider_id=None,
    )
    user = await _user(db_session, "wild@corp.example")

    await reconcile_sso_targets(
        db_session, user_id=user.id, idp_groups=["everyone"],
        provider_id=a.id,
    )
    out = await reconcile_sso_targets(
        db_session, user_id=user.id, idp_groups=[], provider_id=b.id,
    )

    assert out["revoked"] == 1, (
        "a wildcard's grant must be revocable from any connection"
    )
