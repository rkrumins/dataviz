"""A subset view: a base view's entities that match one stored search.

``config.search`` is the whole of what makes it (server-owned; only
``POST /views/from-search`` and ``PUT /views/{id}/search`` write it):

* ``predicate`` — the search, rule-shaped (one entity at a time, no route
  through the graph, no ``layer`` leaf: a subset's layers come from its base);
* ``within`` — ``view``: the matches inside the base view (``readIn``), read
  as the system, so a reader needs no access to the base; ``dataSource``: the
  matches anywhere in the data source;
* ``layout`` — ``inherit``: the subset's columns are its base's layers, read
  live and placed by type, plus "Other matches"; ``own``: its own type layers,
  stored in the view as any view's are;
* ``include`` — what it keeps beside the matches: everything inside one, what
  contains one, one lineage step from one either way. Each is a relationship
  asked of one entity, worked out with the search, so the view stays live at
  any size (``search_predicate``);
* ``hiddenLayers`` — base layers a following subset leaves out, with their
  matches: fewer columns, still following the base.

Nothing about the matches is stored, so the view is the same size whatever
they number, and it is current whenever it is read: the search engine
evaluates it on each read, shares the scan between every view and viewer
asking the same question, and serves the last complete answer, marked as
of when it was read, while a newer one is scanned (``view-feed``).
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, List, Literal, Optional

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    PrivateAttr,
    model_serializer,
    model_validator,
)

from backend.common.models.search import (
    RELATION_DEPTH_MAX,
    EntityTypePredicate,
    GroupPredicate,
    Predicate,
    RelatedPredicate,
)
from backend.common.models.view_membership import MembershipProvenance, ReadInView

#: Typed layers a subset view may have, and the types one may name — the
#: entity-type leaf's own cap, so a layer's feed is one leaf.
LAYERS_MAX = 12
LAYER_TYPES_MAX = 32

#: The id of the "Other matches" layer a subset adds when its base has no
#: fallback layer of its own: every match whose type no other layer claims.
REST_LAYER_ID = "other-matches"
REST_LAYER_NAME = "Other matches"

Within = Literal["view", "dataSource"]
Layout = Literal["inherit", "own"]


class _Base(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


def _sha(value: object) -> str:
    blob = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(blob.encode()).hexdigest()[:32]


class SubsetInclude(_Base):
    """What a subset view keeps beside its search's matches. Each is one
    relationship asked of one entity, so the view stays live at any size; more
    reach than this (two lineage steps and further) is a member-list view's."""
    #: What is inside a match: every level, or ``contentsLevels`` of them, of
    #: every kind, or only ``contentsKinds``.
    contents: bool = False
    contents_levels: Optional[int] = Field(None, alias="contentsLevels", ge=1, le=RELATION_DEPTH_MAX)
    contents_kinds: Optional[List[str]] = Field(None, alias="contentsKinds", max_length=32)
    #: What contains a match: its containers up to the top, or ``containersLevels``
    #: up, of every kind, or only ``containersKinds``.
    containers: bool = False
    containers_levels: Optional[int] = Field(None, alias="containersLevels", ge=1, le=RELATION_DEPTH_MAX)
    containers_kinds: Optional[List[str]] = Field(None, alias="containersKinds", max_length=32)
    #: One lineage step upstream: what feeds a match.
    upstream: bool = False
    #: One lineage step downstream: what a match feeds.
    downstream: bool = False

    @model_validator(mode="after")
    def _levels_and_kinds_go_with_their_choice(self) -> "SubsetInclude":
        """Levels and kinds belong to a choice that is on, and kinds are a set: so
        one choice has one shape, and one hash."""
        for on, levels, kinds in (("contents", "contents_levels", "contents_kinds"),
                                  ("containers", "containers_levels", "containers_kinds")):
            if not getattr(self, on):
                setattr(self, levels, None)
                setattr(self, kinds, None)
            elif getattr(self, kinds) is not None:
                setattr(self, kinds, sorted({k for k in getattr(self, kinds) if k}) or None)
        return self

    @model_serializer(mode="wrap")
    def _without_unset_reach(self, handler):
        """Every level and every kind are unset, never sent: a definition made
        before levels and kinds reads, and hashes, as it did."""
        return {k: v for k, v in handler(self).items() if v is not None}

    def any(self) -> bool:
        return self.contents or self.containers or self.upstream or self.downstream


