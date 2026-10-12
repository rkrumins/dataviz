"""ONE definition of what the platform writes into its own graphs.

``common/derived_artifacts`` exists because this list got copied and the
copies drifted — twice, both times a real incident (see its docstring). This
file guards the third copy from appearing and pins the two properties the
rest of the profiling and drift work rests on:

* ``derived_edge_total`` and ``strip_derived_counts(edges=True)`` are exact
  complements — the overlay and the source's own relationships, no third
  bucket and no double count.
* ``raw_fingerprint_from_counts`` produces the SAME digest after being
  refactored onto them. Every stored ``data_source_state.raw_fingerprint`` was
  computed by the old code; if the digest moved, every source in the fleet
  would read as drifted on the next sweep and queue a rebuild with nothing to
  fix. That is the failure mode ``20260902_1000_derived_artifacts`` had to
  write a migration for, and the reason its successor deliberately does not.
"""
from __future__ import annotations

import hashlib
import json

import pytest

from backend.app.services.aggregation.fingerprint import (
    AGGREGATED_EDGE_TYPE, raw_fingerprint_from_counts,
)
from backend.common.derived_artifacts import (
    DERIVED_EDGE_TYPES, derived_edge_total, is_derived_edge_type,
    strip_derived_counts,
)


#: Every shape that has ever mattered: empty, absent, mixed casing, a key
#: present at zero, unparseable values, and floats.
CASES = [
    ({}, {}),
    (None, None),
    ({"Table": 10}, {"LINKS": 5}),
    ({"Table": 10, "_AggMeta": 1}, {"LINKS": 5, "AGGREGATED": 900}),
    ({"Table": 10}, {"aggregated": 7, "Aggregated": 3, "LINKS": 1}),
    ({"A": "12"}, {"B": None, "AGGREGATED": "x"}),
    ({"z": 1, "a": 2}, {"z": 1, "a": 2, "AGGREGATED": 0}),
    ({"Table": 3.7}, {"LINKS": 2.9, "AGGREGATED": 1.2}),
]


def _as_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _digest_the_old_way(entity_type_counts, edge_type_counts):
    """The loop as it stood before the refactor, verbatim — a literal
    ``str(key).upper() == "AGGREGATED"`` against its own copy of the name."""
    nodes = {
        str(k): _as_int(v)
        for k, v in strip_derived_counts(entity_type_counts or {}).items()
    }
    raw_edges, observed = {}, 0
    for key, value in (edge_type_counts or {}).items():
        count = _as_int(value)
        if str(key).upper() == "AGGREGATED":
            observed += count
        else:
            raw_edges[str(key)] = count
    structure = {
        "v": "raw1",
        "nodes": dict(sorted(nodes.items())),
        "edges": dict(sorted(raw_edges.items())),
    }
    digest = hashlib.sha256(
        json.dumps(structure, sort_keys=True).encode()
    ).hexdigest()[:16]
    return digest, observed, sum(raw_edges.values())


@pytest.mark.parametrize("entities,edges", CASES)
def test_the_refactor_did_not_move_the_drift_baseline(entities, edges):
    """THE pin. Every stored raw_fingerprint was computed by the old loop."""
    assert raw_fingerprint_from_counts(entities, edges) == _digest_the_old_way(
        entities, edges
    )


@pytest.mark.parametrize("_,edges", CASES)
def test_the_two_halves_are_exact_complements(_, edges):
    """No third bucket, and nothing counted twice: what the profiling
    surfaces strip plus what they show IS the whole map."""
    counts = {str(k): _as_int(v) for k, v in (edges or {}).items()}
    kept = sum(strip_derived_counts(counts, edges=True).values())
    assert derived_edge_total(counts) + kept == sum(counts.values())


def test_the_overlay_total_is_case_insensitive():
    """The type reaches us through ``type(r)`` from scans of graphs an
    external system may have loaded, so its casing is not ours to assume —
    the same rule ``is_derived_edge_type`` already states."""
    assert derived_edge_total({"AGGREGATED": 5, "aggregated": 3, "Aggregated": 2}) == 10
    assert derived_edge_total({"LINKS": 100}) == 0
    assert derived_edge_total({}) == 0
    assert derived_edge_total(None) == 0


def test_junk_counts_as_nothing_rather_than_blowing_up_a_fleet_sweep():
    assert derived_edge_total({"AGGREGATED": None}) == 0


def test_there_is_no_second_copy_of_the_edge_type_name():
    """``fingerprint.AGGREGATED_EDGE_TYPE`` is a re-export, not a declaration.
    A literal string here is how the exclusions went wrong twice before."""
    import inspect

    from backend.app.services.aggregation import fingerprint

    assert AGGREGATED_EDGE_TYPE is DERIVED_EDGE_TYPES[0]
    body = inspect.getsource(fingerprint.raw_fingerprint_from_counts)
    code = body.split('"""', 2)[-1]
    assert '"AGGREGATED"' not in code and "'AGGREGATED'" not in code, (
        "the edge type is spelled literally again instead of imported"
    )


def test_a_customers_own_type_is_never_mistaken_for_ours():
    """Membership is EXACT, not a prefix or substring rule — a source may
    legitimately carry a type whose name contains ours."""
    assert not is_derived_edge_type("AGGREGATED_BY")
    assert not is_derived_edge_type("PRE_AGGREGATED")
    assert derived_edge_total({"AGGREGATED_BY": 9, "AGGREGATED": 1}) == 1
