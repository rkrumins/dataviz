"""Drift guard + unit coverage for the implication metadata that
``GET /admin/permissions`` returns to the frontend.

The previous shape kept a duplicate ``WORKSPACE_LEAVES`` constant on
the FE (``frontend/src/lib/navPermissions.ts``) that silently fell
behind the backend's ``_WORKSPACE_CATEGORY_LEAVES`` when Phase 18
added workspace:provider:read / workspace:ontology:* / workspace:catalog:*.
The Feature Access tab undercounted as a result.

We now serve implications from the catalog (``impliedBy`` field).
These tests assert:

  1. ``compute_implied_by`` returns the right shortcuts for each
     category — pure, no DB.
  2. Every workspace-category permission in the seed catalogue that
     is NOT deliberately excluded (provider:manage doesn't exist;
     workspace:admin is the source, not a target) appears in
     ``_WORKSPACE_CATEGORY_LEAVES``. If a future migration adds a
     ``workspace:*`` leaf and forgets to update the resolver, this
     test fails before the drift can reach the FE.
"""
from __future__ import annotations

from backend.app.services.permission_service import (
    _SEED_LEAVES,
    _WORKSPACE_CATEGORY_LEAVES,
    compute_implied_by,
)


# ── compute_implied_by — pure projection of the resolver shortcuts ──

def test_system_admin_has_no_implications() -> None:
    """``system:admin`` is the root shortcut — nothing implies it."""
    assert compute_implied_by("system:admin", "system") == []


def test_system_org_admin_only_implied_by_system_admin() -> None:
    """``system:org-admin`` lives in the system category, so the
    workspace-only shortcuts don't apply."""
    assert compute_implied_by("system:org-admin", "system") == ["system:admin"]


def test_system_users_manage_implied_only_by_system_admin() -> None:
    """A system-category leaf that is NOT the org-admin shortcut.
    org-admin does NOT imply system:* — that's super_admin territory."""
    assert compute_implied_by("system:users:manage", "system") == ["system:admin"]


def test_workspace_admin_implied_by_admins_only() -> None:
    """``workspace:admin`` is itself the workspace shortcut, so it
    cannot be implied by itself — only by system:admin and org-admin."""
    assert compute_implied_by("workspace:admin", "workspace") == [
        "system:admin",
        "system:org-admin",
    ]


def test_workspace_leaf_implied_by_all_shortcuts() -> None:
    """Phase 18 entry — the exact case that was broken pre-fix.
    workspace:provider:read sits in _WORKSPACE_CATEGORY_LEAVES, so
    workspace:admin implies it. Both global shortcuts also apply.

    Phase 6 added ``system:org-viewer`` between ``system:org-admin``
    and ``workspace:admin`` because the perm ends in ``:read``."""
    assert compute_implied_by("workspace:provider:read", "workspace") == [
        "system:admin",
        "system:org-admin",
        "system:org-viewer",
        "workspace:admin",
    ]


def test_workspace_leaf_not_in_category_excludes_workspace_admin() -> None:
    """A workspace-category permission that is intentionally NOT in
    _WORKSPACE_CATEGORY_LEAVES (e.g. a hypothetical privileged perm
    we don't want workspace:admin to auto-grant) should still be
    implied by the two global shortcuts but NOT by workspace:admin.
    Use a synthetic id so the test doesn't depend on which perms
    are currently excluded. The synthetic id ends in ``:manage`` so
    ``system:org-viewer`` does not imply it either."""
    out = compute_implied_by("workspace:secret:manage", "workspace")
    assert out == ["system:admin", "system:org-admin"]


def test_org_viewer_only_implies_read_perms() -> None:
    """Phase 6 invariant: ``system:org-viewer`` MUST NEVER imply a
    workspace ``manage`` / ``edit`` / ``create`` / ``delete`` perm —
    only ``*:read``. Guards the org_auditor role against accidental
    write-grant drift if someone adds a new mutating perm without
    thinking about the read/write split."""
    for write_perm in [
        "workspace:ontology:manage",
        "workspace:catalog:manage",
        "workspace:datasource:manage",
        "workspace:view:create",
        "workspace:view:edit",
        "workspace:view:delete",
    ]:
        out = compute_implied_by(write_perm, "workspace")
        assert "system:org-viewer" not in out, (
            f"system:org-viewer must not imply {write_perm!r} — that "
            f"would silently grant write to the org_auditor role."
        )


def test_org_viewer_implied_only_by_system_admin() -> None:
    """``system:org-viewer`` is in the system category, so the
    workspace-only shortcuts don't apply — only system:admin implies
    it. Mirrors the same property of system:org-admin."""
    assert compute_implied_by("system:org-viewer", "system") == ["system:admin"]


def test_org_viewer_does_not_imply_workspace_admin_itself() -> None:
    """``workspace:admin`` doesn't end in ``:read``, so ``system:org-viewer``
    cannot reach it — admin grants member-management, which is a
    write-class capability."""
    out = compute_implied_by("workspace:admin", "workspace")
    assert "system:org-viewer" not in out


# ── Drift guard — keep the resolver in lockstep with the catalogue ──

def test_every_seeded_workspace_leaf_is_in_resolver_category() -> None:
    """If a migration adds a new ``workspace:<category>:<leaf>`` to
    ``_SEED_LEAVES`` but forgets to add it to
    ``_WORKSPACE_CATEGORY_LEAVES``, ``workspace:admin`` silently stops
    implying it — and the Feature Access tab undercounts. This test
    keeps the two in sync.

    The only intentional exclusion is ``workspace:provider:manage``,
    which doesn't exist (provider rows carry credentials and stay
    platform-admin-only). The current seed lists ``workspace:provider``
    with just ``read`` so that case is naturally fine.
    """
    seeded_leaves: set[str] = set()
    for prefix, leaves in _SEED_LEAVES.items():
        seeded_leaves.update(leaves)
        # Sanity: every leaf must share the prefix.
        for leaf in leaves:
            assert leaf.startswith(prefix + ":"), (
                f"Leaf {leaf!r} indexed under prefix {prefix!r} but does "
                f"not start with it."
            )

    missing = seeded_leaves - _WORKSPACE_CATEGORY_LEAVES
    assert not missing, (
        "Seeded workspace leaves missing from "
        "_WORKSPACE_CATEGORY_LEAVES (workspace:admin will not "
        f"auto-imply these): {sorted(missing)!r}. Add them to the "
        "frozenset in permission_service.py so the resolver and the "
        "/admin/permissions catalogue stay in lockstep."
    )


def test_workspace_admin_is_listed_as_its_own_category_marker() -> None:
    """``workspace:admin`` itself must be in the category set — the
    resolver uses presence as a fast 'is this a workspace perm at all'
    check before falling through to ``compute_implied_by``."""
    assert "workspace:admin" in _WORKSPACE_CATEGORY_LEAVES
