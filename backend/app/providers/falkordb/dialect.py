"""FALKORDB_DIALECT -- the FalkorDB column of ``CypherDialect``.

Step 12 of ``docs/superpowers/plans/2026-08-30-pr1-falkordb-decoupling.md``
(the dialect seam; step 11/task 13 built the executor seam). Every
function below renders the byte-identical string the provider emitted
inline before this task -- the Cypher golden
(``backend/tests/test_falkordb_cypher_golden.py``) is the gate that
proves it, and ``backend/tests/test_falkordb_dialect.py`` pins each
builder's output directly.

``FALKORDB_DIALECT`` is a plain ``CypherDialect(...)`` VALUE, not a
subclass -- see the kernel module's docstring for why that is what makes a
second engine "a data structure plus an executor" rather than another
adapter class.

Routed vs. defined-but-unrouted
--------------------------------
Of the ~20 statement-level call sites the task brief identifies, all but
two route through this dialect (see the per-builder notes below for the
one exception, and "Two catalogue call sites are NOT routed here"
further down). Four fields are defined with real FalkorDB values but
have **zero call sites anywhere in the package** today --
``property_keys_statement``, ``fulltext_create``, ``fulltext_query``
(``grep`` confirms no ``db.propertyKeys`` / ``db.idx.fulltext`` usage
anywhere under ``falkordb/``) -- kept for matrix completeness (plan
§3.2.1 points #3 and #8), not because anything calls them.

The four **expression** builders (``first_label_expr``, ``node_id_expr``,
``edge_id_expr``, ``edge_type_expr``) and ``edge_id_cursor_page`` are
likewise defined but not wired to their ~110 call sites
(``labels(x)[0]`` x49, ``id(r)``/``ID(n)`` x13, ``type(r)`` x49) --
explicitly out of scope for this task (see task-14-brief.md: "the least
reviewable commit in the whole plan", left for the PR that lifts those
modules wholesale). Their FalkorDB values below are still real, not
placeholders: ``ID(n)`` (uppercase) for nodes and ``id(r)``/``type(r)``
(lowercase) for edges match the casing actually used throughout
``trace.py`` / ``drill.py`` / ``closure.py`` / ``schema.py`` today.

Two catalogue call sites are NOT routed here
----------------------------------------------
``writes.py``'s ``_type_casing_maps`` issues bare ``CALL
db.relationshipTypes()`` / ``CALL db.labels()`` (no ``YIELD``/``RETURN``)
-- a DIFFERENT literal string from the ``... YIELD x RETURN x`` form every
other call site uses (``stats.py``, ``aggregation.py``). The task brief's
site table lists both forms under one "label/rel-type catalogue" heading,
but they are not byte-identical to each other, and the rule for this task
is that every routed call site keeps emitting its own exact bytes. Rather
than invent a second dialect field for what is not a real FalkorDB
dialect distinction -- just two spellings of the same procedure call left
inconsistent by history -- ``labels_statement()`` /
``relationship_types_statement()`` below render the ``YIELD``/``RETURN``
form (the one the plan's own §3.2.1 matrix cites as canonical, and the one
3-of-4 / 2-of-3 call sites already use); ``writes.py``'s two bare-form
sites are left untouched. Confirmed against the Cypher golden's
``_type_casing_maps`` entry, which pins the bare form byte-for-byte.
"""
from __future__ import annotations

from typing import Any, List, Optional, Sequence, Tuple

from backend.common.providers.cypher.dialect import CypherDialect, IndexInfo


def _labels_statement() -> str:
    return "CALL db.labels() YIELD label RETURN label"


def _relationship_types_statement() -> str:
    return "CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType"


def _property_keys_statement() -> Optional[str]:
    # Unused today (see module docstring) -- same YIELD/RETURN convention
    # as the two catalogue statements above, for consistency.
    return "CALL db.propertyKeys() YIELD propertyKey RETURN propertyKey"


def _indexes_statement() -> Optional[str]:
    return "CALL db.indexes()"


