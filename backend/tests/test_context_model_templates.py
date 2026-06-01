"""
Tests for the template-management surface added on top of
backend.app.db.repositories.context_model_repo.

Covers:
  * Soft delete + ?permanent=true hard delete.
  * duplicate_template deep-copies config + zeros counters.
  * instantiate_template increments instantiation_count and sets last_used_at.
  * get_usage_stats aggregates instances by workspace.
  * list_templates scope/search/sort/tag filters.
"""
import json

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.repositories import context_model_repo
from backend.app.db.models import WorkspaceORM
from backend.common.models.management import ContextModelCreateRequest


# ── helpers ───────────────────────────────────────────────────────────

async def _seed_workspace(session: AsyncSession, ws_id="ws_tpl") -> str:
    session.add(WorkspaceORM(id=ws_id, name=f"Workspace {ws_id}"))
    await session.flush()
    return ws_id


def _make_tpl(**overrides) -> ContextModelCreateRequest:
    defaults = dict(
        name="Tpl",
        description="A template",
        is_template=True,
        category="data-engineering",
        layers_config=[{"id": "L1", "name": "Source", "entityTypes": ["Dataset"], "order": 0}],
        scope_filter={"rootTypes": ["Database"]},
        instance_assignments={},
        icon="Workflow",
        accent_color="#6366f1",
        maintainer="data-platform-team",
        about_markdown="# Why\nUse this to model ELT flows.",
        tags=["etl", "lineage"],
        visibility="enterprise",
    )
    defaults.update(overrides)
    return ContextModelCreateRequest(**defaults)


# ── create with template metadata ─────────────────────────────────────

async def test_create_template_persists_metadata(db_session: AsyncSession):
    resp = await context_model_repo.create_context_model(
        db_session, _make_tpl(), created_by="alice@example.com",
    )
    assert resp.is_template is True
    assert resp.icon == "Workflow"
    assert resp.accent_color == "#6366f1"
    assert resp.maintainer == "data-platform-team"
    assert resp.about_markdown.startswith("# Why")
    assert resp.tags == ["etl", "lineage"]
    assert resp.visibility == "enterprise"
    assert resp.instantiation_count == 0
    assert resp.last_used_at is None
    assert resp.created_by == "alice@example.com"


# ── list_templates filters ────────────────────────────────────────────

async def test_list_templates_scope_global(db_session: AsyncSession):
    ws = await _seed_workspace(db_session, "ws_scope_a")
    await context_model_repo.create_context_model(db_session, _make_tpl(name="Global"))
    await context_model_repo.create_context_model(
        db_session, _make_tpl(name="WS"), workspace_id=ws,
    )

    result = await context_model_repo.list_templates(db_session, scope="global")
    names = [r.name for r in result]
    assert names == ["Global"]


async def test_list_templates_scope_all_includes_workspace_and_global(db_session: AsyncSession):
    ws = await _seed_workspace(db_session, "ws_scope_b")
    other = await _seed_workspace(db_session, "ws_scope_b_other")
    await context_model_repo.create_context_model(db_session, _make_tpl(name="Global"))
    await context_model_repo.create_context_model(
        db_session, _make_tpl(name="Mine"), workspace_id=ws,
    )
    await context_model_repo.create_context_model(
        db_session, _make_tpl(name="Theirs"), workspace_id=other,
    )

    result = await context_model_repo.list_templates(
        db_session, scope="all", workspace_id=ws,
    )
    names = sorted(r.name for r in result)
    assert names == ["Global", "Mine"]  # other workspace's template hidden


async def test_list_templates_sort_popular(db_session: AsyncSession):
    a = await context_model_repo.create_context_model(db_session, _make_tpl(name="A"))
    b = await context_model_repo.create_context_model(db_session, _make_tpl(name="B"))
    ws = await _seed_workspace(db_session, "ws_pop")

    # Instantiate B twice — should bubble to top under "popular".
    await context_model_repo.instantiate_template(db_session, b.id, ws, "inst1")
    await context_model_repo.instantiate_template(db_session, b.id, ws, "inst2")
    await context_model_repo.instantiate_template(db_session, a.id, ws, "inst-a")

    result = await context_model_repo.list_templates(db_session, sort="popular")
    assert [r.name for r in result] == ["B", "A"]


