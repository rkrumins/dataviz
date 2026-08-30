"""Tests for the dialect seam: ``CypherDialect`` (kernel) and
``FALKORDB_DIALECT`` (``backend.app.providers.falkordb.dialect``).

Every render test below asserts a builder's output against a STRING
LITERAL -- never by calling the builder twice -- so a change that breaks
the byte-identical contract fails here even if it broke it the same way
in both places. The Cypher golden (``test_falkordb_cypher_golden.py``) is
the end-to-end proof that the provider's actual call sites still emit
these strings; this file pins the builders themselves, including the
handful (``property_keys_statement``, ``fulltext_create``/
``fulltext_query``, the four expression builders, ``edge_id_cursor_page``)
that no call site reaches today -- see ``falkordb/dialect.py``'s module
docstring for exactly which fields those are and why.

``parse_index_rows`` gets extra, table-driven coverage: it is the one
builder that PARSES a response rather than rendering a fixed string, no
test anywhere pinned its behaviour before this task, and the caller
(``SchemaMixin._log_aggregation_index_health``) never raises on a bad
parse -- a wrong column read produces a plausible wrong log line and
nothing goes red. That combination makes it the riskiest builder in this
file, hence the extra coverage.
"""
from __future__ import annotations

import functools

import pytest

from backend.app.providers.falkordb import FalkorDBProvider
from backend.app.providers.falkordb.dialect import FALKORDB_DIALECT
from backend.common.providers.cypher.dialect import CypherDialect, IndexInfo

D = FALKORDB_DIALECT


# ---------------------------------------------------------------------------
# Wiring: ConnectionMixin.dialect
# ---------------------------------------------------------------------------


def test_new_built_instance_can_still_reach_dialect():
    """Mirrors test_falkordb_executor.py's equivalent: three existing
    tests build a FalkorDBProvider via __new__ without running __init__
    (test_ensure_indices_onboarding.py:110,
    test_falkordb_ancestors_cache_reset.py:16,
    test_falkordb_pool_resilience.py:218). ``dialect`` must not assume
    __init__ ran.
    """
    p = FalkorDBProvider.__new__(FalkorDBProvider)
    assert p.dialect is FALKORDB_DIALECT


def test_dialect_is_the_shared_module_level_instance():
    """Unlike the executor (a fresh FalkorDBExecutor per provider),
    FALKORDB_DIALECT is one shared, stateless value -- every provider
    instance sees the identical object."""
    p1 = FalkorDBProvider(host="a", graph_name="g1")
    p2 = FalkorDBProvider(host="b", graph_name="g2")
    assert p1.dialect is p2.dialect is FALKORDB_DIALECT


def test_dialect_is_a_cached_property_on_connection_mixin():
    from backend.app.providers.falkordb.connection import ConnectionMixin

    assert isinstance(vars(ConnectionMixin)["dialect"], functools.cached_property)


# ---------------------------------------------------------------------------
# Flags -- the FalkorDB column of the plan's 3.2.1 matrix.
# ---------------------------------------------------------------------------


def test_falkordb_flags():
    assert D.name == "falkordb"
    assert D.identifier_case_sensitive is True
    assert D.label_scoped_indexes_only is True
    assert D.supports_unlabeled_property_index is None
    assert D.supports_call_subquery is True
    assert D.supports_union_in_subquery is True
    assert D.supports_exists_subquery is False
    assert D.supports_pattern_predicate_negation is True
    assert D.supports_list_params is True
    assert D.supports_o1_counts is True
    assert D.timeout_mode == "server_param_ms"
    assert D.unknown_label_match == "empty"
    assert D.aggregated_edge_type == "AGGREGATED"
    assert D.agg_meta_label == "_AggMeta"
    assert D.projection_label == "_Projection"


# ---------------------------------------------------------------------------
# Statement builders -- byte-identical to what the provider used to inline.
# Expected strings are written as literals, never derived from the builder.
# ---------------------------------------------------------------------------


def test_labels_statement():
    assert D.labels_statement() == "CALL db.labels() YIELD label RETURN label"


def test_relationship_types_statement():
    assert D.relationship_types_statement() == (
        "CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType"
    )


def test_indexes_statement():
    assert D.indexes_statement() == "CALL db.indexes()"


def test_create_node_index():
    assert D.create_node_index("Dataset", "urn") == "CREATE INDEX FOR (n:Dataset) ON (n.urn)"
    assert D.create_node_index("_Projection", "urn") == "CREATE INDEX FOR (n:_Projection) ON (n.urn)"