def _parse_index_rows(rows: Sequence[Sequence[Any]]) -> List[IndexInfo]:
    """Version-tolerant positional parse of a ``CALL db.indexes()`` result.

    This is the row-shape half of what was ``SchemaMixin.
    _log_aggregation_index_health``'s parsing loop before this task
    (``schema.py``, the block under the "FalkorDB row column order
    historically..." comment) -- normalizes each row into an
    ``IndexInfo``. The categorization half (what counts as an AGGREGATED
    edge index, or a urn node index) is aggregation-specific business
    logic, not a FalkorDB column-layout fact, and stays in
    ``_log_aggregation_index_health`` operating on this method's output.

    Column order: label, properties, types, language, stopwords,
    entitytype, info -- read positionally with length guards because a
    FalkorDB build may return fewer columns than expected. Do NOT
    simplify away the ``len(row) > N`` guards: they are the
    compatibility this dialect object exists to represent, not defensive
    noise. A falsy row (``None``, ``[]``, ``()``) is skipped, matching
    the original ``if not row: continue``.
    """
    parsed: List[IndexInfo] = []
    for row in rows:
        if not row:
            continue
        label = row[0] if len(row) > 0 else None
        props = row[1] if len(row) > 1 else None
        entity_type_col = row[5] if len(row) > 5 else None

        # Normalize: label may be None / "" for unlabeled indexes.
        # props is typically a list of strings.
        prop_list: List[str] = []
        if isinstance(props, (list, tuple)):
            prop_list = [str(p) for p in props]
        elif isinstance(props, str):
            prop_list = [props]

        is_edge_index = False
        if isinstance(entity_type_col, str):
            is_edge_index = entity_type_col.upper().startswith("RELAT")

        parsed.append(IndexInfo(label=label, props=prop_list, is_edge_index=is_edge_index))
    return parsed


def _create_node_index(label: str, prop: str) -> str:
    # Every real call site indexes exactly one label + one property --
    # unlike the edge-index DDL below, FalkorDB never composite-indexes a
    # node label in this codebase, so this deliberately does not take a
    # props sequence.
    return f"CREATE INDEX FOR (n:{label}) ON (n.{prop})"


def _create_edge_index(rel_type: str, props: Sequence[str]) -> str:
    # Renders ONE statement; the caller (schema.py's ensure_indices) keeps
    # the list of six calls and their order -- composite first, singles
    # after -- because that order encodes a version-compatibility
    # fallback, not a seek-shape optimization. See schema.py:242-258's own
    # comment for why, and task-14-brief.md's "Correcting my own note" for
    # why that -- not "FalkorDB won't use a composite index for a single
    # seek" -- is the real reason.
    cols = ", ".join(f"r.{p}" for p in props)
    return f"CREATE INDEX FOR ()-[r:{rel_type}]-() ON ({cols})"


def _create_unlabeled_index(prop: str) -> Optional[str]:
    return f"CREATE INDEX FOR (n) ON (n.{prop})"


def _is_index_exists_error(exc: BaseException) -> bool:
    # The most engine-specific predicate in the dialect: a substring match
    # on FalkorDB's own error-message text, not a shared exception type.
    # A second engine's re-issued-index message differs, or -- ArcadeDB,
    # whose DDL takes IF NOT EXISTS -- may never raise here at all.
    return "already indexed" in str(exc).lower()


def _fulltext_create(label: str, props: Sequence[str]) -> Optional[str]:
    # Unused today -- deep search matches via CONTAINS on searchableText,
    # not a fulltext index (see module docstring).
    prop_list = ", ".join(f"'{p}'" for p in props)
    return f"CALL db.idx.fulltext.createNodeIndex('{label}', {prop_list})"


def _fulltext_query(label: str, prop: str, param_name: str) -> Optional[str]:
    # Unused today -- see _fulltext_create. `prop` is accepted for
    # signature symmetry with `fulltext_create` (which index to query
    # against on engines where a label can carry more than one fulltext
    # index); FalkorDB's queryNodes call takes only the index name.
    return f"CALL db.idx.fulltext.queryNodes('{label}', ${param_name})"


