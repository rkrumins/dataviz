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
from typing import Dict, List, Literal, Optional, Union

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
