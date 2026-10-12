"""How "enable version control" writes a window, without infrastructure.

A window's rows go to Postgres as ONE statement of typed columns (``unnest``), compiled once — not
a multi-row VALUES per few thousand rows, which SQLAlchemy compiles on the worker's event loop (a
second of loop per window at 100k nodes). The duplicate ranking is one scan computed once, so no
plan can turn it into a loop per row. And a copy whose ``lastSyncedAt`` is a bare epoch number is
copied like any other: the ranking may have chosen it to keep.
"""
import types
from datetime import datetime, timezone

from backend.app.services.versioning import bootstrap_worker as bw


def test_a_preflight_window_is_one_statement_of_typed_columns():
    rows = [(4, ["Table"], "urn:a", 1772359200), (5, ["Table"], None, None),
            (6, ["Column"], "urn:b", "2026-03-01")]
    columns, visible, invisible = bw._preflight_columns(rows, "g1")
    assert (visible, invisible) == (2, 1)
    assert columns == {"falkor_id": [4, 6], "urn": ["urn:a", "urn:b"], "label": ["Table", "Column"],
                       "last_synced_at": [datetime(2026, 3, 1, 10, tzinfo=timezone.utc),
                                          datetime(2026, 3, 1, tzinfo=timezone.utc)]}
    assert bw._preflight_columns([(5, ["Table"], None, None)], "g1")[0] == {}, "nothing to insert"
    sql = str(bw._bootstrap_nodes_insert_sql())
    assert sql.count("unnest(") == 1 and "CAST(:last_synced_at AS timestamptz[])" in sql


def test_the_ranking_is_one_scan_computed_once():
    sql = " ".join(str(bw._rank_duplicates_sql()).split())
    assert "WITH r AS MATERIALIZED" in sql
    assert "count(*) OVER (PARTITION BY urn)" in sql and "JOIN" not in sql.upper()
    assert "ORDER BY last_synced_at DESC NULLS LAST, falkor_id" in sql


def test_a_copy_synced_at_an_epoch_number_is_copied():
    ctx = types.SimpleNamespace(commit_id="cmt_1", commit_seq=2, main_id="main_1", actor="bot")
    rows = [(0, ["Table"], {"urn": "urn:a", "lastSyncedAt": 1772359200}),
            (1, ["Table"], {"urn": "urn:b", "lastSyncedAt": 1772359200000.0})]
    win = bw.BootstrapRunner._nodes_to_rows(object(), rows, ctx, "g1", None, set())
    assert [d["entity_id"] for d in win.dicts] == ["urn:a", "urn:b"], "none dropped as unreadable"
    assert win.dicts[0]["payload"]["lastSyncedAt"] == "1772359200"
    assert bw._normalize_synced_at(win.dicts[1]["payload"]["lastSyncedAt"]) == \
        datetime(2026, 3, 1, 10, tzinfo=timezone.utc), "the text still ranks as the same time"
