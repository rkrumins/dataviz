"""Regression tests for the RBAC Phase 1 Alembic migration.

These tests don't run the migration against Postgres — that happens in
CI / integration tests. What they DO catch is drift between the parts
of the codebase that share the permission catalogue:

  * the seed lists in the migration file
  * the wildcard catalogue in ``permission_service``
  * the ``role_bindings`` / ``resource_grants`` enum constraints

A change to one without the other is the most likely class of bug for
this layer; these tests are the cheapest possible canary for it.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


_VERSIONS_DIR = Path(__file__).resolve().parent.parent / "alembic" / "versions"
_MIGRATION_PATH = _VERSIONS_DIR / "20260430_1200_rbac_schema.py"
# Phase 18 added the workspace read/manage split for ontology / catalog /
# provider. Those leaves are seeded here, not in the Phase-1 migration, so the
# seed-vs-collapser check must account for them too.
_WS_READS_MIGRATION_PATH = _VERSIONS_DIR / "20260605_1200_phase18_ws_reads.py"
# View-sharing rework added workspace:view:publish (gates enterprise
# visibility). Seeded by its own data migration, same pattern as Phase 18.
_VIEW_PUBLISH_MIGRATION_PATH = _VERSIONS_DIR / "20260731_1300_view_publish.py"
# Analytics added system:analytics:read — the dedicated platform privilege for
# the Analytics section. Same pattern again.
_ANALYTICS_PERM_MIGRATION_PATH = _VERSIONS_DIR / "20260823_1200_analytics_perm.py"


def _load_migration(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def migration_module():
    return _load_migration(_MIGRATION_PATH, "_rbac_migration")


@pytest.fixture(scope="module")
def ws_reads_migration_module():
    return _load_migration(_WS_READS_MIGRATION_PATH, "_rbac_ws_reads_migration")


def test_migration_file_exists():
    assert _MIGRATION_PATH.exists(), f"missing migration: {_MIGRATION_PATH}"


def test_migration_revision_chain(migration_module):
    """Down-revision must point at the previous migration on disk so the
    chain stays linear. If a later migration is appended, this test
    will fail and prompt updating the chain."""
    assert migration_module.revision == "20260430_1200_rbac_schema"
    assert migration_module.down_revision == "20260426_1600_job_event_log"


def test_permissions_catalogue_is_well_formed(migration_module):
    perms = migration_module._PERMISSIONS
    # No duplicate ids
    ids = [p[0] for p in perms]
    assert len(ids) == len(set(ids)), f"duplicate permission ids: {ids}"
    # Every category is one of the allowed values
    for _id, _desc, cat in perms:
        assert cat in {"system", "workspace", "resource"}, f"bad category for {_id}"


def test_admin_role_gets_every_permission(migration_module):
    perm_ids = {p[0] for p in migration_module._PERMISSIONS}
    admin_perms = {p for r, p in migration_module._ROLE_PERMISSIONS if r == "admin"}
    assert admin_perms == perm_ids, (
        "admin must be granted every permission in the catalogue. "
        f"Missing from admin: {perm_ids - admin_perms}; "
        f"Extra on admin: {admin_perms - perm_ids}"
    )


def test_user_role_subset_of_catalogue(migration_module):
    perm_ids = {p[0] for p in migration_module._PERMISSIONS}
    user_perms = {p for r, p in migration_module._ROLE_PERMISSIONS if r == "user"}
    assert user_perms <= perm_ids
    # Sanity: user role must include the minimum to do its job.
    assert "workspace:view:create" in user_perms
    assert "workspace:view:edit" in user_perms
    assert "workspace:view:read" in user_perms


def test_viewer_role_is_read_only(migration_module):
    viewer_perms = {p for r, p in migration_module._ROLE_PERMISSIONS if r == "viewer"}
    assert "workspace:view:read" in viewer_perms
    # Viewer must not have any write or admin perms
    forbidden = {p for p in viewer_perms if any(
        kw in p for kw in (":create", ":edit", ":delete", ":manage", ":admin")
    )}
    assert forbidden == set(), f"viewer has forbidden perms: {forbidden}"


def test_seed_leaves_match_catalogue(migration_module, ws_reads_migration_module):
    """The wildcard collapser in ``permission_service`` knows about a
    fixed set of leaves per prefix. They must match the seeded permission
    catalogue exactly — otherwise we'd either fail to collapse claims
    that should be wildcards, or emit a wildcard for a partially
    granted set.

    The catalogue is seeded across more than one migration: the Phase-1
    schema migration plus the Phase-18 workspace-reads migration (which
    owns the ontology / catalog / provider leaves) plus the view-publish
    migration (which owns ``workspace:view:publish``)."""
    from backend.app.services.permission_service import _SEED_LEAVES

    assert _VIEW_PUBLISH_MIGRATION_PATH.exists(), (
        f"missing migration: {_VIEW_PUBLISH_MIGRATION_PATH}"
    )
    view_publish_module = _load_migration(
        _VIEW_PUBLISH_MIGRATION_PATH, "_rbac_view_publish_migration"
    )

    perm_ids = {p[0] for p in migration_module._PERMISSIONS}
    perm_ids |= {p[0] for p in ws_reads_migration_module._NEW_PERMISSIONS}
    perm_ids |= {p[0] for p in view_publish_module._NEW_PERMISSIONS}
    for prefix, leaves in _SEED_LEAVES.items():
        expected = {p for p in perm_ids if p.startswith(prefix + ":")}
        assert leaves == expected, (
            f"prefix {prefix!r}: collapser knows {sorted(leaves)} but "
            f"catalogue has {sorted(expected)}"
        )


def test_view_publish_seed_convergence():
    """``workspace:view:publish`` must exist in BOTH seed paths — the
    fresh-install seed (``rbac_seed``) and the migration chain — with the
    same role grants, and the resolver's collapse/implication sets must
    know the new leaf. Divergence here means fresh installs and migrated
    databases authorise publishing differently."""
    from backend.app.config import rbac_seed
    from backend.app.services.permission_service import (
        _SEED_LEAVES,
        _WORKSPACE_CATEGORY_LEAVES,
    )

    perm = "workspace:view:publish"

    assert _VIEW_PUBLISH_MIGRATION_PATH.exists(), (
        f"missing migration: {_VIEW_PUBLISH_MIGRATION_PATH}"
    )
    mod = _load_migration(_VIEW_PUBLISH_MIGRATION_PATH, "_view_publish_migration")

    # Migration side.
    migration_perm_ids = {p[0] for p in mod._NEW_PERMISSIONS}
    assert migration_perm_ids == {perm}
    migration_grants = set(mod._NEW_ROLE_PERMISSIONS)
    assert migration_grants == {("org_admin", perm), ("super_admin", perm)}, (
        "publish is granted to org_admin + super_admin explicitly; "
        "workspace_admin gets it via workspace:admin auto-implication, "
        f"got: {sorted(migration_grants)}"
    )

    # Fresh-install seed side.
    assert perm in {p["id"] for p in rbac_seed.PERMISSIONS}
    seed_grants = {(r, p) for r, p in rbac_seed.ROLE_GRANTS if p == perm}
    assert seed_grants == migration_grants, (
        f"rbac_seed grants {sorted(seed_grants)} but the migration grants "
        f"{sorted(migration_grants)}"
    )

    # No plain-member tier may hold publish in either path.
    for role in ("workspace_member", "workspace_data_engineer",
                 "workspace_viewer", "org_auditor"):
        assert (role, perm) not in set(rbac_seed.ROLE_GRANTS)

    # Resolver knowledge: the wildcard collapse set MUST include the new
    # leaf (otherwise legacy workspace:view:* wildcards silently imply
    # publish for plain members), and workspace:admin must auto-imply it.
    assert perm in _SEED_LEAVES["workspace:view"]
    assert perm in _WORKSPACE_CATEGORY_LEAVES


def test_phase_1_role_enum_matches_repo_validation():
    """The ``role_bindings`` check constraint is mirrored in
    ``binding_repo._validate``. They must agree so app-level errors
    match DB errors."""
    from backend.app.db.repositories import binding_repo

    # Roles allowed by the repo MUST be exactly the Phase 1 enum.
    assert binding_repo.VALID_ROLE_NAMES_PHASE_1 == {"admin", "user", "viewer"}


def test_grant_role_enum_is_narrower_than_global_role():
    """Resource grants intentionally use a smaller role enum to keep
    resource-scope semantics explicit. This guards against someone
    expanding the grant role enum to include 'admin' (which would
    confuse the action matrix)."""
    from backend.app.db.repositories import grant_repo, binding_repo

    assert grant_repo.VALID_GRANT_ROLES == {"editor", "viewer"}
    assert grant_repo.VALID_GRANT_ROLES <= binding_repo.VALID_ROLE_NAMES_PHASE_1 | {"editor"}


def test_analytics_permission_reaches_an_existing_database():
    """``system:analytics:read`` must be seeded by a migration, not only by
    ``rbac_seed``.

    ``seed_reference_data`` runs on the VIRGIN-database path only — an existing
    deployment has always taken its RBAC rows from the migration chain. A
    permission added to ``rbac_seed`` alone therefore reaches fresh installs and
    nothing else: the row is absent, the grants are absent, it cannot be given
    to a custom role, and it never appears in the role-matrix admin UI. The
    section then runs entirely on the older permissions kept for compatibility,
    which is the dedicated privilege doing nothing at all.
    """
    from backend.app.config import rbac_seed

    perm = "system:analytics:read"

    assert _ANALYTICS_PERM_MIGRATION_PATH.exists(), (
        f"missing migration: {_ANALYTICS_PERM_MIGRATION_PATH}"
    )
    mod = _load_migration(_ANALYTICS_PERM_MIGRATION_PATH, "_analytics_perm_migration")

    # Migration side.
    assert {p[0] for p in mod._NEW_PERMISSIONS} == {perm}
    migration_grants = set(mod._NEW_ROLE_PERMISSIONS)
    assert migration_grants == {
        ("org_admin", perm), ("org_auditor", perm), ("super_admin", perm),
    }, f"unexpected grants: {sorted(migration_grants)}"

    # Fresh-install seed side — the two paths must land on the same rows.
    assert perm in {p["id"] for p in rbac_seed.PERMISSIONS}
    seed_grants = {(r, p) for r, p in rbac_seed.ROLE_GRANTS if p == perm}
    assert seed_grants == migration_grants, (
        f"rbac_seed grants {sorted(seed_grants)} but the migration grants "
        f"{sorted(migration_grants)}"
    )


def test_the_analytics_permission_is_offered_to_the_client():
    """The server's privileged list and the nav catalogue's must agree.

    ``useAnalyticsAccess`` reads the catalogue entry to decide whether a caller
    is privileged. While the catalogue omitted the dedicated permission, a
    holder of it was not merely missing a nav item — the route guard refused
    them with a panel saying the section was not open on this deployment, which
    was untrue: the server would have served them the whole document.
    """
    from backend.app.services.analytics_scope import PRIVILEGED_PERMISSIONS
    from backend.app.services.nav_catalogue import get_catalogue

    spec = get_catalogue().sidebar["analytics"].spec
    assert set(spec.perms) == set(PRIVILEGED_PERMISSIONS), (
        "nav catalogue and analytics_scope disagree about who is privileged: "
        f"{sorted(set(spec.perms) ^ set(PRIVILEGED_PERMISSIONS))}"
    )
