"""Every example under ``docs/examples/search-and-rules`` is one the server takes as written.

A ``*.search.json`` is a ``SearchQuery`` the search endpoint accepts and compiles; every item of a
``*.library.json`` pack imports — each rule checked as a rule is when saved, each query as a saved
query is. The guides point readers at these files, so a model change that breaks one fails here
rather than in someone's first import.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from backend.app.providers.falkordb_deep_search import _Compiler
from backend.app.services import view_library
from backend.app.services.advanced_search_service import _count_and_validate
from backend.common.models.search import SearchQuery
from backend.common.models.view_library import (
    PACK_FORMAT,
    PACK_VERSION,
    DisplayRule,
    LibraryPack,
    SavedQueryInput,
)

EXAMPLES = Path(__file__).resolve().parents[2] / "docs" / "examples" / "search-and-rules"
QUERIES = sorted((EXAMPLES / "queries").glob("*.search.json"))
PACKS = sorted((EXAMPLES / "packs").glob("*.library.json"))


def _load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def test_the_examples_are_there():
    assert len(QUERIES) >= 3 and len(PACKS) >= 2


@pytest.mark.parametrize("path", QUERIES, ids=lambda p: p.name)
def test_a_search_example_is_a_query_the_server_runs(path: Path):
    query = SearchQuery.model_validate(_load(path))
    _count_and_validate(query)   # depth, leaves, OR width, typed values, sub-aggregations
    _Compiler(lineage_edge_types={"_"}, containment_edge_types={"_"}).compile(query.predicate)
    # The guides tell readers to send a group at the root, as the panel does.
    assert query.predicate.kind == "group"


@pytest.mark.parametrize("path", PACKS, ids=lambda p: p.name)
def test_every_item_of_a_pack_example_imports(path: Path):
    raw = _load(path)
    # The import dialog reads a file only when it names both.
    assert (raw.get("format"), raw.get("version")) == (PACK_FORMAT, PACK_VERSION)
    pack = LibraryPack.model_validate(raw)
    assert pack.display_rules and pack.saved_queries

    for item in pack.display_rules:
        rule = DisplayRule.model_validate({**item, "id": item.get("id") or "incoming"})
        # The server takes 3–8 hex digits; a chip renders only #rrggbb.
        assert re.fullmatch(r"#[0-9a-fA-F]{6}", rule.color), rule.name
        view_library._check_predicate(rule.predicate, rule=True)
    for item in pack.saved_queries:
        query = SavedQueryInput.model_validate(item)
        view_library._check_predicate(query.predicate, rule=False)

    # A clash would import under "name (2)" — not what an example should teach.
    for items in (pack.display_rules, pack.saved_queries):
        names = [str(i["name"]).strip().lower() for i in items]
        assert len(names) == len(set(names))
