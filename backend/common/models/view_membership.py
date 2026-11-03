"""Membership — which entities a set of seeds and an expansion name.

ONE contract behind every surface that asks "what is in scope": the Context View's
Narrow filter today; saving a view from a query, keeping it live as the data
changes, exporting a chosen subset and the public API next. It is deliberately
small, versioned and portable:

* ``seeds`` are entities named by URN, or an Advanced Search predicate (the same
  model searches and display rules speak — so a seed can name an entity by its
  path of names and mean the same thing in every environment, and "every entity
  in the Gold layer" is just a ``layer`` predicate);
* ``expand`` says what the seeds pull in: what is inside them, their sources and
  consumers to a depth or the whole way, and what is inside those partners;
* ``within`` bounds where query seeds are looked for: the view's own boundary, or
  the whole data source.

A spec has one canonical form, and its hash (``specHash``) is its identity —
the cache key every user asking the same question shares, the share link a
narrowing travels as, and (later) the definition a live view keeps.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator

from backend.common.models.search import Predicate

#: Seeds a spec may name or a query may find. Matches the search's own cap on
#: a curated view's roots (DEEP_SEARCH_SCOPE_ROOT_URNS_CAP) and its page size.
SEEDS_MAX = 5000

#: Lineage depth one closure step walks; "all" keeps re-rooting the frontier.
LINEAGE_DEPTH_MAX = 25

Depth = Union[Literal["all"], int]


class _Base(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class MembershipSeeds(_Base):
    """Where the scope starts: entities by URN, or what a query finds — not both."""
    urns: Optional[List[str]] = Field(None, max_length=SEEDS_MAX)
    query: Optional[Predicate] = None

    @model_validator(mode="after")
    def _one_kind(self) -> "MembershipSeeds":
        if (self.urns is None) == (self.query is None):
            raise ValueError("seeds names urns or a query — exactly one")
        if self.urns is not None and not any(u.strip() for u in self.urns):
            raise ValueError("seeds.urns names no entity")
        return self


class MembershipExpand(_Base):
    """What the seeds pull in.

    ``children`` — what is inside each seed: 0 (nothing), 1 or 2 levels, or "all"
    (everything inside, never enumerated: those seeds are listed in
    ``wholeSubtree``). ``upstream`` / ``downstream`` — lineage hops each way, 0 to
    25, or "all" for the entire trace. ``partnerChildren`` — what is inside the
    sources and consumers found: 0, 1 level, or "all". Lineage is walked as the
    trace walks it: raw lineage at the finest grain, a container seed through
    the entities inside it that carry lineage, never a rollup or containment.
    """
    children: Depth = 0
    upstream: Depth = 0
    downstream: Depth = 0
    partner_children: Depth = Field(0, alias="partnerChildren")

    @model_validator(mode="after")
    def _ranges(self) -> "MembershipExpand":
        for name, value, top in (
            ("children", self.children, 2),
            ("partnerChildren", self.partner_children, 1),
            ("upstream", self.upstream, LINEAGE_DEPTH_MAX),
            ("downstream", self.downstream, LINEAGE_DEPTH_MAX),
        ):
            if value == "all":
                continue
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= top:
                raise ValueError(f"expand.{name} is 0 to {top}, or 'all'")
        return self


class MembershipSpec(_Base):
    """A scope: seeds, how far they reach, and where query seeds are looked for."""
    version: Literal[1] = Field(1, alias="v")
    seeds: MembershipSeeds
    within: Literal["view", "dataSource"] = "view"
    expand: MembershipExpand = Field(default_factory=MembershipExpand)

    def canonical(self) -> "MembershipSpec":
        """The same scope, written one way: seed URNs de-duplicated and sorted."""
        if self.seeds.urns is None:
            return self
        urns = sorted({u.strip() for u in self.seeds.urns if u.strip()})
        return self.model_copy(update={"seeds": self.seeds.model_copy(update={"urns": urns})})

    def spec_hash(self) -> str:
        """The scope's identity: a hash of its canonical JSON."""
        canonical = self.canonical().model_dump(mode="json", by_alias=True, exclude_none=True)
        blob = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(blob.encode()).hexdigest()[:32]


class MembershipRequest(_Base):
    """``POST /{ws_id}/graph/members`` — resolve a scope over one view's data source.

    ``viewId`` (the query parameter) is the view the scope is read in: its
    boundary bounds query seeds when ``within`` is ``view``. ``includeMembers``
    false answers the counts alone (the composer's live preview).
    """
    spec: MembershipSpec
    include_members: bool = Field(True, alias="includeMembers")


