"""Which version of main a projection's key serves reads at (``serving_seq``) — no database.

The head while it holds it. While the projection catches up or rebuilds in place, the version the
key last published: its watermark, or during a rebuild, which resets that to 0, the version it
held (``served_commit_seq``). None — reads go to Postgres — while the key is out of FalkorDB,
being loaded or reset, or holds no version. ``GRAPHVER_READ_MAX_LAG`` caps how far behind.
"""
import pytest

from backend.app.services.versioning import config
from backend.app.services.versioning.service import serving_seq


@pytest.fixture(autouse=True)
def _default_lag(monkeypatch):
    monkeypatch.setattr(config, "READ_MAX_LAG", -1)


def test_the_head_while_the_key_holds_it():
    assert serving_seq(12, 12, "idle", 12) == 12
    assert serving_seq(0, 0, "idle", None) == 0          # a graph with no commits: nothing behind


def test_the_version_it_last_published_while_it_catches_up():
    assert serving_seq(9, 12, "projecting", 9) == 9
    assert serving_seq(9, 12, "idle", None) == 9         # a row from before the column: its watermark
    assert serving_seq(9, 12, "idle", 9) == 9            # a failed pass backing off: still served


def test_the_version_it_held_while_it_rebuilds_in_place():
    assert serving_seq(0, 12, "rebuilding", 9) == 9
    assert serving_seq(0, 12, "idle", 9) == 9            # between a long rebuild's passes


def test_nothing_from_a_key_out_of_falkordb_loading_reset_or_empty():
    for status in ("evicted", "rehydrating", "waiting_capacity", "reseeding"):
        assert serving_seq(0, 12, status, 9) is None, status
    assert serving_seq(12, 12, "rehydrating", 12) is None   # loaded, its summaries not yet built
    assert serving_seq(0, 12, "rebuilding", None) is None   # written from nothing
    assert serving_seq(0, 12, "idle", None) is None
    # At genesis, the empty first commit, a key holds nothing anyone published: a new graph's
    # first publish, or an enabled source's own graph before its first pass, reads Postgres.
    assert serving_seq(1, 2, "idle", None) is None
    assert serving_seq(1, 2, "projecting", 1) is None
    assert serving_seq(1, 1, "idle", 1) == 1                 # at its head: nothing behind


def test_read_max_lag_caps_how_far_behind(monkeypatch):
    monkeypatch.setattr(config, "READ_MAX_LAG", 0)
    assert serving_seq(9, 12, "projecting", 9) is None
    assert serving_seq(12, 12, "idle", 12) == 12
    monkeypatch.setattr(config, "READ_MAX_LAG", 3)
    assert serving_seq(9, 12, "projecting", 9) == 9
    assert serving_seq(0, 12, "rebuilding", 8) is None


def test_a_graph_read_latest_serves_the_key_only_at_its_head():
    """A graph read ``latest`` (always the newest published version) is served from its key only
    while the key holds the head; behind it, whatever the platform's lag allows, its reads go to
    Postgres. The other modes take the platform's lag."""
    from backend.app.services.versioning import build_policy

    latest = build_policy.max_lag_of("latest")
    assert serving_seq(12, 12, "idle", 12, latest) == 12
    assert serving_seq(9, 12, "projecting", 9, latest) is None
    assert serving_seq(0, 12, "rebuilding", 9, latest) is None
    for mode in ("in_place", "beside"):
        assert serving_seq(9, 12, "projecting", 9, build_policy.max_lag_of(mode)) == 9, mode
