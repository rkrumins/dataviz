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


_MIGRATION_PATH = (
    Path(__file__).resolve().parent.parent
    / "alembic" / "versions" / "20260430_1200_rbac_schema.py"
)


@pytest.fixture(scope="module")
def migration_module():
    spec = importlib.util.spec_from_file_location("_rbac_migration", _MIGRATION_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


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


def test_seed_leaves_match_catalogue(migration_module):
    """The wildcard collapser in ``permission_service`` knows about a
    fixed set of leaves per prefix. They must match the migration's
    catalogue exactly — otherwise we'd either fail to collapse claims
    that should be wildcards, or emit a wildcard for a partially
    granted set."""
    from backend.app.services.permission_service import _SEED_LEAVES

    perm_ids = {p[0] for p in migration_module._PERMISSIONS}
    for prefix, leaves in _SEED_LEAVES.items():
        expected = {p for p in perm_ids if p.startswith(prefix + ":")}
        assert leaves == expected, (
            f"prefix {prefix!r}: collapser knows {sorted(leaves)} but "
            f"catalogue has {sorted(expected)}"
        )


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