Via = Literal["seed", "inside", "upstream", "downstream", "partnerInside"]


class MemberEntry(_Base):
    """One entity in scope, and why: a seed; inside a seed; a source or consumer
    ``hops`` lineage steps from the seeds; or inside one of those."""
    urn: str
    via: Via
    hops: Optional[int] = None


class MembershipCounts(_Base):
    """How many each part of the expansion added (an entity is counted once, by
    the first reason it is in scope). ``inside`` / ``partnerInside`` are None when
    that part is "everything inside" — not enumerated, so not counted."""
    seeds: int = 0
    inside: Optional[int] = 0
    upstream: int = 0
    downstream: int = 0
    partner_inside: Optional[int] = Field(0, alias="partnerInside")
    total: int = 0


class MembershipTruncation(_Base):
    """Where a limit stopped the resolution — said, never silent. ``seen`` is how
    many it had when it stopped (at least), ``limit`` the limit it hit.

    A cap (``seed_cap``, ``member_cap``, ``trace_cap``, ``chains_cap``) gives the same
    answer every time it is asked. ``deadline`` (the resolution's time ran out) and
    ``incomplete`` (a graph read inside it gave up) may not: asking again may answer more."""
    reason: Literal["seed_cap", "member_cap", "trace_cap", "deadline", "incomplete", "chains_cap"]
    seen: int
    limit: int


#: Truncations a second ask may improve on — the answer is short, not capped.
RETRYABLE = frozenset({"deadline", "incomplete"})


class MembershipResult(_Base):
    """A resolved scope.

    ``members`` — every entity in scope with why (up to the member cap).
    ``wholeSubtree`` — members whose everything-inside is in scope too, without
    being listed: anything below one of these is in scope. ``chains`` — each
    listed member's containment ancestors, PARENT FIRST and top-level last (the
    provider's own order; a top-level entity maps to ``[]``, an entity the
    provider could not answer for is absent), so a canvas can show the
    containers that hold the scope and open the way to it. ``dataVersion`` is
    the graph data it was resolved on.
    """
    spec_hash: str = Field(alias="specHash")
    members: List[MemberEntry] = Field(default_factory=list)
    whole_subtree: List[str] = Field(default_factory=list, alias="wholeSubtree")
    chains: Dict[str, List[str]] = Field(default_factory=dict)
    counts: MembershipCounts = Field(default_factory=MembershipCounts)
    missing_seeds: int = Field(0, alias="missingSeeds")
    truncated: List[MembershipTruncation] = Field(default_factory=list)
    data_version: str = Field("", alias="dataVersion")
    elapsed_ms: int = Field(0, alias="elapsedMs")

    @property
    def degraded_detail(self) -> Optional[str]:
        """Why this answer is short in a way asking again may fix, else None. The graph
        cache reads it as it reads every answer's: a degraded answer is kept for seconds,
        never as last-known-good — a cap is the answer, and keeps the full TTL."""
        return ", ".join(t.reason for t in self.truncated if t.reason in RETRYABLE) or None


# ═══════════════════════════════════════════════════════════════════════════
# A view made from a query — its definition (``config.membership``) and the
# routes that create it, read its state and change it.
#
# The view is an ordinary curated view: its members are assignment entries the
# server writes (``assignedBy: "query"``) and keeps in step with the data, beside
# the entries people place themselves ("Always include"). The definition is the
# portable part — it travels in view files and versions; the members do not
# (they are data, not design: see ``view_transfer.canonical``).
# ═══════════════════════════════════════════════════════════════════════════

#: The assignment marker of an entry the server owns.
MACHINE = "query"
#: Sources one view may be made from: the main query, plus whole layers.
SOURCES_MAX = 8
#: Entities a view keeps out, and per-entity choices it remembers.
EXCLUDE_MAX = 2000
OVERRIDES_MAX = 2000

Mode = Literal["live", "snapshot"]
LayoutKind = Literal["source", "template", "auto", "stages", "custom"]
Origin = Literal["narrow", "search", "savedQuery", "wizard", "api"]