def test_create_edge_index_single_and_composite_props():
    assert D.create_edge_index("AGGREGATED", ("sourceLevel",)) == (
        "CREATE INDEX FOR ()-[r:AGGREGATED]-() ON (r.sourceLevel)"
    )
    assert D.create_edge_index("AGGREGATED", ("sourceLevel", "targetLevel")) == (
        "CREATE INDEX FOR ()-[r:AGGREGATED]-() ON (r.sourceLevel, r.targetLevel)"
    )
    assert D.create_edge_index("AGGREGATED", ("sourceDepth", "targetDepth")) == (
        "CREATE INDEX FOR ()-[r:AGGREGATED]-() ON (r.sourceDepth, r.targetDepth)"
    )


def test_create_unlabeled_index():
    assert D.create_unlabeled_index("urn") == "CREATE INDEX FOR (n) ON (n.urn)"


@pytest.mark.parametrize(
    "message, expected",
    [
        ("Error: Attribute 'idx' already indexed", True),
        ("ALREADY INDEXED", True),
        ("already indexed for label X", True),
        ("Unknown function 'db.indexes'", False),
        ("connection refused", False),
    ],
)
def test_is_index_exists_error(message, expected):
    assert D.is_index_exists_error(Exception(message)) is expected


def test_property_keys_statement_defined_but_unused():
    assert D.property_keys_statement() == "CALL db.propertyKeys() YIELD propertyKey RETURN propertyKey"


def test_fulltext_builders_defined_but_unused():
    assert D.fulltext_create("Dataset", ("name", "qualifiedName")) == (
        "CALL db.idx.fulltext.createNodeIndex('Dataset', 'name', 'qualifiedName')"
    )
    assert D.fulltext_query("Dataset", "name", "q") == (
        "CALL db.idx.fulltext.queryNodes('Dataset', $q)"
    )


# ---------------------------------------------------------------------------
# Expression builders -- defined for matrix completeness; no call site
# routes through these in PR 1 (see falkordb/dialect.py's module
# docstring). Still real FalkorDB text, matching what trace.py / drill.py
# / closure.py / schema.py spell inline today.
# ---------------------------------------------------------------------------


def test_expression_builders():
    assert D.first_label_expr("n") == "labels(n)[0]"
    assert D.node_id_expr("n") == "ID(n)"
    assert D.edge_id_expr("r") == "id(r)"
    assert D.edge_type_expr("r") == "type(r)"
    assert D.edge_id_cursor_page("id(r)") == ("WHERE id(r) >= $after", "ORDER BY id(r)")


# ---------------------------------------------------------------------------
# label_union -- shared by all six CALL {} UNION sites (browse.py x2,
# navigation.py, reads.py x3). Callers append their own tail.
# ---------------------------------------------------------------------------


def test_label_union_wraps_branches_with_no_trailing_space():
    assert D.label_union(["Dataset", "Container"], "") == (
        "CALL { MATCH (n:Dataset) RETURN n UNION MATCH (n:Container) RETURN n }"
    )


def test_label_union_applies_the_same_where_to_every_branch():
    where = " WHERE NOT (n)<-[:CONTAINS|HAS_PART]-()"
    assert D.label_union(["Dataset", "Container"], where) == (
        "CALL { "
        "MATCH (n:Dataset) WHERE NOT (n)<-[:CONTAINS|HAS_PART]-() RETURN n UNION "
        "MATCH (n:Container) WHERE NOT (n)<-[:CONTAINS|HAS_PART]-() RETURN n"
        " }"
    )


def test_label_union_single_label():
    assert D.label_union(["Dataset"], "") == "CALL { MATCH (n:Dataset) RETURN n }"


# ---------------------------------------------------------------------------
# no_incoming_pattern -- anchored on the bound variable (left side), not
# the equally-correct-looking NOT ()-[:T]->(n) -- see this module's own
# ``_no_incoming_pattern`` docstring for why the anchor side is
# load-bearing for FalkorDB's planner (an O(N) full-graph scan avoided),
# not stylistic.
# ---------------------------------------------------------------------------


def test_no_incoming_pattern_anchors_on_the_bound_variable():
    assert D.no_incoming_pattern("n", "CONTAINS|HAS_PART") == "NOT (n)<-[:CONTAINS|HAS_PART]-()"


def test_no_incoming_pattern_single_type():
    assert D.no_incoming_pattern("n", "CONTAINS") == "NOT (n)<-[:CONTAINS]-()"


# ---------------------------------------------------------------------------
# parse_index_rows -- table-driven over every row shape
# _log_aggregation_index_health handled before this moved. See the module
# docstring above for why this builder gets more coverage than the others.
# ---------------------------------------------------------------------------