async def test_list_templates_search_matches_name_and_description(db_session: AsyncSession):
    await context_model_repo.create_context_model(
        db_session, _make_tpl(name="Lineage Map", description="medallion"),
    )
    await context_model_repo.create_context_model(
        db_session, _make_tpl(name="Bronze", description="Tracks data lineage end to end"),
    )
    await context_model_repo.create_context_model(
        db_session, _make_tpl(name="Unrelated", description="nothing here"),
    )

    result = await context_model_repo.list_templates(db_session, search="lineage")
    names = sorted(r.name for r in result)
    assert names == ["Bronze", "Lineage Map"]


async def test_list_templates_filter_tag(db_session: AsyncSession):
    await context_model_repo.create_context_model(db_session, _make_tpl(name="A", tags=["etl"]))
    await context_model_repo.create_context_model(db_session, _make_tpl(name="B", tags=["bi"]))
    result = await context_model_repo.list_templates(db_session, tag="bi")
    assert [r.name for r in result] == ["B"]


# ── soft delete ──────────────────────────────────────────────────────

async def test_soft_delete_hides_from_default_list(db_session: AsyncSession):
    tpl = await context_model_repo.create_context_model(db_session, _make_tpl(name="Doomed"))
    ok = await context_model_repo.soft_delete_context_model(db_session, tpl.id)
    assert ok is True

    visible = await context_model_repo.list_templates(db_session)
    assert tpl.id not in [r.id for r in visible]

    with_deleted = await context_model_repo.list_templates(db_session, include_deleted=True)
    found = next((r for r in with_deleted if r.id == tpl.id), None)
    assert found is not None
    assert found.deleted_at is not None


async def test_soft_delete_is_idempotent(db_session: AsyncSession):
    tpl = await context_model_repo.create_context_model(db_session, _make_tpl())
    assert await context_model_repo.soft_delete_context_model(db_session, tpl.id) is True
    # Second call is a no-op success.
    assert await context_model_repo.soft_delete_context_model(db_session, tpl.id) is True


async def test_hard_delete_removes_row(db_session: AsyncSession):
    tpl = await context_model_repo.create_context_model(db_session, _make_tpl())
    assert await context_model_repo.delete_context_model(db_session, tpl.id) is True
    assert await context_model_repo.get_context_model(db_session, tpl.id) is None


# ── duplicate ───────────────────────────────────────────────────────

async def test_duplicate_template_copies_config_and_resets_counters(db_session: AsyncSession):
    ws = await _seed_workspace(db_session, "ws_dup")
    src = await context_model_repo.create_context_model(db_session, _make_tpl(name="Src"))
    # Boost the source's counter so we can prove duplicate doesn't inherit it.
    await context_model_repo.instantiate_template(db_session, src.id, ws, "x")
    src_after = await context_model_repo.get_context_model(db_session, src.id)
    assert src_after.instantiation_count == 1

    dup = await context_model_repo.duplicate_template(
        db_session, src.id, "Copy of Src", workspace_id=ws,
    )
    assert dup is not None
    assert dup.name == "Copy of Src"
    assert dup.id != src.id
    assert dup.workspace_id == ws
    assert dup.is_template is True
    assert dup.layers_config == src.layers_config
    assert dup.scope_filter == src.scope_filter
    assert dup.icon == src.icon
    assert dup.accent_color == src.accent_color
    assert dup.tags == src.tags
    # Counters reset.
    assert dup.instantiation_count == 0
    assert dup.last_used_at is None
    assert dup.is_pinned is False


async def test_duplicate_returns_none_for_non_template(db_session: AsyncSession):
    ws = await _seed_workspace(db_session, "ws_dup_nt")
    inst = await context_model_repo.create_context_model(
        db_session,
        ContextModelCreateRequest(name="Instance", layers_config=[]),
        workspace_id=ws,
    )
    assert await context_model_repo.duplicate_template(db_session, inst.id, "x") is None


