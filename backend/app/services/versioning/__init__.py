"""Versioned graph editing — Git-style drafts, squash-merge, audit & time-travel.

This package owns the ``graphver`` durable store (Postgres source of truth) and
the logic that projects the linear ``main`` trunk into FalkorDB as an
eventually-consistent read cache.  See ``plans/we-want-to-build-starry-seal.md``
for the full design.

The modules in here are deliberately layered so the pure-logic core
(:mod:`merkle`, :mod:`merge`, :mod:`ids`) has **no** dependency on SQLAlchemy,
FalkorDB, or the rest of the app — it is unit-testable in isolation.
"""
