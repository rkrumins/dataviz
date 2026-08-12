"""The /trace/expand WIRE CONTRACT for structural drills.

These tests exist because every layer of this path was correct in
isolation while the contract between them was broken, and the failure
only surfaced against a live deployment: the Focus Lens could not walk
the containment tree for ANY focal.

Three independent faults, one per layer:

1. ``ExpandRequest.next_level`` was ``Union[str, int]`` — a request
   carrying ``nextLevel: null`` failed Pydantic validation with a 422
   before any application code ran. An ontology that repeats an entity
   type at two containment depths (``Container`` inside ``Container``)
   has no honest level to send, so this 422'd exactly the estates the
   structural drill was built for.
2. ``ContextEngine.expand_aggregated_edge`` pushed ``next_level``
   through ``_resolve_level``, whose ``"auto"`` fallback COERCED None
   into the source node's own level — so even a valid level-less
   request reached the provider as a level-pair query, and the
   structural path was unreachable through the engine.
3. ``use_raw = level >= finest_level`` raised ``TypeError`` on None.

The provider's own behaviour behind this contract is covered in
``test_falkordb_trace_structural.py``; here we pin the two layers in
front of it.
"""
import asyncio

from backend.app.services.context_engine import ContextEngine
from backend.common.models.graph import ExpandRequest, TraceResult, TraceFocus


def _run(coro):
    return asyncio.run(coro)


# ── Layer 1: request validation ────────────────────────────────────────


def test_next_level_may_be_absent():
    req = ExpandRequest.model_validate({"sourceUrn": "dom", "targetUrn": "tbl"})
    assert req.next_level is None


def test_next_level_may_be_null():
    # Clients that send the key with an explicit null must not 422 —
    # JSON.stringify keeps null keys, and older frontends did exactly that.
    req = ExpandRequest.model_validate(
        {"sourceUrn": "dom", "targetUrn": "tbl", "nextLevel": None}
    )
    assert req.next_level is None


def test_drill_anchor_round_trips():
    req = ExpandRequest.model_validate(
        {"sourceUrn": "dom", "targetUrn": "tbl", "drillAnchor": "dom"}
    )
    assert req.drill_anchor == "dom"
    # And serializes back under the wire alias, for the response cache key.
    assert req.model_dump(mode="json", by_alias=True)["drillAnchor"] == "dom"


def test_integer_levels_still_validate():
    req = ExpandRequest.model_validate(
        {"sourceUrn": "a", "targetUrn": "b", "nextLevel": 3}
    )
    assert req.next_level == 3


# ── Layer 2: the engine must let None SURVIVE to the provider ──────────


class _CapturingProvider:
    def __init__(self):
        self.calls = []

    async def expand_aggregated(self, **kwargs):
        self.calls.append(kwargs)
        return TraceResult(
            nodes=[], edges=[], containmentEdges=[],
            upstreamUrns=set(), downstreamUrns=set(),
            focus=TraceFocus(urn=kwargs["source_urn"], level=0, entityType="x"),
            effectiveLevel=0, isInherited=False, inheritedFromUrn=None,
            truncated=False, truncationReason=None,
        )

    async def get_node(self, urn):  # _resolve_level's "auto" branch
        return None


class _Ontology:
    lineage_edge_types = ["FLOWS"]
    containment_edge_types = ["HAS"]
    entity_type_definitions: dict = {}


def _make_engine(provider):
    # The real class, minus its constructor: expand_aggregated_edge only
    # touches `provider`, `_resolve_ontology`, the semaphore (which
    # getattr-degrades on a bare instance) and its own helpers.
    eng = object.__new__(ContextEngine)
    eng.provider = provider

    async def _resolve_ontology():
        return _Ontology()

    eng._resolve_ontology = _resolve_ontology
    return eng


def test_engine_forwards_none_level_and_drill_anchor():
    provider = _CapturingProvider()
    eng = _make_engine(provider)
    req = ExpandRequest.model_validate(
        {"sourceUrn": "dom", "targetUrn": "tbl", "drillAnchor": "dom"}
    )
    _run(ContextEngine.expand_aggregated_edge(eng, req))
    call = provider.calls[0]
    # None must reach the provider AS None — _resolve_level's "auto"
    # fallback used to rewrite it into the source's own level, which
    # silently turned the structural request back into the level-pair
    # query the caller was avoiding.
    assert call["next_level"] is None
    assert call["drill_anchor"] == "dom"
    # And the finest-level comparison must not have crashed on None.
    assert call["use_raw_edges"] is False


def test_engine_still_resolves_integer_levels():
    provider = _CapturingProvider()
    eng = _make_engine(provider)
    req = ExpandRequest.model_validate(
        {"sourceUrn": "a", "targetUrn": "b", "nextLevel": 2}
    )
    _run(ContextEngine.expand_aggregated_edge(eng, req))
    assert provider.calls[0]["next_level"] == 2
    assert provider.calls[0]["drill_anchor"] is None
