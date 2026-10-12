"""The graph store's own picture: every node, shard, replica and graph.

One cached snapshot answers every surface that used to guess — the
infrastructure probe saw only the environment's primaries, and the rollup
capacity sweep saw only nodes that happened to own a rollup graph.
"""
from .topology import (  # noqa: F401
    cached_snapshot,
    get_topology_snapshot,
    instance_for_provider,
    invalidate_topology_cache,
    key_slot,
    place,
    placement_for_graph,
    placement_keys_for,
    reading_of,
)