class SearchViewDefinition(_Base):
    """``config.search``: the search a subset view shows the matches of, where
    they are looked for, what it keeps beside them, and where its columns come
    from."""
    version: Literal[1] = Field(1, alias="v")
    predicate: Predicate
    within: Within = "view"
    read_in: Optional[str] = Field(None, alias="readIn")
    layout: Layout = "inherit"
    include: SubsetInclude = Field(default_factory=SubsetInclude)
    hidden_layers: List[str] = Field(default_factory=list, alias="hiddenLayers", max_length=LAYERS_MAX + 1)
    provenance: MembershipProvenance = Field(default_factory=MembershipProvenance)

    @model_validator(mode="after")
    def _shape(self) -> "SearchViewDefinition":
        if self.within == "view" and not self.read_in:
            raise ValueError("a subset of a view names that view (readIn)")
        if self.within == "dataSource" and self.read_in:
            raise ValueError("a search of the whole data source has no base view")
        if self.layout == "inherit" and self.within != "view":
            raise ValueError("only a subset of a view can follow that view's layers")
        if self.hidden_layers and self.layout != "inherit":
            raise ValueError("only a subset that follows its base hides some of its layers — "
                             "an own layout has just the layers it keeps")
        return self

    def search_predicate(self):
        """What the view's entities are found by: its search, or its search and
        what it includes — the matches, everything inside one, what contains
        one, and what is one lineage step from one.

        A lineage step is taken from a match or anything inside it, as a trace
        walks a container — a dataset's lineage runs through its columns — so
        a narrowing kept live reaches what it reached."""
        if not self.include.any():
            return self.predicate
        matches = self.predicate
        parts = [matches]
        include = self.include
        if include.contents:
            # Inside a match, ``contentsLevels`` down (unset: every level).
            parts.append(_of_kinds(RelatedPredicate(axis="ancestor", where=matches,
                                                    max_hops=include.contents_levels),
                                   include.contents_kinds))
        if include.containers:
            # Containing a match, ``containersLevels`` up (unset: to the top).
            parts.append(_of_kinds(RelatedPredicate(axis="descendant", where=matches,
                                                    max_hops=include.containers_levels),
                                   include.containers_kinds))
        if self.include.upstream or self.include.downstream:
            reach = GroupPredicate(op="or", children=[matches, RelatedPredicate(axis="ancestor", where=matches)])
            if self.include.upstream:
                parts.append(RelatedPredicate(axis="downstream", where=reach))
            if self.include.downstream:
                parts.append(RelatedPredicate(axis="upstream", where=reach))
        return GroupPredicate(op="or", children=parts)

    def predicate_json(self) -> Dict[str, Any]:
        return self.model_dump(mode="json", by_alias=True, exclude_none=True)["predicate"]

    def predicate_hash(self) -> str:
        """The identity of what it finds, whatever view holds it: two subsets of
        the same base with the same search, including the same, share their scans."""
        found = self.search_predicate()
        return _sha(found.model_dump(mode="json", by_alias=True, exclude_none=True))

    def definition_hash(self) -> str:
        """The identity of the whole definition — the compare-and-swap token of
        an edit."""
        return _sha(self.model_dump(mode="json", by_alias=True, exclude_none=True))


def _of_kinds(related, kinds: Optional[List[str]]):
    """``related``, of ``kinds`` only when some are named: the kind first, so a
    candidate of another kind is never walked."""
    if not kinds:
        return related
    return GroupPredicate(op="and", children=[EntityTypePredicate(values=kinds), related])


