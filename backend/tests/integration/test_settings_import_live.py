"""The import of every setting saved before the settings store (``20261116_1100_settings_import``),
on a database built at the revision before the store and seeded with a value in every old place:
what it copies, with who and when, its marker, that a second run changes nothing, the graph store
in a database of its own (the worker's start-up import), and — with the real registry — that every
effective value is the one the old storage resolves to.

Needs ``GRAPHVER_E2E=1``, ``MANAGEMENT_DB_URL`` (a role that may create databases) and the bus
Redis.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any, Dict

import pytest
from sqlalchemy import create_engine, select, text

from backend.app.db.models import PlatformSettingsORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.services.settings import legacy, store
from backend.tests.integration.test_settings_store_live import (  # noqa: F401 — fixtures
    alembic_stamp, data_source, db_url, engines_at, graph, graph_store_tables, provider, query,
    redis_bus, scratch_database, seed, upgrade_cli, workspace)
from backend.tests.test_settings_resolver import REGISTRY, WHYS

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres and Redis")

PREVIOUS = "20261113_1400_gv_ps_candidate"
STORE = "20261116_1000_setting_values"
DOMAIN = "versioned-graphs"
BUILDS_AT = datetime(2026, 11, 13, 10, 0, tzinfo=timezone.utc)
RESIDENCY_AT = datetime(2026, 11, 14, 9, 30, tzinfo=timezone.utc)

#: What the old storage holds, as the store holds it once copied.
COPIED = {
    ("reads.mode", "platform", ""): "in_place",
    ("builds.copyMaxBytes", "platform", ""): "unlimited",          # an old 0: no limit
    ("builds.perWorker", "platform", ""): 3,
    ("updates.pacingRatio", "platform", ""): 0.5,
    ("residency.autoUnload", "platform", ""): False,
    ("residency.class", "platform", ""): "coldline",
    ("residency.unloadStartPct", "platform", ""): 85,
    ("residency.unloadStopPct", "platform", ""): 75,
    ("drafts.keepClosedDays", "platform", ""): "forever",          # an old 0: for good
    ("drafts.levels", "workspace", "ws_a"): "public_only",
    ("drafts.selfMerge", "workspace", "ws_a"): False,
    ("drafts.defaultVisibility", "graph", "ds_a"): "private",
    ("imports.identifier", "graph", "ds_a"): "prop.code,urn",
    ("imports.guardMinLive", "graph", "ds_a"): 500,
    ("imports.guardDeleteShare", "graph", "ds_a"): 0.25,
    ("imports.minMatchShare", "graph", "ds_a"): 0.1,
    ("drafts.selfApproval", "graph", "ds_c"): False,
}
#: The graphs' own, from the graph store: graph_b's class is the platform's, so not copied.
GRAPH_VALUES = {
    ("reads.mode", "graph", "ds_a"): "beside",
    ("residency.class", "graph", "ds_a"): "always",
    ("reads.mode", "graph", "ds_c"): "latest",
    ("residency.class", "graph", "ds_c"): "standard",
}


def _seed_old_storage(name: str, graph_store: str) -> None:
    seed(name,
         PlatformSettingsORM(
             id=1, gv_build_policy=json.dumps({
                 "values": {"readMode": "in_place", "copyMaxBytes": 0, "buildConcurrency": 3,
                            "pacingRatio": 0.5},
                 "updatedBy": "usr_builds", "updatedAt": BUILDS_AT.isoformat()}),
             gv_eviction_enabled=False, gv_default_residency="coldline", gv_high_water_pct=85,
             gv_low_water_pct=75, gv_policy_updated_by="usr_residency",
             gv_policy_updated_at=RESIDENCY_AT.isoformat(), gv_draft_retention_days=0,
             updated_by="usr_someone_else"),
         workspace("ws_a", draft_levels="public_only", review_self_merge=False),
         workspace("ws_b"),
         provider(),
         data_source("ds_a", "ws_a", draft_default_visibility="private",
                     import_identifier="prop.code,urn", import_replace_min_live=500,
                     import_replace_delete_fraction=0.25, import_replace_min_match_fraction=0.1),
         data_source("ds_b", "ws_b", import_identifier=""),                  # "" is not set
         data_source("ds_c", "ws_b", import_identifier="inherit", review_self_approval=False),
         # A fork's are copies of its parent's: never its own.
         data_source("dsfork_a", "ws_a", fork_of="ds_a", draft_levels="private_only",
                     import_identifier="urn"))
    seed(graph_store,
         *graph("graph_a", "ds_a", "ws_a", read_mode="beside", residency="always"),
         *graph("graph_b", "ds_b", "ws_b", residency="coldline"),
         *graph("graph_c", "ds_c", "ws_b", read_mode="latest", residency="standard"),
         *graph("graph_fa", "dsfork_a", "ws_a", fork_of="graph_a", read_mode="latest",
                residency="coldline"))


def _before_the_store(name: str) -> None:
    """Database ``name`` as the release before the store left it: built, then taken back."""
    upgrade_cli(name, "upgrade")
    upgrade_cli(name, "downgrade", "--revision", PREVIOUS)
    assert query(name, "SELECT to_regclass('setting_values') IS NULL")[0][0] is True


def _values(name: str) -> Dict[Any, Any]:
    return {(r.key, r.scope, r.scope_id): r.value for r in query(
        name, "SELECT key, scope, scope_id, value FROM setting_values WHERE domain = :d",
        d=DOMAIN)}


def _markers(name: str) -> Dict[str, Any]:
    return {r.name: (r.at, r.detail) for r in query(name, "SELECT name, at, detail "
                                                          "FROM settings_imports")}


def test_the_import_copies_every_saved_value_once_with_who_and_when(monkeypatch):
    monkeypatch.delenv("GRAPHVER_DB_URL", raising=False)
    with scratch_database("settings_import") as name:
        _before_the_store(name)
        graph_store_tables(name)
        _seed_old_storage(name, name)
        upgrade_cli(name, "upgrade")
        assert _values(name) == {**COPIED, **GRAPH_VALUES}
        who = {(r.key, r.scope_id): (r.updated_by, r.updated_at, r.version) for r in query(
            name, "SELECT key, scope_id, updated_by, updated_at, version FROM setting_values")}
        assert who[("reads.mode", "")] == ("usr_builds", BUILDS_AT, 1)
        assert who[("builds.perWorker", "")] == ("usr_builds", BUILDS_AT, 1)
        assert who[("residency.class", "")] == ("usr_residency", RESIDENCY_AT, 1)
        assert who[("drafts.keepClosedDays", "")][0] is None        # no who of its own
        assert who[("drafts.levels", "ws_a")][0] is None
        markers = _markers(name)
        assert markers["legacy"][1] == {"values": {"platform": 9, "workspace": 2, "graph": 10},
                                        "inserted": 21, "graphValues": "copied"}
        assert markers["legacy_graph"][1] == {"by": "migration"}
        history = query(name, "SELECT change_set, key, before_value, after_value, actor, source, "
                              "reason FROM setting_changes")
        assert len(history) == 21 and len({h.change_set for h in history}) == 1
        assert {(h.source, h.before_value) for h in history} == {("migration", None)}
        assert {h.after_value for h in history if h.key == "residency.class"} == {
            "coldline", "always", "standard"}

        # A save after the import, then the import again: nothing it copied is copied twice,
        # and nothing saved since is overwritten.
        last_rev = query(name, "SELECT max(rev) FROM setting_values")[0][0]
        _save_after_the_import(name)
        alembic_stamp(name, STORE)
        upgrade_cli(name, "upgrade")
        assert _values(name) == {**COPIED, **GRAPH_VALUES, ("reads.mode", "platform", ""): "latest"}
        assert len(query(name, "SELECT 1 FROM setting_changes")) == 21
        assert _markers(name) == markers
        assert query(name, "SELECT max(rev) FROM setting_values")[0][0] == last_rev + 1
        assert "Schema matches the ORM" in upgrade_cli(name, "verify-schema")


def _save_after_the_import(name: str) -> None:
    """A save of the platform's read mode, as the store makes it."""
    engine = create_engine(db_url(name, "psycopg2"))
    with engine.begin() as conn:
        conn.execute(text("UPDATE setting_values SET value = '\"latest\"', version = 2, "
                          "rev = nextval('setting_values_rev_seq') "
                          "WHERE key = 'reads.mode' AND scope = 'platform'"))
    engine.dispose()