# ── instantiate side effects ────────────────────────────────────────

async def test_instantiate_template_increments_counter_and_sets_last_used(db_session: AsyncSession):
    ws = await _seed_workspace(db_session, "ws_inst")
    tpl = await context_model_repo.create_context_model(db_session, _make_tpl())
    assert tpl.instantiation_count == 0
    assert tpl.last_used_at is None

    inst1 = await context_model_repo.instantiate_template(db_session, tpl.id, ws, "i1")
    inst2 = await context_model_repo.instantiate_template(db_session, tpl.id, ws, "i2")

    refreshed = await context_model_repo.get_context_model(db_session, tpl.id)
    assert refreshed.instantiation_count == 2
    assert refreshed.last_used_at is not None
    # New instances carry a back-pointer to the source template.
    assert inst1.instantiated_from_id == tpl.id
    assert inst2.instantiated_from_id == tpl.id


# ── usage stats ─────────────────────────────────────────────────────

async def test_get_usage_stats_groups_by_workspace(db_session: AsyncSession):
    ws_a = await _seed_workspace(db_session, "ws_use_a")
    ws_b = await _seed_workspace(db_session, "ws_use_b")
    tpl = await context_model_repo.create_context_model(db_session, _make_tpl())

    await context_model_repo.instantiate_template(db_session, tpl.id, ws_a, "n1")
    await context_model_repo.instantiate_template(db_session, tpl.id, ws_a, "n2")
    await context_model_repo.instantiate_template(db_session, tpl.id, ws_b, "n3")

    stats = await context_model_repo.get_usage_stats(db_session, tpl.id)
    assert stats is not None
    assert stats.instantiation_count == 3
    assert stats.instances_by_workspace == {ws_a: 2, ws_b: 1}


async def test_get_usage_stats_excludes_soft_deleted_instances(db_session: AsyncSession):
    ws = await _seed_workspace(db_session, "ws_use_sd")
    tpl = await context_model_repo.create_context_model(db_session, _make_tpl())
    inst = await context_model_repo.instantiate_template(db_session, tpl.id, ws, "drop-me")
    await context_model_repo.instantiate_template(db_session, tpl.id, ws, "keep-me")

    await context_model_repo.soft_delete_context_model(db_session, inst.id)

    stats = await context_model_repo.get_usage_stats(db_session, tpl.id)
    # Counter is the lifetime count (not adjusted for deletes), but the
    # per-workspace breakdown excludes soft-deleted live instances.
    assert stats.instantiation_count == 2
    assert stats.instances_by_workspace == {ws: 1}


# ── update writes metadata ──────────────────────────────────────────

async def test_update_template_metadata_partial(db_session: AsyncSession):
    tpl = await context_model_repo.create_context_model(db_session, _make_tpl())
    from backend.common.models.management import ContextModelUpdateRequest

    updated = await context_model_repo.update_context_model(
        db_session,
        tpl.id,
        ContextModelUpdateRequest(
            icon="Database",
            accent_color="#10b981",
            tags=["new", "tags"],
            is_pinned=True,
        ),
    )
    assert updated.icon == "Database"
    assert updated.accent_color == "#10b981"
    assert updated.tags == ["new", "tags"]
    assert updated.is_pinned is True
    # Untouched fields stay the same.
    assert updated.maintainer == "data-platform-team"


# ── soft-deleted templates ignored by default list ─────────────────

async def test_list_context_models_excludes_soft_deleted(db_session: AsyncSession):
    ws = await _seed_workspace(db_session, "ws_lcm_sd")
    keep = await context_model_repo.create_context_model(
        db_session, ContextModelCreateRequest(name="Keep", layers_config=[]),
        workspace_id=ws,
    )
    drop = await context_model_repo.create_context_model(
        db_session, ContextModelCreateRequest(name="Drop", layers_config=[]),
        workspace_id=ws,
    )
    await context_model_repo.soft_delete_context_model(db_session, drop.id)

    visible = await context_model_repo.list_context_models(db_session, workspace_id=ws)
    assert [v.id for v in visible] == [keep.id]
