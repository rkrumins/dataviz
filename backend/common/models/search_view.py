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
  stored in the view as any view's are.

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

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, model_validator

from backend.common.models.search import Predicate
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


class SearchViewDefinition(_Base):
    """``config.search``: the search a subset view shows the matches of, where
    they are looked for, and where its columns come from."""
    version: Literal[1] = Field(1, alias="v")
    predicate: Predicate
    within: Within = "view"
    read_in: Optional[str] = Field(None, alias="readIn")
    layout: Layout = "inherit"
    provenance: MembershipProvenance = Field(default_factory=MembershipProvenance)

    @model_validator(mode="after")
    def _shape(self) -> "SearchViewDefinition":
        if self.within == "view" and not self.read_in:
            raise ValueError("a subset of a view names that view (readIn)")
        if self.within == "dataSource" and self.read_in:
            raise ValueError("a search of the whole data source has no base view")
        if self.layout == "inherit" and self.within != "view":
            raise ValueError("only a subset of a view can follow that view's layers")
        return self

    def predicate_json(self) -> Dict[str, Any]:
        return self.model_dump(mode="json", by_alias=True, exclude_none=True)["predicate"]

    def predicate_hash(self) -> str:
        """The search's identity, whatever view holds it: two subsets of the same
        base with the same search share their scans."""
        return _sha(self.predicate_json())

    def definition_hash(self) -> str:
        """The identity of the whole definition — the compare-and-swap token of
        an edit."""
        return _sha(self.model_dump(mode="json", by_alias=True, exclude_none=True))


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
    provenance: MembershipProvenance = Field(default_factory=MembershipProvenance)

    @model_validator(mode="after")
    def _layers_for_own(self) -> "FromSearchRequest":
        if self.layout == "inherit" and self.layers:
            raise ValueError("a subset that follows its base takes its layers from it — "
                             "send layers only with layout 'own'")
        if self.layout == "own" and not self.layers and not self.rest:
            raise ValueError("an own layout needs a layer: name some layers, or rest")
        return self


class SearchViewUpdate(_Base):
    """``PUT /views/{id}/search`` — change the search, or where the columns come
    from, against the hash the definition was read at. ``layout`` ``own`` copies
    the base's layers as they are now; ``inherit`` drops the view's own and
    follows its base again."""
    if_definition_hash: str = Field(alias="ifDefinitionHash")
    predicate: Optional[Predicate] = None
    layout: Optional[Layout] = None


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


class SearchViewStatus(_Base):
    """``GET /views/{id}/search`` — the definition, where its matches are
    looked for, and the layers they are shown in."""
    definition: SearchViewDefinition
    definition_hash: str = Field(alias="definitionHash")
    status: SubsetStatus = "ok"
    base: Optional[ReadInView] = None
    layers: List[SubsetLayer] = Field(default_factory=list)
    #: The base places entities by more than type (rules on tags or
    #: properties, entities placed by hand): here they are placed by type.
    placed_by_type: bool = Field(False, alias="placedByType")


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

    @property
    def degraded_detail(self) -> Optional[str]:
        """Why this page may change if asked again, else None. The graph cache
        keeps a degraded page for seconds and never as last-known-good."""
        return "running" if self.status == "running" else None

    @property
    def cache_ttl_s(self) -> Optional[int]:
        return self._ttl_s

    @property
    def lkg(self) -> bool:
        """Whether this page may stand in for the current one in an outage: a
        recent page served while the data changes may not."""
        return not self.stale
