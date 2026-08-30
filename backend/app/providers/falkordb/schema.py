"""Per-server schema/index memo state.

Moved unchanged from the pre-class section of the former
``falkordb_provider.py`` (lines 49-54 as of the package move).
``SchemaMixin`` (the methods that read these) lands in a later task; this
module exists now so both this task's imports and that later mixin agree
on where the memo sets live.
"""

# Per-server (host, port) facts we only need to discover / report ONCE, so onboarding
# many graphs against the same FalkorDB doesn't re-probe and re-log the same thing on
# every graph. Whether a FalkorDB build supports a label-less property index, and whether
# we've already logged its index-health summary, are server-level — not per-graph.
_UNLABELED_URN_UNSUPPORTED: set = set()
_INDEX_HEALTH_LOGGED: set = set()