def read_search_definition(config: Dict[str, Any]) -> Optional[SearchViewDefinition]:
    """The view's search, or None when it is not a subset view — or holds a
    search this server cannot read (a hand-edited file, a newer format)."""
    raw = (config or {}).get("search")
    if not isinstance(raw, dict):
        return None
    try:
        return SearchViewDefinition.model_validate(raw)
    except ValueError:
        return None


class SearchLayer(_Base):
    """One layer of a subset view's own layout: the matches of these types."""
    name: str = Field(..., min_length=1, max_length=200)
    color: Optional[str] = Field(None, max_length=32)
    entity_types: List[str] = Field(..., alias="entityTypes", min_length=1,
                                    max_length=LAYER_TYPES_MAX)


class FromSearchRequest(_Base):
    """``POST /views/from-search`` — make a subset view from a search.

    The label fields are a view's own (``ViewCreateRequest``). ``layers`` (an
    ``own`` layout only) split the matches by type; ``rest`` names the layer
    that holds every match no layer's types claim — None, no such layer."""
    name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = Field(None, max_length=2000)
    icon: Optional[str] = Field(None, max_length=64)
    tags: Optional[List[str]] = None
    visibility: str = "private"
    workspace_id: str = Field(alias="workspaceId")
    data_source_id: Optional[str] = Field(None, alias="dataSourceId")
    predicate: Predicate
    within: Within = "view"
    read_in: Optional[str] = Field(None, alias="readIn")
    layout: Layout = "inherit"
    layers: Optional[List[SearchLayer]] = Field(None, max_length=LAYERS_MAX)
    rest: Optional[str] = Field(REST_LAYER_NAME, max_length=200)
    include: SubsetInclude = Field(default_factory=SubsetInclude)
    hidden_layers: List[str] = Field(default_factory=list, alias="hiddenLayers", max_length=LAYERS_MAX + 1)
    provenance: MembershipProvenance = Field(default_factory=MembershipProvenance)

    @model_validator(mode="after")
    def _layers_for_own(self) -> "FromSearchRequest":
        if self.layout == "inherit" and self.layers:
            raise ValueError("a subset that follows its base takes its layers from it — "
                             "send layers only with layout 'own'")
        if self.layout == "own" and not self.layers and not self.rest:
            raise ValueError("an own layout needs a layer: name some layers, or rest")
        if self.layout == "own" and self.hidden_layers:
            raise ValueError("an own layout has just the layers it names: hide a layer by leaving "
                             "it out")
        return self


class SearchViewUpdate(_Base):
    """``PUT /views/{id}/search`` — change the search, or where the columns come
    from, against the hash the definition was read at. ``layout`` ``own`` copies
    the base's layers as they are now; ``inherit`` drops the view's own and
    follows its base again.

    ``layers``, with ``layout`` ``own`` only, are the own layers to have instead
    of a copy of the base's — what Undo of **Follow again** sends back, so the
    layout it had returns as it was. Checked as any own layout is: type layers
    alone, at most ``LAYERS_MAX`` typed and one for the rest."""
    if_definition_hash: str = Field(alias="ifDefinitionHash")
    predicate: Optional[Predicate] = None
    layout: Optional[Layout] = None
    include: Optional[SubsetInclude] = None
    hidden_layers: Optional[List[str]] = Field(None, alias="hiddenLayers", max_length=LAYERS_MAX + 1)
    layers: Optional[List[Dict[str, Any]]] = Field(None, max_length=LAYERS_MAX + 1)


SubsetStatus = Literal["ok", "base_missing"]


class SubsetLayer(_Base):
    """A layer as a subset view shows it, and what feeds it: the matches of
    ``entityTypes`` — or, for the ``rest`` layer, of every type but
    ``excludedTypes``."""
    id: str
    name: str
    color: Optional[str] = None
    entity_types: List[str] = Field(default_factory=list, alias="entityTypes")
    rest: bool = False
    excluded_types: List[str] = Field(default_factory=list, alias="excludedTypes")
    #: Left out of a following subset, with its matches (``hiddenLayers``).
    hidden: bool = False


