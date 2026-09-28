"""The uncapped search engine for FalkorDB.

``execute_deep_search`` scanned a capped candidate set; this package scans
every match, in chunks of the graph small enough to report progress, share
the engine fairly and be cancelled — and still returns an exact count and a
globally ordered page. The measurements behind every choice here are in
``docs/search-engine/S0_FINDINGS.md``.

* ``keys``       — the order, as Cypher sort keys Python can merge;
* ``relevance``  — the relevance score as a Cypher expression;
* ``plan``       — which parts of the graph a search reads, and how;
* ``session``    — a search's progress, shared across requests;
* ``engine``     — runs a request's share of a session.
"""
