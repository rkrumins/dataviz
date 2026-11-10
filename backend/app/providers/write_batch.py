"""Many graph writes in one request, as one commit (doc 19 §3.8).

``POST /graph/commands/batch`` runs its commands through the graph engine one at a time, and
each command's write used to be its own commit. A script that sent a hundred commands in one
request left a hundred commits in history, and the change it made was hard to find among them.

Inside :func:`deferring`, a versioned provider holds each write instead of committing it. The
first provider to write owns the batch. The route then commits everything the commands wrote
with one :meth:`commit_deferred`, in the order they wrote it — ops on one entity compose, as they
do in any batch.

While the batch is open, a node a command created can be read back (:func:`node`), and an edge a
command created can be deleted (:func:`has_edge`), as when each write committed at once. A
provider that needs a write's committed answer (an edge's update) commits what it holds with it,
in order.
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Optional, Set


@dataclass
class WriteBatch:
    owner: Any = None                                       # the provider that commits it
    ops: List[dict] = field(default_factory=list)
    nodes: Dict[str, Any] = field(default_factory=dict)     # urn → the node a command created
    edges: Set[str] = field(default_factory=set)            # ids of edges a command created

    def take(self, provider: Any, ops: List[dict]) -> bool:
        """Hold ``ops`` for ``provider``: True when held. Only the batch's owner's writes are held."""
        if self.owner is None:
            self.owner = provider
        if self.owner is not provider:
            return False
        self.ops.extend(ops)
        return True

    def drain(self) -> List[dict]:
        ops, self.ops = self.ops, []
        return ops


_current: ContextVar[Optional[WriteBatch]] = ContextVar("graph_write_batch", default=None)


@contextmanager
def deferring() -> Iterator[WriteBatch]:
    """Hold this request's versioned writes in one batch until the caller commits it."""
    batch = WriteBatch()
    token = _current.set(batch)
    try:
        yield batch
    finally:
        _current.reset(token)


def current() -> Optional[WriteBatch]:
    return _current.get()


def held(node: Optional[Any], edge: Optional[Any]) -> None:
    """Note that the open batch now holds ``node`` / ``edge`` (a provider's create), so a later
    command in it can read the node back or delete the edge. Outside a batch, nothing."""
    batch = _current.get()
    if batch is None:
        return
    if node is not None:
        batch.nodes[node.urn] = node
    if edge is not None:
        batch.edges.add(edge.id)


def node(urn: str) -> Optional[Any]:
    """The node a command in the open batch created as ``urn``, if any."""
    batch = _current.get()
    return batch.nodes.get(urn) if batch is not None else None


def has_edge(edge_id: str) -> bool:
    """Whether a command in the open batch created the edge ``edge_id``."""
    batch = _current.get()
    return batch is not None and edge_id in batch.edges