class SearchViewStatus(_Base):
    """``GET /views/{id}/search`` — the definition, where its matches are
    looked for, and the layers they are shown in."""
    definition: SearchViewDefinition
    definition_hash: str = Field(alias="definitionHash")
    status: SubsetStatus = "ok"
    base: Optional[ReadInView] = None
    layers: List[SubsetLayer] = Field(default_factory=list)
    #: It follows its base, but the base's placement is more than a search can
    #: follow (``placedByTypeReason`` says why): here its matches are placed by type.
    placed_by_type: bool = Field(False, alias="placedByType")
    placed_by_type_reason: Optional[str] = Field(None, alias="placedByTypeReason")


class SubsetSummary(_Base):
    """One subset view made from a view (``GET /views/{id}/subsets``)."""
    view_id: str = Field(alias="viewId")
    name: str
    layout: Layout
    visibility: str
    updated_at: Optional[str] = Field(None, alias="updatedAt")


class SubsetList(_Base):
    """The subset views made from a view: what changing or deleting it affects.
    ``count`` counts every one; ``items`` lists those the caller may open."""
    count: int = 0
    items: List[SubsetSummary] = Field(default_factory=list)


FEED_WAIT_MS_MAX = 10_000


class ViewFeedRequest(_Base):
    """``POST /{ws}/graph/search/view-feed?viewId=`` — one page of one layer of
    a subset view. The view's stored search decides what matches; nothing the
    client sends can widen it. ``cursor`` continues a complete page;
    ``sessionId`` continues a running one; ``refresh`` asks for a fresh scan
    instead of a recent answer."""
    layer_id: str = Field(alias="layerId", min_length=1, max_length=200)
    cursor: Optional[str] = Field(None, max_length=4096)
    session_id: Optional[str] = Field(None, alias="sessionId", max_length=64)
    wait_ms: int = Field(0, alias="waitMs", ge=0, le=FEED_WAIT_MS_MAX)
    refresh: bool = False


class ViewFeedPage(_Base):
    """A page of one layer's matches, as nodes the canvas draws.

    ``status`` ``running``: the scan is not finished — these are the first
    matches found so far, already in their final order, and ``totalCount``
    counts what was found so far (``countStatus`` ``lowerBound``); continue
    with ``sessionId``. ``stale``: the answer is a recent one, read before the
    data last changed (``asOf``) — a fresh one is on its way. ``capped``: the
    layer has more matches than the canvas lists; search in the layer, or
    export, for the rest."""
    layer_id: str = Field(alias="layerId")
    nodes: List[Dict[str, Any]] = Field(default_factory=list)
    cursor: Optional[str] = None
    total_count: Optional[int] = Field(None, alias="totalCount")
    count_status: Literal["exact", "lowerBound"] = Field("exact", alias="countStatus")
    status: Literal["complete", "running"] = "complete"
    session_id: Optional[str] = Field(None, alias="sessionId")
    stale: bool = False
    as_of: Optional[str] = Field(None, alias="asOf")
    capped: bool = False
    delivered: int = 0
    data_version: Optional[str] = Field(None, alias="dataVersion")
    #: How long a cache may keep this page (a recent one: what is left of its
    #: window), set by the route that built it. Never serialized.
    _ttl_s: Optional[int] = PrivateAttr(default=None)
    #: Where its matches sit couldn't be read in time: they are drawn flat until
    #: it is asked again. Never serialized.
    _paths_left_out: bool = PrivateAttr(default=False)

    @property
    def degraded_detail(self) -> Optional[str]:
        """Why this page may change if asked again, else None. The graph cache
        keeps a degraded page for seconds and never as last-known-good."""
        if self.status == "running":
            return "running"
        return "paths" if self._paths_left_out else None

    @property
    def cache_ttl_s(self) -> Optional[int]:
        return self._ttl_s

    @property
    def lkg(self) -> bool:
        """Whether this page may stand in for the current one in an outage: a
        recent page served while the data changes may not."""
        return not self.stale