def test_parse_index_rows_labelled_urn_index():
    rows = [["Dataset", ["urn"], None, None, None, "NODE", None]]
    assert D.parse_index_rows(rows) == [IndexInfo(label="Dataset", props=["urn"], is_edge_index=False)]


@pytest.mark.parametrize("unlabeled", [None, ""])
def test_parse_index_rows_unlabelled_index(unlabeled):
    rows = [[unlabeled, ["urn"], None, None, None, "NODE", None]]
    assert D.parse_index_rows(rows) == [IndexInfo(label=unlabeled, props=["urn"], is_edge_index=False)]


def test_parse_index_rows_aggregated_edge_index():
    rows = [["AGGREGATED", ["sourceLevel", "targetLevel"], None, None, None, "RELATIONSHIP", None]]
    assert D.parse_index_rows(rows) == [
        IndexInfo(label="AGGREGATED", props=["sourceLevel", "targetLevel"], is_edge_index=True)
    ]


def test_parse_index_rows_edge_index_detection_is_case_insensitive_and_prefix_matched():
    # Original code: `entity_type_col.upper().startswith("RELAT")` -- covers
    # both a full "RELATIONSHIP" spelling and any shorter/differently-cased
    # variant a FalkorDB build might return.
    rows = [["AGGREGATED", ["sourceLevel"], None, None, None, "relationship", None]]
    assert D.parse_index_rows(rows)[0].is_edge_index is True


def test_parse_index_rows_props_as_bare_string():
    rows = [["Dataset", "urn", None, None, None, "NODE", None]]
    assert D.parse_index_rows(rows) == [IndexInfo(label="Dataset", props=["urn"], is_edge_index=False)]


def test_parse_index_rows_short_row():
    # len(row) == 1: no properties column, no entity-type column.
    rows = [["Dataset"]]
    assert D.parse_index_rows(rows) == [IndexInfo(label="Dataset", props=[], is_edge_index=False)]


@pytest.mark.parametrize("empty_row", [[], (), None])
def test_parse_index_rows_skips_falsy_rows(empty_row):
    rows = [empty_row, ["Dataset", ["urn"], None, None, None, "NODE", None]]
    assert D.parse_index_rows(rows) == [IndexInfo(label="Dataset", props=["urn"], is_edge_index=False)]


def test_parse_index_rows_empty_input():
    assert D.parse_index_rows([]) == []


# ---------------------------------------------------------------------------
# Kernel purity / data-structure shape: CypherDialect itself takes no
# backend.app import (see test_falkordb_kernel_purity.py for the AST
# guard), and FALKORDB_DIALECT is a plain instantiation, not a subclass --
# "a data structure", not another adapter class.
# ---------------------------------------------------------------------------


def test_falkordb_dialect_is_a_plain_cypherdialect_instance_not_a_subclass():
    assert type(FALKORDB_DIALECT) is CypherDialect


def test_cypherdialect_is_frozen():
    with pytest.raises(Exception):
        FALKORDB_DIALECT.name = "neo4j"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# One integration check for navigation.py's label-union branch: nothing in
# the existing suite sets `_indexed_entity_type_ids` on a real provider
# (confirmed by grep), so the Cypher golden's get_nodes_by_layer step never
# exercises this branch (it runs before ensure_indices in the golden's
# drive script). Pin it directly here since it is otherwise uncovered.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_nodes_by_layer_label_union_matches_pre_dialect_shape(monkeypatch):
    import backend.app.providers.index_policy as index_policy

    # indexed_labels() prepends the platform's DEFAULT_INDEX_LABELS ahead of
    # the ontology vocabulary -- irrelevant to what THIS test pins (the
    # label_union wiring), so it is stubbed out rather than hand-duplicated
    # here where it would silently drift from index_policy.py's real list.
    monkeypatch.setattr(index_policy, "indexed_labels", lambda vocab: ["Dataset", "Container"])

    p = FalkorDBProvider(host="x", graph_name="g")
    p._indexed_entity_type_ids = ["Dataset", "Container"]

    captured = {}

    async def _fake_ro_query(cypher, params=None, op=None):
        captured["cypher"] = cypher
        captured["params"] = params
        return type("R", (), {"result_set": []})()

    async def _noop():
        return None

    p._ensure_connected = _noop
    p._ro_query = _fake_ro_query

    await p.get_nodes_by_layer("layer-1", limit=20)

    assert captured["cypher"] == (
        "CALL { MATCH (n:Dataset) WHERE n.layerAssignment = $lid RETURN n "
        "UNION MATCH (n:Container) WHERE n.layerAssignment = $lid RETURN n }"
        " WITH n ORDER BY n.displayName ASC, n.urn ASC SKIP $skip LIMIT $limit RETURN n"
    )