async def test_with_the_graph_store_apart_the_worker_copies_its_values_at_start_up(
        engines_at, redis_bus, monkeypatch):  # noqa: F811 — fixtures
    with scratch_database("settings_mgmt") as name, scratch_database("settings_gv") as apart:
        _before_the_store(name)
        graph_store_tables(apart)
        _seed_old_storage(name, apart)
        upgrade_cli(name, "upgrade", graph_store=apart)
        assert _values(name) == COPIED                        # the graphs' are out of reach
        markers = _markers(name)
        assert markers["legacy"][1]["graphValues"] == "pending" and "legacy_graph" not in markers

        engines_at(name, apart)
        monkeypatch.setattr(legacy, "registry",
                            lambda: SimpleNamespace(SETTINGS=REGISTRY, WHY=WHYS, DOMAIN=DOMAIN))
        before = int(await redis_bus.get(store.generation_key(DOMAIN)) or 0)
        assert await legacy.import_graph_values() == 4
        assert _values(name) == {**COPIED, **GRAPH_VALUES}
        assert _markers(name)["legacy_graph"][1] == {"by": "start-up", "values": 4,
                                                     "inserted": 4}
        assert int(await redis_bus.get(store.generation_key(DOMAIN))) == before + 1
        assert {r.source for r in query(name, "SELECT source FROM setting_changes WHERE key "
                                              "IN ('reads.mode', 'residency.class') AND "
                                              "scope = 'graph'")} == {"migration"}
        assert await legacy.import_graph_values() is None    # once
        assert len(query(name, "SELECT 1 FROM setting_changes")) == 21


