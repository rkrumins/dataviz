"""``20261118_1100_view_members``: a view's members move out of its config into their own table.

The upgrade creates ``view_members`` and the state's ``members_epoch`` / ``materialize``, and
moves each view made from a query's ``assignedBy: "query"`` entries into rows at its current
epoch — marking it pending, its applied hash cleared, since a config cannot tell a member from
a container drawn around one. People's own entries stay where they are. The downgrade writes
the members back, and refuses a view holding more than a config held.
"""
import importlib.util
import json
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

_MIGRATION = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "20261118_1100_view_members.py"


def _load():
    spec = importlib.util.spec_from_file_location("_view_members_migration", _MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mig = _load()
MEMBERSHIP = {"v": 1, "mode": "live", "sources": [{"spec": {"seeds": {"urns": ["s"]}}}]}


def member(layer, **kw):
    return {"layerId": layer, "inheritsChildren": False, "assignedBy": "query", **kw}


def mine(layer):
    return {"layerId": layer, "inheritsChildren": True, "assignedBy": "user"}


def config(assignments, membership=MEMBERSHIP):
    out = {"layout": {"referenceLayout": {"layers": [{"id": "l1"}, {"id": "l2"}], "assignments": assignments}}}
    if membership is not None:
        out["membership"] = membership
    return out


def test_the_revision_follows_the_member_sets_and_fits():
    assert mig.revision == _MIGRATION.stem and len(mig.revision) <= 32
    assert mig.down_revision == "20261118_1000_member_sets"


@pytest.fixture()
def db():
    """The two tables as the revision before this one leaves them."""
    engine = sa.create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(sa.text(
            "CREATE TABLE views (id TEXT PRIMARY KEY, config TEXT NOT NULL, workspace_id TEXT NOT NULL, "
            "data_source_id TEXT)"))
        conn.execute(sa.text(
            "CREATE TABLE view_membership_state (view_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, "
            "data_source_id TEXT, resolution_hash TEXT, applied_resolution_hash TEXT, data_version TEXT, "
            "status TEXT NOT NULL, status_detail TEXT, lease_owner TEXT, lease_until TEXT, epoch INTEGER NOT NULL, "
            "attempts INTEGER NOT NULL, revision INTEGER NOT NULL, member_count INTEGER NOT NULL, "
            "key_count INTEGER NOT NULL, counts TEXT, truncated TEXT, last_diff TEXT, held TEXT, "
            "last_started_at TEXT, last_finished_at TEXT, last_applied_at TEXT, last_read_at TEXT, "
            "last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"))
        views = [
            ("live", config({"a": member("l1"), "b": member("l2", inheritsChildren=True, orderKey="k"),
                             "mine": mine("l1")})),
            ("frozen", config({"f": member("l2")}, {**MEMBERSHIP, "mode": "snapshot"})),
            ("plain", config({"x": member("l1")}, membership=None)),
        ]
        for view_id, cfg in views:
            conn.execute(sa.text("INSERT INTO views VALUES (:id, :c, 'ws', NULL)"), {"id": view_id, "c": json.dumps(cfg)})
        conn.execute(sa.text(
            "INSERT INTO view_membership_state (view_id, workspace_id, status, epoch, attempts, revision, member_count, "
            "key_count, applied_resolution_hash, created_at, updated_at) "
            "VALUES ('live', 'ws', 'ok', 3, 0, 2, 2, 3, 'h', 't', 't')"))
    return engine


def run(engine, step: str) -> None:
    with engine.begin() as conn:
        with Operations.context(MigrationContext.configure(conn)):
            getattr(mig, step)()


def read(engine):
    with engine.connect() as conn:
        configs = {r.id: json.loads(r.config) for r in conn.execute(sa.text("SELECT id, config FROM views"))}
        states = {r.view_id: r for r in conn.execute(sa.text("SELECT * FROM view_membership_state"))}
        rows = (conn.execute(sa.text("SELECT * FROM view_members ORDER BY view_id, ord")).all()
                if sa.inspect(conn).has_table("view_members") else [])
    return configs, states, rows


def assignments(cfg):
    return cfg["layout"]["referenceLayout"]["assignments"]


def test_the_upgrade_moves_the_members_out_and_marks_the_view_to_be_worked_out_again(db):
    run(db, "upgrade")
    configs, states, rows = read(db)
    assert assignments(configs["live"]) == {"mine": mine("l1")}
    assert [(r.view_id, r.epoch, r.urn, r.layer_id, bool(r.whole), r.order_key) for r in rows] == [
        ("frozen", 0, "f", "l2", False, None),
        ("live", 3, "a", "l1", False, None), ("live", 3, "b", "l2", True, "k"),
    ]
    live = states["live"]
    assert (live.members_epoch, live.member_count, live.status, live.applied_resolution_hash) == (3, 2, "pending", None)
    assert (states["frozen"].members_epoch, states["frozen"].member_count) == (0, 1)
    assert assignments(configs["plain"]) == {"x": member("l1")}, "a view not made from a query is left alone"

    run(db, "upgrade")      # again: guarded, and finds nothing more to move
    assert read(db)[2] == rows


def test_a_database_that_ran_it_before_members_said_what_they_sit_inside_gains_the_column(db):
    """The revision is unreleased, and gained ``in_layer`` after some development
    databases ran it: there, the upgrade adds the column, its rows inside nothing until
    the view is worked out again."""
    with db.begin() as conn:
        conn.execute(sa.text(
            "CREATE TABLE view_members (view_id TEXT NOT NULL, epoch INTEGER NOT NULL, urn TEXT NOT NULL, "
            "layer_id TEXT NOT NULL, sort_key TEXT NOT NULL, ord INTEGER NOT NULL, label TEXT NOT NULL, "
            "label_ord INTEGER NOT NULL, via TEXT, hops INTEGER, whole BOOLEAN NOT NULL, covered BOOLEAN NOT NULL, "
            "name TEXT, type TEXT, assigned_at TEXT, order_key TEXT, logical_node_id TEXT, "
            "PRIMARY KEY (view_id, epoch, urn))"))
        conn.execute(sa.text(
            "INSERT INTO view_members (view_id, epoch, urn, layer_id, sort_key, ord, label, label_ord, whole, "
            "covered) VALUES ('live', 1, 'earlier', 'l1', 'earlier', 0, '', 0, 0, 0)"))
    run(db, "upgrade")
    _, _, rows = read(db)
    assert {(r.urn, r.in_layer) for r in rows} == {("earlier", 0), ("a", 0), ("b", 0), ("f", 0)}
    run(db, "upgrade")      # again: guarded
    with db.connect() as conn:
        assert [c["name"] for c in sa.inspect(conn).get_columns("view_members")].count("in_layer") == 1


def test_the_downgrade_writes_the_members_back(db):
    run(db, "upgrade")
    run(db, "downgrade")
    configs, states, rows = read(db)
    assert assignments(configs["live"]) == {
        "mine": mine("l1"), "a": member("l1"), "b": member("l2", inheritsChildren=True, orderKey="k")}
    assert assignments(configs["frozen"]) == {"f": member("l2")}
    with db.connect() as conn:
        assert not sa.inspect(conn).has_table("view_members")
        assert "members_epoch" not in {c["name"] for c in sa.inspect(conn).get_columns("view_membership_state")}


def test_the_downgrade_refuses_a_view_larger_than_a_config_held(db, monkeypatch):
    run(db, "upgrade")
    monkeypatch.setattr(mig, "_CONFIG_MAX", 1)
    with pytest.raises(RuntimeError, match="holds 2 members"):
        run(db, "downgrade")
    configs, _, rows = read(db)
    assert len(rows) == 3 and assignments(configs["live"]) == {"mine": mine("l1")}, "nothing was changed"
