"""Every node-writing path must populate ``searchableText``.

``TextPredicate(target='any')`` — the predicate the Context View's search
box compiles a plain typed word to — reads ``n.searchableText``. The
provider write paths denormalise it at write time; three seed scripts talk
raw Cypher instead and used to omit it. A node seeded that way rendered
perfectly on the canvas and was invisible to search: ``null CONTAINS 'x'``
is null, so the row was silently rejected. No error, no log, ~27ms, zero
hits, for a term the user could see on screen.

The compiler now ORs in the source columns so a null no longer blackholes
the search, but that is a safety net. The column is still what makes
property values searchable at all — no other column carries them — so the
writers have to keep writing it.

This test reads the scripts' Cypher rather than importing them: they pull
in ``falkordb.asyncio`` and a pile of seeding machinery at module scope,
which is not worth standing up to assert a property name.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest


_SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"

# Scripts that MERGE nodes with hand-written Cypher rather than going
# through FalkorDBProvider.save_custom_graph / create_node.
_RAW_CYPHER_SEEDERS = [
    "seed_data_lake.py",
    "seed_platform_lineage.py",
    "seed_large_lineage.py",
]


@pytest.mark.parametrize("script", _RAW_CYPHER_SEEDERS)
def test_seeder_sets_searchable_text_in_cypher(script: str):
    source = (_SCRIPTS / script).read_text()
    assert "n.searchableText = map.searchableText" in source, (
        f"{script} MERGEs nodes with raw Cypher but never SETs "
        "n.searchableText. Every node it writes will be unfindable by "
        "text search on property values."
    )


@pytest.mark.parametrize("script", _RAW_CYPHER_SEEDERS)
def test_seeder_computes_searchable_text_with_the_shared_helper(script: str):
    source = (_SCRIPTS / script).read_text()
    assert "_compute_searchable_text(" in source, (
        f"{script} must build searchableText with "
        "falkordb_provider._compute_searchable_text so the seeded value "
        "matches what the provider would have written (lowercased, "
        "size-capped, property values folded in)."
    )
    assert '"searchableText":' in source, (
        f"{script} sets n.searchableText in Cypher but never puts a "
        "searchableText key in the parameter map — the property would be "
        "written as null."
    )


def test_helper_folds_in_the_fields_search_depends_on():
    """Guards the contract the seeders rely on."""
    from backend.app.providers.falkordb_provider import (
        _compute_searchable_text,
    )

    text = _compute_searchable_text(
        "Account Type",
        "GOLD.dim_customer123.account_type",
        "The customer's account tier",
        {"sourceSystem": "snowflake", "rowCount": 42},
    )
    assert "account type" in text          # displayName
    assert "dim_customer123" in text       # qualifiedName
    assert "tier" in text                  # description
    assert "snowflake" in text             # string-valued property
    assert text == text.lower()            # written pre-lowercased
