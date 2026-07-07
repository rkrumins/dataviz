"""Draft lifecycle wires branch-scoped layout overlays, non-fatally (needs Postgres).

BSL Phase 2. When a draft branch is opened FOR a Context View the versioning endpoints
snapshot that view's published base layout into a per-(view, branch) overlay via
``_ensure_view_layout_overlay`` (the fork-point base for the eventual 3-way promote); when
the draft is abandoned they drop its overlays via ``_drop_view_layout_overlays``. This proves:

- opening for a view CREATES an overlay snapshotting the base (fork_base == effective == base);
- resuming an existing draft is idempotent — no duplicate row, and the fork base is NOT
  re-snapshotted even if the published base moved on;
- a draft opened off any view (view_id absent) creates no overlay and raises nothing;
- a since-deleted view (ensure_overlay raises) is swallowed by the wrap — no overlay, no raise;
- abandon drops only the abandoned branch's overlays, leaving other branches' intact;
- hard-deleting a view cascades its overlays away (Phase 1 FK ON DELETE CASCADE, real PG);
- it is best-effort: a management-DB failure is swallowed so overlay bookkeeping can never
  fail the user's draft open / abandon.
"""
import asyncio
import json
import os

import pytest


_LAYERS = [{"id": "l1", "name": "Core", "entityTypes": [], "order": 0}]
_ASSIGNMENTS = {"urn:x": {"layerId": "l1", "inheritsChildren": True, "assignedBy": "user"}}
_BASE_V1 = {"layers": _LAYERS, "assignments": _ASSIGNMENTS}


def _config(reference_layout: dict) -> str:
    return json.dumps({
        "content": {"visibleEntityTypes": ["domain"]},
        "layout": {"type": "reference", "referenceLayout": reference_layout},
    })


async def _seed_management() -> tuple:
    """Create a workspace + two views (with a bare referenceLayout) in the management DB.
    Returns (view_id, other_view_id)."""
    from backend.app.db.engine import get_async_session
    from backend.app.db.models import ViewORM, WorkspaceORM

    sfx = os.urandom(3).hex()
    async with get_async_session() as s:
        s.add(WorkspaceORM(id=f"ws_{sfx}", name="Overlay WS"))
        await s.flush()
        v = ViewORM(id=f"view_{sfx}a", name="Primary", workspace_id=f"ws_{sfx}",
                    config=_config(_BASE_V1))
        vother = ViewORM(id=f"view_{sfx}b", name="Other", workspace_id=f"ws_{sfx}",
                         config=_config(_BASE_V1))
        s.add_all([v, vother])
        await s.commit()
    return v.id, vother.id


async def _overlay(view_id: str, branch_id: str):
    from backend.app.db.engine import get_async_session
    from backend.app.db.repositories import view_repo
    async with get_async_session() as s:
        return await view_repo.get_overlay(s, view_id, branch_id)


async def _count_overlays(branch_id: str) -> int:
    from sqlalchemy import func, select
    from backend.app.db.engine import get_async_session
    from backend.app.db.models import ViewLayoutOverlayORM
    async with get_async_session() as s:
        return (await s.execute(
            select(func.count()).select_from(ViewLayoutOverlayORM)
            .where(ViewLayoutOverlayORM.branch_id == branch_id)
        )).scalar() or 0


async def _set_view_layout(view_id: str, reference_layout: dict) -> None:
    from backend.app.db.engine import get_async_session
    from backend.app.db.models import ViewORM
    async with get_async_session() as s:
        row = await s.get(ViewORM, view_id)
        row.config = _config(reference_layout)
        await s.commit()


async def _hard_delete_view(view_id: str) -> None:
    from sqlalchemy import delete
    from backend.app.db.engine import get_async_session
    from backend.app.db.models import ViewORM
    async with get_async_session() as s:
        await s.execute(delete(ViewORM).where(ViewORM.id == view_id))
        await s.commit()


async def _run() -> None:
    from backend.app.api.v1.endpoints import versioning as vapi

    view_id, other_view_id = await _seed_management()

    # ── Open a draft FOR the view: overlay snapshots the base as fork-point ──
    await vapi._ensure_view_layout_overlay(view_id, "branch-A")
    ov = await _overlay(view_id, "branch-A")
    assert ov is not None, "opening a draft for a view must create its layout overlay"
    assert json.loads(ov.fork_base_layout) == _BASE_V1, "fork base must snapshot the published base"
    assert json.loads(ov.reference_layout) == _BASE_V1, "effective layout == base on first open"
    assert ov.entity_scope == "curated"                 # assignments present ⇒ curated
    assert ov.fork_base_entity_scope == "curated"

    # ── Idempotent resume: base moves upstream, resume does NOT re-snapshot / duplicate ──
    base_v2 = {"layers": _LAYERS + [{"id": "l2", "name": "Extra", "entityTypes": [], "order": 1}],
               "assignments": _ASSIGNMENTS}
    await _set_view_layout(view_id, base_v2)
    await vapi._ensure_view_layout_overlay(view_id, "branch-A")
    ov2 = await _overlay(view_id, "branch-A")
    assert json.loads(ov2.fork_base_layout) == _BASE_V1, "resume must NOT re-snapshot the fork base"
    assert await _count_overlays("branch-A") == 1, "resume must not create a duplicate overlay"
    await _set_view_layout(view_id, _BASE_V1)           # restore base for later assertions

    # ── No originating view → no overlay, no error (draft opened off-view) ──
    await vapi._ensure_view_layout_overlay(None, "branch-B")
    await vapi._ensure_view_layout_overlay("", "branch-B")
    assert await _count_overlays("branch-B") == 0

    # ── No branch id → clean no-op ──
    await vapi._ensure_view_layout_overlay(view_id, None)

    # ── Since-deleted view: ensure_overlay raises; the wrap swallows it (no overlay, no raise) ──
    await vapi._ensure_view_layout_overlay("view_does_not_exist", "branch-C")
    assert await _count_overlays("branch-C") == 0

    # ── Abandon drops ONLY the abandoned branch's overlays ──
    await vapi._ensure_view_layout_overlay(other_view_id, "branch-A")   # 2nd overlay on branch-A
    await vapi._ensure_view_layout_overlay(view_id, "branch-D")         # a different branch
    assert await _count_overlays("branch-A") == 2
    await vapi._drop_view_layout_overlays("branch-A")
    assert await _count_overlays("branch-A") == 0
    assert await _count_overlays("branch-D") == 1, "abandon must not touch other branches"
    await vapi._drop_view_layout_overlays(None)          # no branch id → no-op

    # ── View hard-delete cascades its overlays away (Phase 1 FK ON DELETE CASCADE, real PG) ──
    assert await _overlay(view_id, "branch-D") is not None
    await _hard_delete_view(view_id)
    assert await _overlay(view_id, "branch-D") is None, "FK cascade must remove the overlay"

    # ── Best-effort: a management-DB failure never fails draft open / abandon ──
    import backend.app.db.engine as engine_mod
    orig = engine_mod.get_async_session

    def _boom():
        raise RuntimeError("management DB unreachable")

    engine_mod.get_async_session = _boom
    try:
        await vapi._ensure_view_layout_overlay(other_view_id, "branch-E")   # must NOT raise
        await vapi._drop_view_layout_overlays("branch-E")                   # must NOT raise
    finally:
        engine_mod.get_async_session = orig
    assert await _count_overlays("branch-E") == 0       # the failed ensure did not land


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_view_layout_overlay_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning view-layout overlay lifecycle e2e: OK")
