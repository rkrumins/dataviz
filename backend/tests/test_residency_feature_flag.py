"""Graph residency is a switch: ``residencyEnabled`` (Admin → Features), off by default.

On, FalkorDB keeps graphs by their class and each master's memory; off, every graph stays loaded,
and turning it off brings evicted graphs back as memory allows. What it does at runtime — the
worker reading it each pass, the grace period, the reads that never depend on it — is tested in
``test_residency_reads.py``, ``test_residency_plan.py`` and, against Postgres and FalkorDB,
``integration/test_graph_residency.py``. Here: the switch as the page and the registry describe it.
"""
from __future__ import annotations

import json
from pathlib import Path

from backend.app.config.feature_wiring import FEATURE_WIRING
from backend.app.config.features_seed import REFUSAL_MESSAGES, SEED_DEFINITIONS

_DOCS = Path(__file__).resolve().parents[2] / "docs"


def _residency() -> dict:
    return next(d for d in SEED_DEFINITIONS if d["key"] == "residencyEnabled")


def test_graph_residency_ships_off_in_lineage_after_forks():
    switch = _residency()
    assert (switch["name"], switch["type"], json.loads(switch["default_value"])) == (
        "Graph residency", "boolean", False)
    lineage = sorted((d for d in SEED_DEFINITIONS if d["category_id"] == "lineage"),
                     key=lambda d: d["sort_order"])
    assert [d["key"] for d in lineage] == [
        "versioningEnabled", "forksEnabled", "residencyEnabled", "traceEnabled"]
    # It refuses nothing, so there is nothing to tell a user it stopped.
    assert "residencyEnabled" not in REFUSAL_MESSAGES


def test_the_page_says_what_turning_it_on_and_off_means():
    switch = _residency()
    for words in ("Always, Standard and Coldline", "Version control"):
        assert words in switch["description"]
    on = switch["impact_when_on"]
    for words in ("Always, Standard or Coldline", "90 seconds", "Postgres", "wait for room",
                  "maxmemory", "every pod", "Residency & eviction", "as memory allows"):
        assert words in on, words
    off = switch["impact_when_off"]
    for words in ("stays loaded", "as memory allows", "Postgres"):
        assert words in off, words


def test_read_more_opens_turning_residency_on_in_chapter_17():
    switch = _residency()
    assert switch["help_url"] == "/docs/versioning-forks-and-residency#16-turning-residency-on"
    chapter = (_DOCS / "versioning" / "17-forks-and-residency.md").read_text()
    assert "\n## 16. Turning residency on\n" in chapter


def test_it_is_a_wired_preview_that_needs_version_control():
    wiring = FEATURE_WIRING["residencyEnabled"]
    # A preview, so it may ship off; what it changes is enforced by the server.
    assert (wiring.stage, wiring.posture) == ("experimental", "capability")
    assert wiring.enforced_server_side and wiring.depends_on == ("versioningEnabled",)
    surfaces = " ".join(wiring.ui_surfaces)
    for words in ("Residency & eviction", "class", "Load now", "Adopt"):
        assert words in surfaces, words
