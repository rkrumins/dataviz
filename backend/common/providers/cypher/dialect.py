"""Cypher-dialect seam: ``CypherDialect`` and ``IndexInfo``.

``backend.common.providers.cypher.executor`` names the interface to
*sending* a query (the ``CypherExecutor`` Protocol). This module names the
handful of places where the QUESTION ITSELF is not plain openCypher --
FalkorDB-specific statement text (schema-catalogue procedures, index DDL,
the "already indexed" error-text predicate, the ``CALL {} … UNION``
label-union shape a label-scoped-index engine needs, a pattern-negation
predicate FalkorDB's planner favours) and a few expressions (``labels(n)[0]``,
``ID(n)``/``id(r)``, ``type(r)``) that a second engine spells differently.

``CypherDialect`` is a frozen dataclass, not a class a second engine would
subclass: every field is either a fixed flag/value or a **plain callable**
supplied at construction. That is deliberate -- it is what makes adding a
second database "a data structure plus an executor" (see
``backend.app.providers.falkordb.dialect``'s module docstring) rather than
another multi-thousand-line adapter: a future engine builds its own
``CypherDialect(name="neo4j", ..., labels_statement=lambda: "...", ...)``
value, no subclass required. A callable stored as a value on a frozen
dataclass INSTANCE is plain data, not a bound method -- Python only applies
the descriptor protocol to a function found via the *class* dict, so
``dialect.labels_statement()`` calls the stored function directly, with no
implicit ``self``.

Full research matrix (FalkorDB / Neo4j / ArcadeDB, 30 dialect points):
``docs/superpowers/plans/2026-08-30-pr1-falkordb-decoupling.md`` §3.2.1.
This PR (PR 1) populates only the FalkorDB column
(``backend.app.providers.falkordb.dialect.FALKORDB_DIALECT``) -- the other
two are research for the PR that adds a second engine; inventing their
values now would be encoding behaviour nobody has run.

Field scope note: several fields below (the four "expression" builders,
``edge_id_cursor_page``, ``property_keys_statement``, ``fulltext_create``/
``fulltext_query``) are defined here and given real FalkorDB values in
``falkordb/dialect.py``, but PR 1 does not rewire their call sites to use
them -- see that module's docstring for exactly which fields are "defined
but not yet routed" and why (either genuinely unused today, or a ~110-site
mechanical edit explicitly out of this task's scope). Their presence here
is the point: naming them is what lets a future PR find every place that
needs an engine-neutral answer, routed or not.

Kernel module: stdlib + typing only, no ``backend.app`` import -- enforced
by ``backend/tests/test_falkordb_kernel_purity.py``.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, List, Optional, Sequence, Tuple


@dataclass(frozen=True)
class IndexInfo:
    """One parsed row of an index-catalogue statement (FalkorDB:
    ``CALL db.indexes()``), normalized across server-version differences
    in column order/count. See ``CypherDialect.parse_index_rows``.

    ``label`` carries the catalogue's raw value for the row -- ``None``
    (or, on some builds, ``""``) for an unlabeled (property-only) index.
    Typed ``Any`` rather than ``Optional[str]`` because the row it comes
    from is an untyped driver value and the pre-existing caller
    (``SchemaMixin._log_aggregation_index_health``) never assumed it was a
    ``str`` without checking -- callers that need a narrowed label should
    do the same ``isinstance(label, str)`` check before use.
    """

    label: Any
    props: List[str]
    is_edge_index: bool


@dataclass(frozen=True)
class CypherDialect:
    """Engine-neutral description of one graph database's Cypher dialect:
    capability flags plus statement/expression builders. See the module
    docstring for why builders are plain callables rather than methods.
    """

    name: str

    # -- flags: what this engine can do -----------------------------------
    identifier_case_sensitive: bool
    label_scoped_indexes_only: bool
    supports_unlabeled_property_index: Optional[bool]  # None = probe once per server
    supports_call_subquery: bool
    supports_union_in_subquery: bool
    supports_exists_subquery: bool
    supports_pattern_predicate_negation: bool
    supports_list_params: bool
    supports_o1_counts: bool
    timeout_mode: str  # "server_param_ms" | "driver_tx_timeout" | "client_only"
    unknown_label_match: str  # "empty" | "error"

    # -- statement builders --------------------------------------------------
    labels_statement: Callable[[], str]
    relationship_types_statement: Callable[[], str]
    property_keys_statement: Callable[[], Optional[str]]
    indexes_statement: Callable[[], Optional[str]]
    parse_index_rows: Callable[[Sequence[Sequence[Any]]], List[IndexInfo]]
    create_node_index: Callable[[str, str], str]
    create_edge_index: Callable[[str, Sequence[str]], str]
    create_unlabeled_index: Callable[[str], Optional[str]]
    is_index_exists_error: Callable[[BaseException], bool]
    fulltext_create: Callable[[str, Sequence[str]], Optional[str]]
    fulltext_query: Callable[[str, str, str], Optional[str]]

    # -- expression builders (defined for matrix completeness; see the
    #    module docstring's "Field scope note" -- PR 1 does not route
    #    their call sites) ---------------------------------------------
    first_label_expr: Callable[[str], str]
    node_id_expr: Callable[[str], str]
    edge_id_expr: Callable[[str], str]
    edge_type_expr: Callable[[str], str]
    label_union: Callable[[Sequence[str], str], str]
    no_incoming_pattern: Callable[[str, str], str]
    edge_id_cursor_page: Callable[[str], Tuple[str, str]]

    # -- reserved-identifier constants -- our own naming choices, stamped
    #    into the statements above rather than repeated as bare literals --
    aggregated_edge_type: str = "AGGREGATED"
    agg_meta_label: str = "_AggMeta"
    projection_label: str = "_Projection"
