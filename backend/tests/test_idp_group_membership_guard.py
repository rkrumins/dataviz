"""An IdP group must not reach ``super_admin`` through an internal group.

``role_binding`` mappings are guarded twice — refused at write time when
they name a role we never auto-grant, and refused again at reconcile
time so a mapping written before the guard (or inserted out of band)
still cannot take effect.

``group_membership`` mappings were guarded by neither. The validator
asked whether the target group existed and whether it carried
``is_protected``; it never asked what the group *grants*. Group bindings
resolve into a member's effective permissions exactly as their own do,
so pointing an IdP group at an internal group holding a global
``super_admin`` binding handed platform admin to whoever the IdP put in
the source group — the precise outcome the role-binding guard exists to
prevent, reached by the other door.

``is_protected`` was no help: it is read in four places and written in
none, so every group creatable through the API has it false.

Both halves are tested. The reconcile-time half is the one that matters
most, because a group's bindings can change *after* a mapping is
written, and write-time validation cannot see that happen.
"""
from __future__ import annotations

import pytest

from backend.app.db.models import RoleBindingORM
from backend.app.db.repositories import (
    group_repo,
    idp_group_mapping_repo,
    idp_provider_repo,
    user_repo,
)
from backend.app.db.repositories.idp_group_mapping_repo import (
    ForbiddenSsoRoleError,
)
from backend.app.services import permission_service
from backend.app.services.permission_service import reconcile_sso_targets
from backend.auth_service.core.password import disabled_password_hash


async def _admin_group(db_session, name="Platform Owners", role="super_admin"):
    """An internal group that confers a platform role on its members."""
    group = await group_repo.create_group(
        db_session, name=name, description="holds a global admin binding",
    )
    db_session.add(RoleBindingORM(
        subject_type="group", subject_id=group.id,
        role_name=role, scope_type="global", scope_id=None,
        source="local",
    ))
    await db_session.flush()
    return group


async def _provider(db_session, slug="entra-staff", kind="oidc", settings=None):
    return await idp_provider_repo.create_provider(
        db_session, slug=slug, display_name=slug,
        kind=kind, settings=settings or {},
    )


# ── Write time ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_mapping_into_a_group_that_grants_super_admin_is_refused(db_session):
    provider = await _provider(db_session)
    group = await _admin_group(db_session)

    with pytest.raises(ForbiddenSsoRoleError) as err:
        await idp_group_mapping_repo.create_group_membership_mapping(
            db_session, idp_group="Everyone",
            target_group_id=group.id, provider_id=provider.id,
        )
    # The refusal names what the group grants, not just that it refused —
    # an operator has to be able to act on it.
    assert "super_admin" in str(err.value)


@pytest.mark.asyncio
async def test_mapping_into_an_ordinary_group_still_works(db_session):
    """The guard must not break the legitimate configuration."""
    provider = await _provider(db_session, slug="entra-eng")
    group = await group_repo.create_group(
        db_session, name="Engineers", description="no bindings",
    )
    row = await idp_group_mapping_repo.create_group_membership_mapping(
        db_session, idp_group="engineering",
        target_group_id=group.id, provider_id=provider.id,
    )
    assert row.target_group_id == group.id


@pytest.mark.asyncio
async def test_mapping_into_a_workspace_role_group_still_works(db_session):
    """Only the never-auto-grant roles are refused, not every binding."""
    provider = await _provider(db_session, slug="entra-ws")
    group = await group_repo.create_group(
        db_session, name="Analysts", description="",
    )
    db_session.add(RoleBindingORM(
        subject_type="group", subject_id=group.id,
        role_name="workspace_viewer", scope_type="global", scope_id=None,
        source="local",
    ))
    await db_session.flush()

    row = await idp_group_mapping_repo.create_group_membership_mapping(
        db_session, idp_group="analysts",
        target_group_id=group.id, provider_id=provider.id,
    )
    assert row.target_group_id == group.id


@pytest.mark.asyncio
async def test_org_admin_via_group_requires_a_verified_provider(db_session):
    """The assurance rule reaches through a group too.

    ``org_admin`` is auto-grantable, but not from a provider that cannot
    prove who anyone is. Naming it directly was already refused for an
    unsigned ``custom_profile`` row; reaching it through a group was not.
    """
    unsigned = await _provider(
        db_session, slug="corp-portal", kind="custom_profile",
        settings={
            "source": "local_storage", "source_key": "corp.user",
            "payload_format": "json", "trust_unsigned": True,
        },
    )
    group = await _admin_group(
        db_session, name="Org Operators", role="org_admin",
    )

    with pytest.raises(ForbiddenSsoRoleError) as err:
        await idp_group_mapping_repo.create_group_membership_mapping(
            db_session, idp_group="operators",
            target_group_id=group.id, provider_id=unsigned.id,
        )
    assert "org_admin" in str(err.value)


# ── Reconcile time ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_mapping_written_before_the_guard_does_not_take_effect(db_session):
    """The half that write-time validation cannot cover.

    Here the mapping is created legitimately — the group grants nothing
    at the time — and the ``super_admin`` binding is added afterwards.
    Nothing re-validates the mapping when that happens, so the only
    thing standing between the IdP and platform admin is the check at
    the moment membership would be granted.
    """
    provider = await _provider(db_session, slug="entra-late")
    group = await group_repo.create_group(
        db_session, name="Later Admins", description="",
    )
    await idp_group_mapping_repo.create_group_membership_mapping(
        db_session, idp_group="Everyone",
        target_group_id=group.id, provider_id=provider.id,
    )

    # The group becomes privileged after the mapping exists.
    db_session.add(RoleBindingORM(
        subject_type="group", subject_id=group.id,
        role_name="super_admin", scope_type="global", scope_id=None,
        source="local",
    ))
    await db_session.flush()

    user = await user_repo.create_sso_user(
        db_session, email="late@corp.example", first_name="L", last_name="A",
        password_hash=disabled_password_hash(),
    )
    out = await reconcile_sso_targets(
        db_session, user_id=user.id, idp_groups=["Everyone"],
        provider_id=provider.id,
    )

    assert out["memberships_added"] == 0, (
        "the IdP's group list just granted platform admin"
    )
    # The end state is what matters: no membership, so no inherited
    # binding, so no ``system:admin`` in the resolved claims.
    claims = await permission_service.resolve(db_session, user.id)
    assert "system:admin" not in claims.global_perms


@pytest.mark.asyncio
async def test_reconcile_still_adds_membership_for_an_ordinary_group(db_session):
    provider = await _provider(db_session, slug="entra-ok")
    group = await group_repo.create_group(
        db_session, name="Readers", description="",
    )
    await idp_group_mapping_repo.create_group_membership_mapping(
        db_session, idp_group="readers",
        target_group_id=group.id, provider_id=provider.id,
    )
    user = await user_repo.create_sso_user(
        db_session, email="ok@corp.example", first_name="O", last_name="K",
        password_hash=disabled_password_hash(),
    )
    out = await reconcile_sso_targets(
        db_session, user_id=user.id, idp_groups=["readers"],
        provider_id=provider.id,
    )
    assert out["memberships_added"] == 1
