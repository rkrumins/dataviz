"""Dialect conformance suite — SPECIFICATION ONLY. No code below this
docstring; PR 3 fills it in.

This module is a placeholder. It exists so PR 3 implements the dialect
conformance suite against a design that is already agreed, rather than
designing while implementing -- see plan §6.4 part (3),
``docs/superpowers/plans/2026-08-30-pr2-provider-catalog-contract.md``.

Why this is PR 3's work, not PR 2's, and why -- corrected
--------------------------------------------------------

An earlier draft of that plan deferred this suite on the grounds that
the ``CypherExecutor`` / ``CypherDialect`` types "do not exist yet".
That justification was wrong and was corrected in the plan's §10.4: both
types already exist, at
``backend/common/providers/cypher/{executor,dialect}.py`` (PR 1 shipped
them). Do not repeat that claim.

The real reason this suite waits for PR 3: it tests a ``CypherDialect``
implementation by running its probes through the ``CypherGraphProvider``
base class against a live instance -- and that base class is what does
not exist yet. There is nothing to subclass or instantiate against
until PR 3 lands it, even though the seam types it will be built on are
already here.

Shape, once implemented
------------------------

One ``test_<type>_dialect_conformance.py`` per Cypher provider (FalkorDB,
Neo4j today; PR 3's ArcadeDB), gated the same way its contract test is
(``_runner.make_contract_test``'s ``<PREFIX>_HOST`` + TCP reachability
check) -- no live instance, no test, skipped rather than failed. Each
probe runs against the same seeded fixture the live contract harness
uses (``backend.tests.regression.fixtures``) and asserts the dialect's
*declared* flag equals *observed* reality in **both directions**:
declared ``True`` but the probe fails -> fail; declared ``False`` but
the probe actually works -> fail with "dialect is over-conservative" (an
under-declared dialect silently forfeits a real capability, which is as
real a bug as an over-declared one that lies).

The seven probes
-----------------

+-------------------------+----------------------------------------------------+---------------------------------------------------------------------+
| point                    | probe                                              | dialect surface it checks                                            |
+==========================+=====================================================+========================================================================+
| introspection statements | run ``labels_statement()``,                        | results ⊇ ``{domain, schema, dataset}`` /                            |
|                          | ``relationship_types_statement()``,                | ``{CONTAINS, DERIVES_FROM}`` / ``{urn, displayName}``                |
|                          | ``property_keys_statement()``                      |                                                                        |
+--------------------------+-----------------------------------------------------+------------------------------------------------------------------------+
| index DDL                | run ``create_index_statement("dataset", "urn")``   | second run must not raise iff                                        |
|                          | twice, then ``list_indexes_statement()``           | ``supports_index_if_not_exists``; index listed                       |
+--------------------------+-----------------------------------------------------+------------------------------------------------------------------------+
| fulltext                 | ``fulltext_create_statement`` +                    | returns ``d1..d3`` iff ``supports_fulltext``; when False the         |
|                          | ``fulltext_query_statement("Dataset")``            | builder raises ``DialectUnsupported`` and ``search_nodes`` still     |
|                          |                                                     | finds them via the CONTAINS fallback                                 |
+--------------------------+-----------------------------------------------------+------------------------------------------------------------------------+
| id / labels functions    | ``RETURN {node_id_expr("n")}, {labels_expr("n")}`` | id is ``int`` or ``str``; labels contain ``domain``                   |
|                          | on the root node                                   |                                                                        |
+--------------------------+-----------------------------------------------------+------------------------------------------------------------------------+
| list params              | ``MATCH (n) WHERE n.urn IN $urns RETURN count(n)`` | 2 iff ``supports_list_params``; otherwise the ``inline_list()``      |
|                          | with a 2-element list                              | rewrite yields 2                                                      |
+--------------------------+-----------------------------------------------------+------------------------------------------------------------------------+
| unknown-label MATCH      | ``MATCH (n:NoSuchLabel) RETURN count(n)``          | returns 0 iff not ``unknown_label_raises``; raises the dialect's     |
|                          |                                                     | declared error class otherwise                                       |
+--------------------------+-----------------------------------------------------+------------------------------------------------------------------------+
| count                    | ``count_statement("dataset")`` and                 | 3; ``get_counts_fast()`` non-None iff                                 |
|                          | ``get_counts_fast()``                              | ``supports_constant_time_counts`` (FalkorDB's ``reduce_count`` --     |
|                          |                                                     | see memory ``falkordb-reduce-count-o1-counts``)                       |
+--------------------------+-----------------------------------------------------+------------------------------------------------------------------------+

PR 3 adds the fixture/gate plumbing and one test function per probe row
above; nothing in this file is executed by pytest (no ``test_*`` name,
no code).
"""