def _sha(value: object) -> str:
    blob = json.dumps(value, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()[:32]


class MembershipSource(_Base):
    """One query the view's members come from. A query is searched IN a view —
    ``readIn``, normally the view it was made from, never the view itself (a view's
    own type allow-list would hold its search to the types it already shows).
    ``layerId`` places this source's members in one of the view's layers (a whole
    source layer brought in as is)."""
    spec: MembershipSpec
    read_in: Optional[str] = Field(None, alias="readIn")
    layer_id: Optional[str] = Field(None, alias="layerId")
    label: Optional[str] = Field(None, max_length=200)

    @model_validator(mode="after")
    def _searched_somewhere(self) -> "MembershipSource":
        if self.spec.seeds.query is not None and not self.read_in:
            raise ValueError("a query source names the view it is searched in (readIn)")
        return self


class MembershipLayout(_Base):
    """How members are arranged: like the view it was made from (``source``), by a
    template's rules, by top-level type (``auto``), by lineage distance
    (``stages``), or in layers the client sent (``custom``). ``nest`` draws each
    member inside its containers."""
    kind: LayoutKind = "source"
    nest: bool = True
    source_view_id: Optional[str] = Field(None, alias="sourceViewId")
    template_id: Optional[str] = Field(None, alias="templateId")
    fallback_layer_id: Optional[str] = Field(None, alias="fallbackLayerId")
    link: Optional[Dict[str, Any]] = None


class MembershipOverride(_Base):
    """Where a person put a member, kept across every update."""
    layer_id: Optional[str] = Field(None, alias="layerId")
    order_key: Optional[str] = Field(None, alias="orderKey", max_length=256)
    logical_node_id: Optional[str] = Field(None, alias="logicalNodeId")
    at: Optional[str] = None


class MembershipProvenance(_Base):
    origin: Origin = "api"
    view_id: Optional[str] = Field(None, alias="viewId")
    saved_query_id: Optional[str] = Field(None, alias="savedQueryId")
    created_at: Optional[str] = Field(None, alias="createdAt")
    created_by: Optional[str] = Field(None, alias="createdBy")


class MembershipDefinition(_Base):
    """``config.membership``: what the view's members are, and how they are kept.

    ``mode`` ``live`` keeps the members in step with the data; ``snapshot`` leaves
    them as they were (and can be resumed). ``exclude`` keeps entities out whatever
    the query finds; ``overrides`` remembers where people put members."""
    version: Literal[1] = Field(1, alias="v")
    mode: Mode = "live"
    sources: List[MembershipSource] = Field(..., min_length=1, max_length=SOURCES_MAX)
    layout: MembershipLayout = Field(default_factory=MembershipLayout)
    exclude: List[str] = Field(default_factory=list, max_length=EXCLUDE_MAX)
    overrides: Dict[str, MembershipOverride] = Field(default_factory=dict)
    provenance: MembershipProvenance = Field(default_factory=MembershipProvenance)

    def resolution_hash(self) -> str:
        """The identity of the expensive part — what the sources resolve to. A
        refresh that finds it changed under it throws its answer away."""
        return _sha([[s.spec.spec_hash(), s.read_in or "", s.layer_id or ""] for s in self.sources])

    def definition_hash(self) -> str:
        """The identity of the whole definition — the compare-and-swap token of an edit."""
        body = self.model_dump(mode="json", by_alias=True, exclude_none=True)
        body["exclude"] = sorted(set(body.get("exclude", [])))
        return _sha(body)


def read_definition(config: Dict[str, Any]) -> Optional[MembershipDefinition]:
    """The view's definition, or None when it has none — or one this server cannot
    read (a hand-edited file, a newer format): such a view is left as it is."""
    raw = (config or {}).get("membership")
    if not isinstance(raw, dict):
        return None
    try:
        return MembershipDefinition.model_validate(raw)
    except ValueError:
        return None


class FromMembersRequest(_Base):
    """``POST /views/from-members`` — make a view from one or more queries.

    The label fields are a view's own (``ViewCreateRequest``). ``layers`` are the
    client's for a ``template``/``custom`` layout; ``keep`` decides, for a
    ``source`` layout, whether layers that hold no member are kept."""
    name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = Field(None, max_length=2000)
    icon: Optional[str] = Field(None, max_length=64)
    tags: Optional[List[str]] = None
    visibility: str = "private"
    workspace_id: str = Field(alias="workspaceId")
    data_source_id: Optional[str] = Field(None, alias="dataSourceId")
    mode: Mode = "live"
    sources: List[MembershipSource] = Field(..., min_length=1, max_length=SOURCES_MAX)
    layout: MembershipLayout = Field(default_factory=MembershipLayout)
    layers: Optional[List[Dict[str, Any]]] = None
    keep: Literal["withResults", "all"] = "withResults"
    exclude: List[str] = Field(default_factory=list, max_length=EXCLUDE_MAX)
    provenance: MembershipProvenance = Field(default_factory=MembershipProvenance)
    context_model_id: Optional[str] = Field(None, alias="contextModelId")
    context_model_version: Optional[int] = Field(None, alias="contextModelVersion")


class PlanRequest(_Base):
    """``POST /{ws}/graph/members/plan`` — what saving would make, nothing saved."""
    sources: List[MembershipSource] = Field(..., min_length=1, max_length=SOURCES_MAX)
    layout: MembershipLayout = Field(default_factory=MembershipLayout)
    layers: Optional[List[Dict[str, Any]]] = None
    keep: Literal["withResults", "all"] = "withResults"
    exclude: List[str] = Field(default_factory=list, max_length=EXCLUDE_MAX)


class PlanLayer(_Base):
    id: str
    name: str
    color: Optional[str] = None
    count: int = 0
    link_layer_id: Optional[str] = Field(None, alias="linkLayerId")
    kept: bool = True


class MembershipPlan(_Base):
    """What a view made from these sources would hold: entries against the limit
    (members + the containers drawn around them + always-included), per layer."""
    keys: int
    members: int
    containers: int
    included: int = 0
    limit: int
    over_cap: bool = Field(False, alias="overCap")
    layers: List[PlanLayer] = Field(default_factory=list)
    fallback: int = 0
    truncated: List[MembershipTruncation] = Field(default_factory=list)
    missing_seeds: int = Field(0, alias="missingSeeds")
    data_version: str = Field("", alias="dataVersion")


Status = Literal["pending", "updating", "ok", "partial", "over_cap", "held", "failed",
                 "source_missing", "frozen"]


class ReadInView(_Base):
    view_id: str = Field(alias="viewId")
    name: Optional[str] = None
    available: bool = True


class MembershipStatus(_Base):
    """``GET /views/{id}/membership`` — the definition, and how keeping it is going."""
    mode: Mode
    status: Status
    detail: Optional[Dict[str, Any]] = None
    revision: int = 0
    definition: MembershipDefinition
    definition_hash: str = Field(alias="definitionHash")
    counts: Optional[Dict[str, Any]] = None
    keys: int = 0
    limit: int = 0
    last_applied_at: Optional[str] = Field(None, alias="lastAppliedAt")
    last_diff: Optional[Dict[str, Any]] = Field(None, alias="lastDiff")
    truncated: List[MembershipTruncation] = Field(default_factory=list)
    read_in: List[ReadInView] = Field(default_factory=list, alias="readIn")
    always_included: List[str] = Field(default_factory=list, alias="alwaysIncluded")
    excluded: List[str] = Field(default_factory=list)


class MembershipUpdate(_Base):
    """``PUT /views/{id}/membership`` — change the definition, against the hash it
    was read at."""
    if_definition_hash: str = Field(alias="ifDefinitionHash")
    mode: Optional[Mode] = None
    sources: Optional[List[MembershipSource]] = Field(None, min_length=1, max_length=SOURCES_MAX)
    layout: Optional[MembershipLayout] = None
    exclude: Optional[List[str]] = Field(None, max_length=EXCLUDE_MAX)


class IncludeMember(_Base):
    urn: str = Field(..., min_length=1)
    layer_id: str = Field(alias="layerId")


class MemberOps(_Base):
    """``POST /views/{id}/membership/members`` — keep entities out, bring them back,
    always include them, or stop."""
    exclude: List[str] = Field(default_factory=list, max_length=EXCLUDE_MAX)
    unexclude: List[str] = Field(default_factory=list, max_length=EXCLUDE_MAX)
    include: List[IncludeMember] = Field(default_factory=list, max_length=EXCLUDE_MAX)
    uninclude: List[str] = Field(default_factory=list, max_length=EXCLUDE_MAX)


RefreshOutcome = Literal["applied", "unchanged", "current", "held", "over_cap", "deferred", "busy",
                         "fenced", "source_missing", "failed"]


class RefreshResult(_Base):
    """``POST /views/{id}/membership/refresh`` — what the update did, and how
    keeping the view up to date stands after it. ``held``: a large removal waits
    for ``?confirmRemovals=true``; ``deferred``: the graph answered short, so the
    view kept its members; ``busy``: another update is working on it;
    ``current``: opened, and nothing to do (``detail.reason``: ``up_to_date``,
    ``recent``, ``held`` or ``snapshot``)."""
    outcome: RefreshOutcome
    detail: Dict[str, Any] = Field(default_factory=dict)
    diff: Optional[Dict[str, Any]] = None
    membership: MembershipStatus
