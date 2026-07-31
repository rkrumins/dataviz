"""
Tests for backend.app.db.repositories.view_repo.
"""
import json
from contextlib import contextmanager

import pytest
from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from backend.app.db.engine import Base
from backend.app.db.repositories import view_repo
from backend.app.db.models import WorkspaceORM, UserORM
from backend.common.models.management import (
    ViewCreateRequest,
    ViewUpdateRequest,
    ViewLayoutUpdateRequest,
    ViewResponse,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _create_workspace(session: AsyncSession, name: str = "Test WS") -> WorkspaceORM:
    """Insert a workspace prereq and return the ORM row."""
    ws = WorkspaceORM(name=name)
    session.add(ws)
    await session.flush()
    return ws


def _make_create_req(workspace_id: str, **overrides) -> ViewCreateRequest:
    defaults = dict(
        name="Test View",
        workspace_id=workspace_id,
        view_type="graph",
        visibility="private",
    )
    defaults.update(overrides)
    return ViewCreateRequest(**defaults)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

async def test_create_view_returns_response(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    req = _make_create_req(ws.id)
    resp = await view_repo.create_view(db_session, req)

    assert isinstance(resp, ViewResponse)
    assert resp.name == "Test View"
    assert resp.visibility == "private"
    assert resp.view_type == "graph"


async def test_get_view(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    created = await view_repo.create_view(db_session, _make_create_req(ws.id))

    fetched = await view_repo.get_view(db_session, created.id)
    assert fetched is not None
    assert fetched.id == created.id
    assert fetched.name == created.name


async def test_get_view_missing(db_session: AsyncSession):
    result = await view_repo.get_view(db_session, "nonexistent")
    assert result is None


async def test_update_view(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    created = await view_repo.create_view(db_session, _make_create_req(ws.id))

    update_req = ViewUpdateRequest(name="Renamed View", visibility="enterprise")
    updated = await view_repo.update_view(db_session, created.id, update_req)

    assert updated is not None
    assert updated.name == "Renamed View"
    # Visibility is a security field with its own authorization (the
    # publish gate) — the generic update never writes it, even when a
    # caller smuggles it into the request. update_visibility is the
    # only writer.
    assert updated.visibility == "private"


async def test_update_visibility_is_the_only_visibility_writer(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    created = await view_repo.create_view(db_session, _make_create_req(ws.id))
    updated = await view_repo.update_visibility(db_session, created.id, "enterprise")
    assert updated is not None
    assert updated.visibility == "enterprise"


async def test_update_view_missing(db_session: AsyncSession):
    update_req = ViewUpdateRequest(name="Does Not Exist")
    result = await view_repo.update_view(db_session, "nonexistent", update_req)
    assert result is None


async def test_delete_view_soft_deletes(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    created = await view_repo.create_view(db_session, _make_create_req(ws.id))

    result = await view_repo.delete_view(db_session, created.id)
    assert result is True

    # Soft-deleted: still retrievable via get (no deleted_at filter in get_view)
    fetched = await view_repo.get_view(db_session, created.id)
    assert fetched is not None
    assert fetched.deleted_at is not None

    # Not included in default filtered listing
    listed = await view_repo.list_views_filtered(db_session)
    assert listed.total == 0
    assert listed.items == []


async def test_restore_view(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    created = await view_repo.create_view(db_session, _make_create_req(ws.id))

    await view_repo.delete_view(db_session, created.id)
    result = await view_repo.restore_view(db_session, created.id)
    assert result is True

    # Now shows up in listing
    listed = await view_repo.list_views_filtered(db_session)
    assert listed.total == 1
    assert len(listed.items) == 1


async def test_restore_non_deleted_returns_false(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    created = await view_repo.create_view(db_session, _make_create_req(ws.id))

    # View is not deleted, restore should return False
    result = await view_repo.restore_view(db_session, created.id)
    assert result is False


async def test_list_views_filtered_by_visibility(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    await view_repo.create_view(
        db_session, _make_create_req(ws.id, name="Private", visibility="private")
    )
    await view_repo.create_view(
        db_session, _make_create_req(ws.id, name="Enterprise", visibility="enterprise")
    )

    private_views = await view_repo.list_views_filtered(
        db_session, visibility="private"
    )
    assert private_views.total == 1
    assert private_views.items[0].name == "Private"

    enterprise_views = await view_repo.list_views_filtered(
        db_session, visibility="enterprise"
    )
    assert enterprise_views.total == 1
    assert enterprise_views.items[0].name == "Enterprise"


async def test_favourite_view(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    created = await view_repo.create_view(db_session, _make_create_req(ws.id))

    result = await view_repo.favourite_view(db_session, created.id, "user_1")
    assert result is True


async def test_unfavourite_view(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    created = await view_repo.create_view(db_session, _make_create_req(ws.id))

    await view_repo.favourite_view(db_session, created.id, "user_1")
    result = await view_repo.unfavourite_view(db_session, created.id, "user_1")
    assert result is True

    # Unfavouriting again returns False
    result2 = await view_repo.unfavourite_view(db_session, created.id, "user_1")
    assert result2 is False


async def test_favourite_view_is_idempotent(db_session: AsyncSession):
    """Second favourite call for the same user returns False (already favourited)."""
    ws = await _create_workspace(db_session)
    created = await view_repo.create_view(db_session, _make_create_req(ws.id))

    first = await view_repo.favourite_view(db_session, created.id, "user_1")
    assert first is True

    second = await view_repo.favourite_view(db_session, created.id, "user_1")
    assert second is False


# ---------------------------------------------------------------------------
# Batched enrichment (WS-1) — kills the per-row N+1
# ---------------------------------------------------------------------------

@contextmanager
def _count_queries(session: AsyncSession):
    """Count cursor executions on the session's underlying engine.

    Uses the sync engine's ``before_cursor_execute`` hook (the canonical
    SQLAlchemy mechanism). Filters out savepoint/transaction control
    statements so the count reflects real SELECTs / DMLs only.
    """
    counter = {"n": 0}
    engine = session.bind.sync_engine

    def _on_exec(conn, cursor, statement, params, context, executemany):
        stmt = statement.strip().upper()
        if stmt.startswith(("SAVEPOINT", "RELEASE SAVEPOINT", "ROLLBACK", "BEGIN", "COMMIT")):
            return
        counter["n"] += 1

    event.listen(engine, "before_cursor_execute", _on_exec)
    try:
        yield counter
    finally:
        event.remove(engine, "before_cursor_execute", _on_exec)


async def _seed_views(session: AsyncSession, ws: WorkspaceORM, n: int, creator_id: str | None = None):
    """Seed ``n`` views under ``ws`` with one creator and no datasource/context-model.

    The shape is what list_views_filtered emits in the common Explorer case:
    workspace set, datasource None, context_model None, creator set when
    a logged-in user owns the view. Keeps the prerequisite surface tight.
    """
    if creator_id:
        # Insert the creator user once so the batched users-lookup has
        # something to find. Without this the user_map stays empty
        # (creator name resolves to None) — still correct, just less
        # representative of the real workload.
        session.add(UserORM(
            id=creator_id,
            email=f"{creator_id}@example.com",
            password_hash="x",
            first_name="Test",
            last_name="Creator",
            status="active",
        ))
        await session.flush()
    for i in range(n):
        await view_repo.create_view(
            session,
            _make_create_req(ws.id, name=f"v{i}", visibility="workspace"),
            user_id=creator_id,
        )


async def test_list_views_filtered_query_count_is_bounded(db_session: AsyncSession):
    """N+1 kill switch: query count is bounded and independent of row count.

    Before WS-1: list_views_filtered with limit=20 issued ~1 (select) + 1
    (count) + 6×N (per-row enrichment) ≈ 122 queries. After WS-1, the
    enrichment is batched into at most 4 lookups (workspaces, datasources
    when present, context_models when present, users when present,
    favourite counts when view_ids non-empty, favourites-by-user when a
    user is supplied). With ds/cm/user/favs all populated that's 6 total;
    asserted ceiling here is 10 to leave slack for paging/order-by
    side-effects from the dialect.
    """
    ws = await _create_workspace(db_session)
    creator_id = "usr_creator_001"
    await _seed_views(db_session, ws, n=20, creator_id=creator_id)
    await db_session.commit()

    with _count_queries(db_session) as counter:
        listed = await view_repo.list_views_filtered(
            db_session, limit=20, user_id=creator_id,
        )

    assert listed.total == 20
    assert len(listed.items) == 20
    # If we ever regress to per-row enrichment, this will explode to ~120+.
    # 10 is a comfortable ceiling for the batched path on the SQLite test
    # backend; production Postgres should hit ~6.
    assert counter["n"] <= 10, (
        f"list_views_filtered issued {counter['n']} queries for 20 rows; "
        f"expected <=10 with batched enrichment. N+1 regression?"
    )


async def test_list_views_filtered_legacy_kill_switch(db_session: AsyncSession, monkeypatch):
    """VIEWS_BATCH_ENRICH=false falls back to the legacy per-row path.

    Verifies that the kill switch actually disables the new code path so
    we can roll back in seconds if the batched path is found to be
    misbehaving in prod. The legacy path is intentionally chatty, so we
    assert the query count explodes past the batched-path ceiling.
    """
    ws = await _create_workspace(db_session)
    creator_id = "usr_creator_legacy"
    # Pass a creator so the per-row UserORM lookup fires; pass a user_id
    # to list_views_filtered so the per-row favourite check fires too.
    # Without these, legacy short-circuits 4 of 6 helpers per row and the
    # query count is too close to the batched ceiling to distinguish.
    await _seed_views(db_session, ws, n=10, creator_id=creator_id)
    await db_session.commit()

    monkeypatch.setenv("VIEWS_BATCH_ENRICH", "false")

    with _count_queries(db_session) as counter:
        listed = await view_repo.list_views_filtered(
            db_session, limit=10, user_id=creator_id,
        )

    assert listed.total == 10
    # Legacy path with workspace + creator + user_id supplied:
    # ~1 select + 1 count + 4 awaits per row × 10 rows ≈ 42 queries.
    # The batched path is bounded under 10, so 30 is a safe separator.
    assert counter["n"] > 30, (
        f"Legacy path issued {counter['n']} queries; expected >30. "
        f"VIEWS_BATCH_ENRICH switch may be broken."
    )


async def test_batched_enrichment_matches_legacy_output(db_session: AsyncSession, monkeypatch):
    """The new batched path produces identical ViewResponses to the legacy path.

    Critical correctness check: WS-1 changes how the data is fetched but
    not *what* is returned. Compare item-by-item, ignoring volatile
    timestamps that the seed flow may slightly differ on between calls.
    """
    ws = await _create_workspace(db_session)
    creator_id = "usr_creator_002"
    await _seed_views(db_session, ws, n=5, creator_id=creator_id)
    # Add a couple of favourites so the favourite_count / is_favourited
    # paths actually carry signal in the comparison.
    listed = await view_repo.list_views_filtered(db_session, limit=5, user_id=creator_id)
    view_ids = [v.id for v in listed.items]
    await view_repo.favourite_view(db_session, view_ids[0], creator_id)
    await view_repo.favourite_view(db_session, view_ids[1], "usr_other")
    await db_session.commit()

    monkeypatch.setenv("VIEWS_BATCH_ENRICH", "true")
    batched = await view_repo.list_views_filtered(db_session, limit=5, user_id=creator_id)

    monkeypatch.setenv("VIEWS_BATCH_ENRICH", "false")
    legacy = await view_repo.list_views_filtered(db_session, limit=5, user_id=creator_id)

    assert batched.total == legacy.total
    assert len(batched.items) == len(legacy.items)

    def _key_fields(v: ViewResponse) -> dict:
        return {
            "id": v.id,
            "name": v.name,
            "workspace_name": v.workspace_name,
            "created_by_name": v.created_by_name,
            "created_by_email": v.created_by_email,
            "favourite_count": v.favourite_count,
            "is_favourited": v.is_favourited,
            "visibility": v.visibility,
        }

    by_id_batched = {v.id: _key_fields(v) for v in batched.items}
    by_id_legacy = {v.id: _key_fields(v) for v in legacy.items}
    assert by_id_batched == by_id_legacy


async def test_list_popular_views_query_count_is_bounded(db_session: AsyncSession):
    """list_popular_views is the second N+1 we fixed; pin its query count too.

    Before WS-1: 1 (popular query with fav_count JOIN) + 5×N awaits. After
    WS-1: 1 + ≤5 batched lookups; favourite counts are reused from the
    JOIN'd subquery so the GROUP BY query is skipped entirely.
    """
    ws = await _create_workspace(db_session)
    creator_id = "usr_creator_003"
    await _seed_views(db_session, ws, n=8, creator_id=creator_id)
    listed = await view_repo.list_views_filtered(db_session, limit=8, user_id=creator_id)
    # Give every view at least one favourite so they all qualify for
    # the "popular" set (popularity = fav_count > 0).
    for v in listed.items:
        await view_repo.favourite_view(db_session, v.id, "usr_voter")
    await db_session.commit()

    with _count_queries(db_session) as counter:
        popular = await view_repo.list_popular_views(
            db_session, limit=10, user_id=creator_id,
        )

    assert len(popular) == 8
    assert counter["n"] <= 8, (
        f"list_popular_views issued {counter['n']} queries for 8 rows; "
        f"expected <=8 with batched enrichment. N+1 regression?"
    )


# ---------------------------------------------------------------------------
# Provenance: updated_by capture + creator/modifier name resolution
# ---------------------------------------------------------------------------

async def _seed_user(
    session: AsyncSession, user_id: str, first: str = "Test", last: str = "User"
) -> None:
    """Insert a users row so the name-resolution lookup has something to find."""
    session.add(UserORM(
        id=user_id,
        email=f"{user_id}@example.com",
        password_hash="x",
        first_name=first,
        last_name=last,
        status="active",
    ))
    await session.flush()


async def test_update_view_stamps_and_resolves_modifier(db_session: AsyncSession):
    """PUT-path edit records the actor in updated_by and resolves their name."""
    ws = await _create_workspace(db_session)
    await _seed_user(db_session, "usr_editor", first="Ed", last="Itor")
    created = await view_repo.create_view(db_session, _make_create_req(ws.id))

    updated = await view_repo.update_view(
        db_session, created.id, ViewUpdateRequest(name="Edited"),
        user_id="usr_editor",
    )

    assert updated is not None
    assert updated.updated_by == "usr_editor"
    assert updated.updated_by_name == "Ed Itor"
    assert updated.updated_by_email == "usr_editor@example.com"


async def test_update_visibility_stamps_modifier(db_session: AsyncSession):
    """Visibility change also records who made the change."""
    ws = await _create_workspace(db_session)
    await _seed_user(db_session, "usr_vis", first="Vis", last="Or")
    created = await view_repo.create_view(db_session, _make_create_req(ws.id))

    updated = await view_repo.update_visibility(
        db_session, created.id, "enterprise", user_id="usr_vis",
    )

    assert updated is not None
    assert updated.updated_by == "usr_vis"
    assert updated.updated_by_name == "Vis Or"


async def test_fresh_view_has_no_modifier(db_session: AsyncSession):
    """A view that was never edited carries no updated_by / modifier name."""
    ws = await _create_workspace(db_session)
    created = await view_repo.create_view(
        db_session, _make_create_req(ws.id), user_id="usr_creator",
    )

    assert created.updated_by is None
    assert created.updated_by_name is None
    assert created.updated_by_email is None


async def test_unresolvable_modifier_echoes_id_without_name(db_session: AsyncSession):
    """An updated_by with no matching user row echoes the id, names stay None."""
    ws = await _create_workspace(db_session)
    created = await view_repo.create_view(db_session, _make_create_req(ws.id))

    updated = await view_repo.update_view(
        db_session, created.id, ViewUpdateRequest(name="Edited"),
        user_id="usr_ghost",  # deliberately not seeded into users
    )

    assert updated is not None
    assert updated.updated_by == "usr_ghost"
    assert updated.updated_by_name is None
    assert updated.updated_by_email is None


async def test_batch_list_resolves_creator_and_modifier(db_session: AsyncSession):
    """The batched list path resolves BOTH the creator and the modifier name."""
    ws = await _create_workspace(db_session)
    await _seed_user(db_session, "usr_author", first="Aut", last="Hor")
    await _seed_user(db_session, "usr_editor2", first="Ed", last="Two")
    created = await view_repo.create_view(
        db_session, _make_create_req(ws.id, visibility="workspace"),
        user_id="usr_author",
    )
    await view_repo.update_view(
        db_session, created.id, ViewUpdateRequest(name="Edited"),
        user_id="usr_editor2",
    )
    await db_session.commit()

    listed = await view_repo.list_views_filtered(db_session, limit=10)
    item = next(v for v in listed.items if v.id == created.id)

    assert item.created_by_name == "Aut Hor"
    assert item.updated_by_name == "Ed Two"


# ---------------------------------------------------------------------------
# Branch-scoped layout overlays (BSL Phase 1)
# ---------------------------------------------------------------------------

def _layer(lid, name="L", order=0):
    return {"id": lid, "name": name, "order": order}


def _assign(layer_id):
    return {"layerId": layer_id, "inheritsChildren": True}


def _base_config(layers=None, assignments=None, entity_scope="curated"):
    """A full view config whose canonical layout lives at
    ``layout.referenceLayout`` — the published base the overlay forks from."""
    return {
        "content": {"entityScope": entity_scope},
        "layout": {
            "referenceLayout": {
                "layers": list(layers or []),
                "assignments": dict(assignments or {}),
            }
        },
        "filters": {},
    }


async def _create_view_with_layout(session, ws_id, **cfg_kwargs):
    return await view_repo.create_view(
        session,
        _make_create_req(ws_id, config=_base_config(**cfg_kwargs)),
    )


async def test_get_overlay_none_when_absent(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    created = await _create_view_with_layout(db_session, ws.id)
    assert await view_repo.get_overlay(db_session, created.id, "br1") is None


async def test_ensure_overlay_snapshots_bare_reference_layout(db_session: AsyncSession):
    """First open snapshots the BARE referenceLayout (not the full config) into
    BOTH fork_base_layout and reference_layout; scope is the derived base."""
    ws = await _create_workspace(db_session)
    created = await _create_view_with_layout(
        db_session,
        ws.id,
        layers=[_layer("l1", "Systems")],
        assignments={"urn:a": _assign("l1")},
        entity_scope="curated",
    )

    overlay = await view_repo.ensure_overlay(db_session, created.id, "br1")

    fork = json.loads(overlay.fork_base_layout)
    ref = json.loads(overlay.reference_layout)
    # BARE layout — no 'content'/'layout'/'filters' wrappers leaked in.
    assert set(fork.keys()) == {"layers", "assignments"}
    assert fork["layers"][0]["id"] == "l1"
    assert "urn:a" in fork["assignments"]
    # effective == base on first open.
    assert ref == fork
    assert overlay.entity_scope == "curated"
    assert overlay.fork_base_entity_scope == "curated"


async def test_ensure_overlay_is_idempotent(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    created = await _create_view_with_layout(
        db_session, ws.id, layers=[_layer("l1")]
    )

    first = await view_repo.ensure_overlay(db_session, created.id, "br1")
    # Mutate so we can prove the second call returns the SAME row, not a reset.
    first.reference_layout = json.dumps({"layers": [_layer("l1"), _layer("l2")], "assignments": {}})
    await db_session.flush()

    second = await view_repo.ensure_overlay(db_session, created.id, "br1")
    assert second.view_id == first.view_id
    assert second.branch_id == first.branch_id
    assert len(json.loads(second.reference_layout)["layers"]) == 2  # not re-snapshotted

    # Exactly one overlay row for this (view, branch).
    from backend.app.db.models import ViewLayoutOverlayORM
    from sqlalchemy import select, func
    n = await db_session.execute(
        select(func.count()).where(
            ViewLayoutOverlayORM.view_id == created.id,
            ViewLayoutOverlayORM.branch_id == "br1",
        )
    )
    assert n.scalar() == 1


async def test_ensure_overlay_missing_view_raises(db_session: AsyncSession):
    with pytest.raises(ValueError, match="missing view"):
        await view_repo.ensure_overlay(db_session, "view_nope", "br1")


async def test_update_overlay_layout_writes_overlay_not_views_row(db_session: AsyncSession):
    """The draft edit lands on the overlay; the published views.config is
    untouched; the response projects the EFFECTIVE (overlay) layout."""
    ws = await _create_workspace(db_session)
    created = await _create_view_with_layout(
        db_session, ws.id, layers=[_layer("l1", "Base")]
    )

    req = ViewLayoutUpdateRequest(
        referenceLayout={
            "layers": [_layer("l1", "Base"), _layer("l2", "Draft")],
            "assignments": {"urn:d": _assign("l2")},
        },
        entityScope="curated",
    )
    resp = await view_repo.update_overlay_layout(db_session, created.id, "br1", req)

    # Response reflects the draft (effective) layout.
    resp_layers = resp.config["layout"]["referenceLayout"]["layers"]
    assert [l["id"] for l in resp_layers] == ["l1", "l2"]

    # Published base row is UNCHANGED (no leak).
    base = await view_repo.get_view(db_session, created.id)
    base_layers = base.config["layout"]["referenceLayout"]["layers"]
    assert [l["id"] for l in base_layers] == ["l1"]

    # Overlay carries the draft.
    overlay = await view_repo.get_overlay(db_session, created.id, "br1")
    assert [l["id"] for l in json.loads(overlay.reference_layout)["layers"]] == ["l1", "l2"]


async def test_update_overlay_layout_bad_layer_id_raises(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    created = await _create_view_with_layout(db_session, ws.id, layers=[_layer("l1")])

    req = ViewLayoutUpdateRequest(
        referenceLayout={
            "layers": [_layer("l1")],
            "assignments": {"urn:x": _assign("ghost_layer")},
        },
    )
    with pytest.raises(ValueError, match="unknown layerId"):
        await view_repo.update_overlay_layout(db_session, created.id, "br1", req)

    # Validation ran before any write — no overlay was created.
    assert await view_repo.get_overlay(db_session, created.id, "br1") is None


async def test_update_overlay_layout_missing_view_returns_none(db_session: AsyncSession):
    req = ViewLayoutUpdateRequest(referenceLayout={"layers": [], "assignments": {}})
    result = await view_repo.update_overlay_layout(db_session, "view_nope", "br1", req)
    assert result is None


async def test_effective_view_config_base_when_no_overlay_or_branch(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    created = await _create_view_with_layout(db_session, ws.id, layers=[_layer("l1", "Base")])
    row = (await db_session.execute(
        __import__("sqlalchemy").select(view_repo.ViewORM).where(view_repo.ViewORM.id == created.id)
    )).scalar_one()

    # No branch → base config.
    cfg_no_branch = await view_repo.effective_view_config(db_session, row, None)
    assert [l["id"] for l in cfg_no_branch["layout"]["referenceLayout"]["layers"]] == ["l1"]

    # Branch given but no overlay yet → still base config.
    cfg_no_overlay = await view_repo.effective_view_config(db_session, row, "br1")
    assert [l["id"] for l in cfg_no_overlay["layout"]["referenceLayout"]["layers"]] == ["l1"]


async def test_effective_view_config_overrides_from_overlay(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    created = await _create_view_with_layout(
        db_session, ws.id, layers=[_layer("l1", "Base")], entity_scope="all"
    )
    req = ViewLayoutUpdateRequest(
        referenceLayout={
            "layers": [_layer("l1", "Base"), _layer("l2", "Draft")],
            "assignments": {},
        },
        entityScope="curated",
    )
    await view_repo.update_overlay_layout(db_session, created.id, "br1", req)

    cfg = await view_repo.effective_view_config(db_session, created.id, "br1")
    assert [l["id"] for l in cfg["layout"]["referenceLayout"]["layers"]] == ["l1", "l2"]
    assert cfg["content"]["entityScope"] == "curated"


async def test_promote_overlay_no_overlay_returns_false(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    created = await _create_view_with_layout(db_session, ws.id, layers=[_layer("l1")])
    assert await view_repo.promote_overlay(db_session, created.id, "br1", actor=None) is False


async def test_promote_overlay_applies_create_update_delete_and_clears(db_session: AsyncSession):
    """Promote merges the draft into the published base (create + rename +
    DELETE), stamps the actor, and deletes the overlay row."""
    ws = await _create_workspace(db_session)
    await _seed_user(db_session, "usr_merger", first="Mer", last="Ger")
    created = await _create_view_with_layout(
        db_session,
        ws.id,
        layers=[_layer("l1", "Keep"), _layer("l2", "DeleteMe")],
        assignments={"urn:a": _assign("l1"), "urn:b": _assign("l2")},
    )

    # Draft: rename l1, DELETE l2 (and its assignment), ADD l3.
    req = ViewLayoutUpdateRequest(
        referenceLayout={
            "layers": [_layer("l1", "Renamed"), _layer("l3", "New")],
            "assignments": {"urn:a": _assign("l1"), "urn:c": _assign("l3")},
        },
    )
    await view_repo.update_overlay_layout(db_session, created.id, "br1", req)

    promoted = await view_repo.promote_overlay(
        db_session, created.id, "br1", actor="usr_merger"
    )
    assert promoted is True

    base = await view_repo.get_view(db_session, created.id)
    layers = base.config["layout"]["referenceLayout"]["layers"]
    assignments = base.config["layout"]["referenceLayout"]["assignments"]
    assert [l["id"] for l in layers] == ["l1", "l3"]     # l2 DELETED, l3 CREATED
    assert layers[0]["name"] == "Renamed"                # UPDATE applied
    assert "urn:b" not in assignments                    # deleted layer's assignment gone
    assert "urn:c" in assignments
    assert base.updated_by == "usr_merger"               # actor stamped

    # Overlay row is gone.
    assert await view_repo.get_overlay(db_session, created.id, "br1") is None


async def test_promote_overlay_preserves_display_rules(db_session: AsyncSession):
    """Regression: promote must NOT drop ``referenceLayout.displayRules``.

    ``merge_layout_3way`` returns only {layers, assignments}; promote_overlay
    re-attaches the 3-way-merged displayRules (draft wins). Before the fix the
    published base lost its displayRules on every merge."""
    ws = await _create_workspace(db_session)
    created = await _create_view_with_layout(db_session, ws.id, layers=[_layer("l1", "Base")])

    # Publish a base displayRules array (the fork-point the overlay snapshots).
    await view_repo.update_view_layout(
        db_session, created.id,
        ViewLayoutUpdateRequest(
            referenceLayout={"layers": [_layer("l1", "Base")], "assignments": {}},
            displayRules=[{"id": "r_base", "op": "hide"}],
        ),
    )

    # Draft: add a layer AND change the displayRules (frontend re-sends them).
    await view_repo.update_overlay_layout(
        db_session, created.id, "br1",
        ViewLayoutUpdateRequest(
            referenceLayout={
                "layers": [_layer("l1", "Base"), _layer("l2", "Draft")],
                "assignments": {},
            },
            displayRules=[{"id": "r_draft", "op": "color"}],
        ),
    )

    assert await view_repo.promote_overlay(db_session, created.id, "br1", actor=None) is True

    ref = (await view_repo.get_view(db_session, created.id)).config["layout"]["referenceLayout"]
    assert [l["id"] for l in ref["layers"]] == ["l1", "l2"]          # layers still merged
    assert ref["displayRules"] == [{"id": "r_draft", "op": "color"}]  # draft's rules won, not dropped


async def test_promote_overlays_for_branch_counts_and_drops(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    v1 = await _create_view_with_layout(db_session, ws.id, layers=[_layer("l1")])
    v2 = await _create_view_with_layout(db_session, ws.id, layers=[_layer("l1")])
    await view_repo.ensure_overlay(db_session, v1.id, "shared_branch")
    await view_repo.ensure_overlay(db_session, v2.id, "shared_branch")

    count = await view_repo.promote_overlays_for_branch(
        db_session, "shared_branch", actor=None
    )
    assert count == 2
    assert await view_repo.get_overlay(db_session, v1.id, "shared_branch") is None
    assert await view_repo.get_overlay(db_session, v2.id, "shared_branch") is None


async def test_drop_overlays_for_branch(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    v1 = await _create_view_with_layout(db_session, ws.id, layers=[_layer("l1")])
    v2 = await _create_view_with_layout(db_session, ws.id, layers=[_layer("l1")])
    await view_repo.ensure_overlay(db_session, v1.id, "br_discard")
    await view_repo.ensure_overlay(db_session, v2.id, "br_discard")
    # An overlay on a different branch must survive the drop.
    await view_repo.ensure_overlay(db_session, v1.id, "br_keep")

    dropped = await view_repo.drop_overlays_for_branch(db_session, "br_discard")
    assert dropped == 2
    assert await view_repo.get_overlay(db_session, v1.id, "br_discard") is None
    assert await view_repo.get_overlay(db_session, v2.id, "br_discard") is None
    assert await view_repo.get_overlay(db_session, v1.id, "br_keep") is not None


async def test_overlay_cascades_on_view_hard_delete():
    """ON DELETE CASCADE removes a view's overlays when the view is hard-deleted.

    Postgres enforces this natively (verified live during the migration). The
    shared SQLite test engine leaves FK enforcement off, so this test spins up
    a dedicated in-memory engine with ``PRAGMA foreign_keys=ON`` to exercise the
    cascade behaviourally."""
    engine = create_async_engine(
        "sqlite+aiosqlite://", connect_args={"check_same_thread": False}
    )

    @event.listens_for(engine.sync_engine, "connect")
    def _on_connect(dbapi_conn, _rec):  # noqa: ANN001
        # Mirror the shared conftest engine's aggregation attach, and turn on
        # FK enforcement so ON DELETE CASCADE actually fires under SQLite.
        dbapi_conn.execute("ATTACH DATABASE ':memory:' AS aggregation")
        dbapi_conn.execute("PRAGMA foreign_keys=ON")

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    Session = async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with Session() as session:
            ws = await _create_workspace(session)
            created = await _create_view_with_layout(session, ws.id, layers=[_layer("l1")])
            await view_repo.ensure_overlay(session, created.id, "br1")
            await session.commit()
            assert await view_repo.get_overlay(session, created.id, "br1") is not None

            await view_repo.permanently_delete_view(session, created.id)
            await session.commit()

            assert await view_repo.get_overlay(session, created.id, "br1") is None
    finally:
        await engine.dispose()


# ---------------------------------------------------------------------------
# Readable-clause scoping (view-sharing rework)
# ---------------------------------------------------------------------------
#
# The repo functions take a pre-rendered SQL clause (from
# view_access.readable_views_clause); scope construction itself is
# covered by test_view_access_matrix. Here we prove every list/aggregate
# path actually applies the clause — and that pagination totals are
# computed AFTER it.

from backend.app.services import view_access as _va  # noqa: E402


def _member_scope(user_id: str, member_ws: tuple, granted: tuple = ()):
    return _va.ViewReadScope(
        authenticated=True,
        unrestricted=False,
        org_viewer=False,
        user_id=user_id,
        member_ws_ids=member_ws,
        admin_ws_ids=(),
        granted_view_ids=granted,
    )


async def _seed_scoped_population(db_session):
    """ws_a: alice-private (tag 'secret'), workspace-tier, enterprise;
    ws_b: workspace-tier (the cross-workspace leak fixture)."""
    ws_a = await _create_workspace(db_session, name="WS A")
    ws_b = await _create_workspace(db_session, name="WS B")
    mk = view_repo.create_view
    private_a = await mk(db_session, _make_create_req(
        ws_a.id, name="alice-private", visibility="private", tags=["secret"],
    ), user_id="usr_alice")
    workspace_a = await mk(db_session, _make_create_req(
        ws_a.id, name="ws-a-shared", visibility="workspace",
    ), user_id="usr_alice")
    enterprise_a = await mk(db_session, _make_create_req(
        ws_a.id, name="ws-a-public", visibility="enterprise",
    ), user_id="usr_alice")
    workspace_b = await mk(db_session, _make_create_req(
        ws_b.id, name="ws-b-shared", visibility="workspace",
    ), user_id="usr_carol")
    await db_session.commit()
    return ws_a, ws_b, private_a, workspace_a, enterprise_a, workspace_b


async def test_list_views_filtered_scoped_by_readable_clause(db_session):
    ws_a, _ws_b, private_a, workspace_a, enterprise_a, workspace_b = (
        await _seed_scoped_population(db_session)
    )
    scope = _member_scope("usr_bob", (ws_a.id,))
    resp = await view_repo.list_views_filtered(
        db_session, user_id="usr_bob",
        readable=_va.readable_views_clause(scope),
    )
    ids = {v.id for v in resp.items}
    assert ids == {workspace_a.id, enterprise_a.id}
    # Pagination totals are computed after scoping, not before.
    assert resp.total == 2


async def test_list_views_filtered_pagination_after_scoping(db_session):
    ws_a, *_ = await _seed_scoped_population(db_session)
    scope = _member_scope("usr_bob", (ws_a.id,))
    page = await view_repo.list_views_filtered(
        db_session, user_id="usr_bob", limit=1, offset=0,
        readable=_va.readable_views_clause(scope),
    )
    assert page.total == 2
    assert page.has_more is True
    assert page.next_offset == 1
    assert len(page.items) == 1
    page2 = await view_repo.list_views_filtered(
        db_session, user_id="usr_bob", limit=1, offset=1,
        readable=_va.readable_views_clause(scope),
    )
    assert page2.has_more is False
    assert len(page2.items) == 1


async def test_get_view_stats_scoped_matches_list_total(db_session):
    ws_a, *_ = await _seed_scoped_population(db_session)
    scope = _member_scope("usr_bob", (ws_a.id,))
    clause = _va.readable_views_clause(scope)
    stats = await view_repo.get_view_stats(
        db_session, user_id="usr_bob", readable=clause,
    )
    listed = await view_repo.list_views_filtered(
        db_session, user_id="usr_bob", readable=clause,
    )
    assert stats.total == listed.total == 2


async def test_get_view_facets_scoped(db_session):
    ws_a, *_ = await _seed_scoped_population(db_session)
    scope = _member_scope("usr_bob", (ws_a.id,))
    facets = await view_repo.get_view_facets(
        db_session, readable=_va.readable_views_clause(scope),
    )
    # The 'secret' tag lives only on alice's private view.
    assert all(t.value != "secret" for t in facets.tags)
    # usr_carol only created the unreadable ws_b view.
    assert all(c.user_id != "usr_carol" for c in facets.creators)
    # alice's readable views keep her in the creator facet.
    assert any(c.user_id == "usr_alice" for c in facets.creators)


async def test_list_popular_views_scoped(db_session):
    ws_a, _ws_b, private_a, workspace_a, enterprise_a, workspace_b = (
        await _seed_scoped_population(db_session)
    )
    for v in (private_a, workspace_a, enterprise_a, workspace_b):
        await view_repo.favourite_view(db_session, v.id, "usr_someone")
    await db_session.commit()
    scope = _member_scope("usr_bob", (ws_a.id,))
    popular = await view_repo.list_popular_views(
        db_session, user_id="usr_bob",
        readable=_va.readable_views_clause(scope),
    )
    ids = {v.id for v in popular}
    # The ws_b workspace-tier view must NOT leak cross-workspace, and
    # alice's private view must not surface for bob.
    assert ids == {workspace_a.id, enterprise_a.id}


async def test_list_recent_views_scoped_drops_revoked(db_session):
    ws_a, _ws_b, private_a, workspace_a, *_ = (
        await _seed_scoped_population(db_session)
    )
    # bob visited both while he could; his read reach today excludes the
    # private one.
    await view_repo.record_view_visit(db_session, private_a.id, "usr_bob")
    await view_repo.record_view_visit(db_session, workspace_a.id, "usr_bob")
    await db_session.commit()
    scope = _member_scope("usr_bob", (ws_a.id,))
    recents = await view_repo.list_recent_views(
        db_session, "usr_bob", readable=_va.readable_views_clause(scope),
    )
    ids = {r.viewId for r in recents}
    assert ids == {workspace_a.id}


async def test_shared_with_me_filter_kwargs(db_session):
    """category=shared-with-me maps to ids_in (granted views) plus
    created_by_not (exclude own) at the endpoint layer; the repo just
    honours the two generic kwargs."""
    ws_a, _ws_b, private_a, workspace_a, enterprise_a, workspace_b = (
        await _seed_scoped_population(db_session)
    )
    scope = _member_scope(
        "usr_bob", (ws_a.id,), granted=(workspace_b.id, enterprise_a.id),
    )
    resp = await view_repo.list_views_filtered(
        db_session, user_id="usr_bob",
        readable=_va.readable_views_clause(scope),
        ids_in=[workspace_b.id, enterprise_a.id],
        created_by_not="usr_bob",
    )
    assert {v.id for v in resp.items} == {workspace_b.id, enterprise_a.id}
    resp_own_excluded = await view_repo.list_views_filtered(
        db_session, user_id="usr_alice",
        readable=_va.readable_views_clause(
            _member_scope("usr_alice", (ws_a.id,), granted=(enterprise_a.id,)),
        ),
        ids_in=[enterprise_a.id],
        created_by_not="usr_alice",
    )
    # alice created it — shared-with-me must not echo her own view back.
    assert resp_own_excluded.items == []