def _first_label_expr(var: str) -> str:
    return f"labels({var})[0]"


def _node_id_expr(var: str) -> str:
    return f"ID({var})"


def _edge_id_expr(var: str) -> str:
    return f"id({var})"


def _edge_type_expr(var: str) -> str:
    return f"type({var})"


def _label_union(labels: Sequence[str], where: str) -> str:
    """The ``CALL { … UNION … }`` builder shared by all six label-union
    read sites (browse.py x2, navigation.py, reads.py x3). Returns only
    the wrapper -- each caller appends its own tail (ORDER BY / SKIP /
    LIMIT / RETURN, or a childCount OPTIONAL MATCH).

    ``labels`` must already be sanitized/trusted -- this performs no
    escaping itself. Every current call site sanitizes (via
    ``rowmap._sanitize_label``) before calling this; a future caller
    passing a raw, unsanitized, user-supplied label injects directly into
    Cypher.
    """
    branches = " UNION ".join(f"MATCH (n:{label}){where} RETURN n" for label in labels)
    return "CALL { " + branches + " }"


def _no_incoming_pattern(var: str, rel_alt: str) -> str:
    """``NOT (var)<-[:rel_alt]-()`` -- structurally anchored on ``var``,
    NOT the equally-correct-looking ``NOT ()-[:rel_alt]->(var)``.

    Both read as "no incoming rel_alt edge to var" and are semantically
    identical; they are not operationally identical. With the
    already-bound ``var`` as the pattern's anchor, FalkorDB's planner
    walks its incoming adjacency list directly instead of scanning every
    ``rel_alt``-typed relationship in the graph -- avoiding an O(N)
    full-graph scan that was a top CPU contributor under load (see
    ``browse.py``'s ``get_top_level_or_orphan_nodes``, the one caller).
    The anchor is structural here (the bound variable is the parameter,
    and the render always puts it on the left), not incidental, precisely
    so a future edit cannot "normalize" it back to the natural-looking
    but slower form.

    This form also stands in for `NOT EXISTS { MATCH ... }` (Neo4j 4.x+ /
    ISO GQL), which FalkorDB does NOT support: that form silently throws,
    is caught, and returns empty -- the original bug this pattern-negation
    predicate replaced. See ``supports_exists_subquery``.
    """
    return f"NOT ({var})<-[:{rel_alt}]-()"


def _edge_id_cursor_page(id_expr: str) -> Tuple[str, str]:
    return (f"WHERE {id_expr} >= $after", f"ORDER BY {id_expr}")


FALKORDB_DIALECT = CypherDialect(
    name="falkordb",
    identifier_case_sensitive=True,
    label_scoped_indexes_only=True,
    supports_unlabeled_property_index=None,
    supports_call_subquery=True,
    supports_union_in_subquery=True,
    supports_exists_subquery=False,
    supports_pattern_predicate_negation=True,
    supports_list_params=True,
    supports_o1_counts=True,
    timeout_mode="server_param_ms",
    unknown_label_match="empty",
    labels_statement=_labels_statement,
    relationship_types_statement=_relationship_types_statement,
    property_keys_statement=_property_keys_statement,
    indexes_statement=_indexes_statement,
    parse_index_rows=_parse_index_rows,
    create_node_index=_create_node_index,
    create_edge_index=_create_edge_index,
    create_unlabeled_index=_create_unlabeled_index,
    is_index_exists_error=_is_index_exists_error,
    fulltext_create=_fulltext_create,
    fulltext_query=_fulltext_query,
    first_label_expr=_first_label_expr,
    node_id_expr=_node_id_expr,
    edge_id_expr=_edge_id_expr,
    edge_type_expr=_edge_type_expr,
    label_union=_label_union,
    no_incoming_pattern=_no_incoming_pattern,
    edge_id_cursor_page=_edge_id_cursor_page,
)