async def test_the_start_up_import_waits_for_the_import_migration(
        engines_at, monkeypatch):  # noqa: F811 — a fixture
    """A fresh install (no import ran: nothing was saved before) copies nothing."""
    with scratch_database("settings_fresh") as name:
        upgrade_cli(name, "upgrade")
        engines_at(name)
        monkeypatch.setattr(legacy, "registry",
                            lambda: SimpleNamespace(SETTINGS=REGISTRY, WHY=WHYS, DOMAIN=DOMAIN))
        assert await legacy.import_graph_values() is None
        assert _markers(name) == {}


# ── With the real registry ────────────────────────────────────────────────────────────────────────
async def test_every_effective_value_is_the_one_the_old_storage_resolves_to(
        engines_at, monkeypatch):  # noqa: F811 — a fixture
    """After the import, the resolver over the store gives, for every setting at the platform,
    each workspace and each graph, what the old policies give over the old storage."""
    reg = pytest.importorskip("backend.app.config.versioned_graph_settings")
    from backend.app.db.engine import get_async_session
    from backend.app.services import drafts_policy, import_settings
    from backend.app.services.settings import resolver
    from backend.app.services.settings.snapshot import env_reader
    from backend.app.services.versioning import build_policy, config, draft_retention
    from backend.app.services.versioning import db as gvdb
    from backend.app.services.versioning import residency_policy
    from backend.app.services.versioning.models import GraphORM, ProjectionStateORM

    monkeypatch.delenv("GRAPHVER_DB_URL", raising=False)
    with scratch_database("settings_parity") as name:
        _before_the_store(name)
        graph_store_tables(name)
        _seed_old_storage(name, name)
        upgrade_cli(name, "upgrade")
        engines_at(name)
        async with get_async_session() as s:
            rows = await store.read_domain(s, reg.DOMAIN)
            platform = await s.get(PlatformSettingsORM, 1)
            workspaces = {w.id: w for w in (await s.execute(select(WorkspaceORM))).scalars()}
            sources = {d.id: d for d in (await s.execute(select(WorkspaceDataSourceORM).where(
                WorkspaceDataSourceORM.fork_of_data_source_id.is_(None)))).scalars()}
        async with gvdb.graphver_session() as s:
            states = {ds: (mode, cls) for ds, mode, cls in (await s.execute(
                select(GraphORM.data_source_id, ProjectionStateORM.read_mode,
                       ProjectionStateORM.residency)
                .join(ProjectionStateORM, ProjectionStateORM.graph_id == GraphORM.id)
                .where(GraphORM.fork_parent_graph_id.is_(None)))).all()}

    features = {req.feature for s in reg.SETTINGS
                for req in (*s.requires, *(r for c in s.choices for r in c.requires))
                if req.feature}
    ctx = resolver.context(reg.SETTINGS, rows, switches=dict.fromkeys(features, True),
                           env=env_reader(reg.SETTINGS, reg.DEPLOYMENT), why=reg.WHY)
    policy = build_policy.effective(build_policy.saved_values(platform))
    residency = residency_policy.effective(residency_policy.saved_values(platform))
    drafts = {column: api for column, api, _default in drafts_policy.FIELDS}
    imports = {column: api for column, api, _default in import_settings.FIELDS}

    def at_platform(s) -> Any:
        old = s.legacy
        if old is not None and old.build_policy:
            return policy[old.build_policy]
        if old is not None and old.residency_policy:
            return getattr(residency, residency_policy.WIRE_NAMES[old.residency_policy])
        if old is not None and old.platform_column == "gv_draft_retention_days":
            return draft_retention.effective(platform.gv_draft_retention_days)
        if old is not None and old.data_source_column in imports:
            return import_settings.platform()[imports[old.data_source_column]]
        if old is not None and old.data_source_column in drafts:
            return drafts_policy.resolve().as_dict()[drafts[old.data_source_column]]
        return getattr(config, s.default.attr) if s.default.attr else s.default.code

    wrong, hand_made = [], []

    def check(s, target, old_value: Any) -> None:
        want, got = resolver.decode(s, old_value), resolver.effective(ctx, s.key, target)
        if resolver.value_error(s, want) is not None:
            # Not a value of the setting: only a hand edit stores one (the old endpoint refuses ""
            # and clears "inherit"), and the old readers passed it through as it was.
            hand_made.append((s.key, target.graph_id, want, got))
        elif want != got or isinstance(want, bool) != isinstance(got, bool):
            wrong.append((s.key, target.scope, target.workspace_id, target.graph_id, want, got))

    for s in reg.SETTINGS:
        check(s, resolver.PLATFORM, at_platform(s))
        column = s.legacy.workspace_column if s.legacy is not None else None
        for ws_id, ws in workspaces.items():
            if column in drafts:
                check(s, resolver.Target("workspace", ws_id),
                      drafts_policy.resolve(ws).as_dict()[drafts[column]])
        for ds_id, ds in sources.items():
            target = resolver.Target("graph", ds.workspace_id, ds_id, {"platform_copy": True})
            old = s.legacy
            if old is not None and old.data_source_column in drafts:
                check(s, target, drafts_policy.resolve(workspaces[ds.workspace_id], ds)
                      .as_dict()[drafts[old.data_source_column]])
            elif old is not None and old.data_source_column in imports:
                check(s, target, import_settings.resolve(ds)[imports[old.data_source_column]])
            elif old is not None and old.projection_state_column and ds_id in states:
                mode, cls = states[ds_id]
                check(s, target, cls if s.materialized else build_policy.read_mode_of(mode, policy))
    assert wrong == [], wrong
    # The store reads them as not set (``20261116_1100_settings_import``): the platform's holds.
    assert hand_made == [("imports.identifier", "ds_b", "", "entity_id"),
                         ("imports.identifier", "ds_c", "inherit", "entity_id")]
