"""A view's library: its display rules, its saved queries and its reusable
changes — and the pack the rules and queries travel in between views.

A rule tags on-screen entities that match its predicate — or, applied to
relationships, styles the lines of those a Connections search matches; a saved query is a
search kept under a name; a reusable change is a bulk property change kept
under a name, to run again. All belong to the view (a rule to the branch it was
written on, as the view's layout does). Rules and queries are exported and
imported together as a ``LibraryPack``.

Predicates are validated as a search's are (``backend.common.models.search``)
but stored as the client sent them, so the editor gets back exactly the tree
it wrote.
"""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from backend.common.models.property_job import PropertyJobOp

LIBRARY_RULES_MAX = 200
LIBRARY_QUERIES_MAX = 500
LIBRARY_REUSABLE_CHANGES_MAX = 200
#: The most queries listed from a workspace's other views at once.
OTHER_VIEW_QUERIES_MAX = 500
#: The most reusable changes listed from a workspace's other views at once.
OTHER_VIEW_REUSABLE_CHANGES_MAX = 500

PACK_FORMAT = "synodic.view-library"
PACK_VERSION = 1


class _Base(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class DisplayRuleStyle(_Base):
    """How a rule paints what it matches, beside (or instead of) its chip. A rule with no style
    shows its chip and nothing else — a relationship rule its chip on a line drawn in its colour.
    Where two rules paint one card or line, the one first in the view's list wins; chips are never
    contested — every matching rule adds its own. ``fill`` and ``frame`` paint an entity's card;
    ``dash`` and ``width`` a relationship's line."""
    chip: bool = Field(True, description="Show the rule's tag chip on each entity or line it matches.")
    fill: bool = Field(False, description="Tint each matching card in the rule's colour.")
    frame: Optional[Literal["solid", "dashed"]] = Field(
        None, description="Draw a box round each matching card, in the rule's colour.")
    dash: Optional[Literal["solid", "dashed", "dotted"]] = Field(
        None, description="Draw each matching line solid (left out), dashed or dotted.")
    width: Optional[float] = Field(
        None, ge=1, le=6, description="Each matching line's width, in pixels. Left out: 2.5.")


#: What a rule applies to: the entities its predicate matches, or the relationships a
#: Connections search (``kind: edges``) matches.
DisplayRuleTarget = Literal["entities", "relationships"]


class DisplayRule(_Base):
    """One display rule, as the Property Manager edits it."""
    id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=120)
    color: str = Field(pattern=r"^#[0-9a-fA-F]{3,8}$")
    icon: Optional[str] = Field(None, max_length=64)
    predicate: Dict[str, Any]
    enabled: bool = True
    created_at: Optional[str] = Field(None, alias="createdAt", max_length=64)
    style: Optional[DisplayRuleStyle] = None
    target: DisplayRuleTarget = Field(
        "entities",
        description="``entities``: the rule tags the entities its predicate matches. "
                    "``relationships``: its predicate is a Connections search, and the rule "
                    "styles the lines of the relationships it matches.")

    @model_validator(mode="after")
    def _style_fits_target(self) -> "DisplayRule":
        style = self.style
        if style is None:
            return self
        if self.target == "relationships" and (style.fill or style.frame):
            raise ValueError("a relationship rule draws lines: it takes a dash and a width, "
                             "not a fill or a frame")
        if self.target == "entities" and (style.dash or style.width is not None):
            raise ValueError("an entity rule paints cards: it takes a fill and a frame, "
                             "not a dash or a width")
        return self

    def stored(self) -> Dict[str, Any]:
        """The rule as a view keeps it: an entity rule without ``target``, as every rule was
        before relationship rules, so it is stored and exported byte for byte as it was; a
        relationship rule's style without the fill a line never has."""
        out = self.model_dump(by_alias=True, exclude_none=True)
        if self.target == "entities":
            out.pop("target")
        elif "style" in out:
            out["style"].pop("fill")
        return out


class SavedQuery(_Base):
    """A search kept under a name, for everyone who can open the view."""
    id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=120)
    description: Optional[str] = Field(None, max_length=500)
    predicate: Dict[str, Any]
    created_at: Optional[str] = Field(None, alias="createdAt")
    created_by: Optional[str] = Field(None, alias="createdBy")
    updated_at: Optional[str] = Field(None, alias="updatedAt")
    updated_by: Optional[str] = Field(None, alias="updatedBy")


class SavedQueryInput(_Base):
    """What a client writes: the rest is the server's to stamp."""
    name: str = Field(min_length=1, max_length=120)
    description: Optional[str] = Field(None, max_length=500)
    predicate: Dict[str, Any]


class OtherViewQuery(_Base):
    """A query saved on another view of the workspace the caller may open —
    to load into this one, copy into its library or make a rule of."""
    view_id: str = Field(alias="viewId")
    view_name: str = Field(alias="viewName")
    same_source: bool = Field(
        alias="sameSource",
        description="The other view reads this one's data source, so the query's names, "
                    "types and layers mean what they meant there.")
    query: SavedQuery


#: Where-step choices that name entities by id. Ids belong to one graph at one
#: time, so a reusable change never keeps them.
_BY_ID = ("selection", "relationships", "children", "inside")


class ReusableChangeTarget(_Base):
    """Which entities a reusable change reaches, as the bulk dialog's Where
    step names them: the whole view, every entity holding ``key``, a layer by
    its name, or a predicate (a search's, criteria built in the dialog, a
    Connections search's). Never ids: a reusable change is run again, on other
    entities, perhaps in another view. ``scopeMode`` is ``view`` for a layer, which is
    searched where the view places it."""
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    kind: Literal["view", "hasKey", "layer", "search", "custom", "connections"]
    key: Optional[str] = Field(None, min_length=1, max_length=128)
    layer_name: Optional[str] = Field(None, alias="layerName", min_length=1, max_length=256)
    predicate: Optional[Dict[str, Any]] = None
    scope_mode: Literal["view", "data_source"] = Field("view", alias="scopeMode")

    @model_validator(mode="before")
    @classmethod
    def _never_ids(cls, data: Any) -> Any:
        if isinstance(data, dict) and (data.get("kind") in _BY_ID or "ids" in data or "edgeIds" in data):
            raise ValueError("A reusable change can't keep entities picked by id: the next time it "
                             "runs they may not be the ones it should reach. Save it for the whole "
                             "view, a key, a layer or criteria.")
        return data

    @model_validator(mode="after")
    def _complete(self):
        wants = {"hasKey": "key", "layer": "layerName", "search": "predicate",
                 "custom": "predicate", "connections": "predicate"}.get(self.kind)
        for name, value in (("key", self.key), ("layerName", self.layer_name), ("predicate", self.predicate)):
            if (value is not None) != (name == wants):
                raise ValueError(f"a {self.kind} target {'takes no' if value is not None else 'needs'} `{name}`")
        if self.kind == "layer" and self.scope_mode != "view":
            raise ValueError("a layer belongs to the view, so it is searched there: scopeMode view")
        return self


class ReusableChangeInput(_Base):
    """What a client writes: a bulk property change and where it reaches."""
    name: str = Field(min_length=1, max_length=120)
    description: Optional[str] = Field(None, max_length=500)
    op: PropertyJobOp
    target: ReusableChangeTarget


class ReusableChange(_Base):
    """A bulk property change kept under a name, for everyone who can open
    the view — to run again from the Property Manager. ``op`` is as a job
    keeps it (``PropertyJobOp.wire``)."""
    id: str = Field(min_length=1, max_length=128)
    name: str
    description: Optional[str] = None
    op: Dict[str, Any]
    target: Dict[str, Any]
    created_at: Optional[str] = Field(None, alias="createdAt")
    created_by: Optional[str] = Field(None, alias="createdBy")
    updated_at: Optional[str] = Field(None, alias="updatedAt")
    updated_by: Optional[str] = Field(None, alias="updatedBy")


class OtherViewReusableChange(_Base):
    """A reusable change saved on another view of the workspace the caller
    may open — to run in this one."""
    view_id: str = Field(alias="viewId")
    view_name: str = Field(alias="viewName")
    same_source: bool = Field(
        alias="sameSource",
        description="The other view reads this one's data source, so the change's keys, "
                    "types and layers mean what they meant there.")
    change: ReusableChange


class LibraryOrder(_Base):
    """A new order for a view's rules, queries or reusable changes: their ids, first to last."""
    ids: List[str] = Field(max_length=LIBRARY_QUERIES_MAX)


class ViewLibrary(_Base):
    view_id: str = Field(alias="viewId")
    branch_id: Optional[str] = Field(None, alias="branchId")
    display_rules: List[Dict[str, Any]] = Field(default_factory=list, alias="displayRules")
    saved_queries: List[SavedQuery] = Field(default_factory=list, alias="savedQueries")
    reusable_changes: List[ReusableChange] = Field(default_factory=list, alias="reusableChanges")
    can_edit: bool = Field(False, alias="canEdit")


class LibraryPackSource(_Base):
    view_id: Optional[str] = Field(None, alias="viewId")
    view_name: Optional[str] = Field(None, alias="viewName")
    branch_id: Optional[str] = Field(None, alias="branchId")


class LibraryPack(_Base):
    """A view's rules and saved queries, exported to be imported elsewhere."""
    format: Literal["synodic.view-library"] = PACK_FORMAT
    version: Literal[1] = PACK_VERSION
    exported_at: Optional[str] = Field(None, alias="exportedAt")
    source: Optional[LibraryPackSource] = None
    display_rules: List[Dict[str, Any]] = Field(
        default_factory=list, alias="displayRules", max_length=LIBRARY_RULES_MAX)
    saved_queries: List[Dict[str, Any]] = Field(
        default_factory=list, alias="savedQueries", max_length=LIBRARY_QUERIES_MAX)


ImportStrategy = Literal["merge", "replace", "copy"]


class LibraryImportItem(_Base):
    kind: Literal["rule", "query"]
    source_id: Optional[str] = Field(None, alias="sourceId")
    name: str
    action: Literal["add", "skip", "refuse"]
    new_name: Optional[str] = Field(
        None, alias="newName", description="The name it is added under, when that differs.")
    reason: Optional[str] = None
    warnings: List[str] = Field(default_factory=list)


class LibraryImportResult(_Base):
    strategy: ImportStrategy
    dry_run: bool = Field(alias="dryRun")
    items: List[LibraryImportItem] = Field(default_factory=list)
    added: int = 0
    skipped: int = 0
    refused: int = 0
    removed: int = Field(0, description="Existing items a replace would remove.")
    library: Optional[ViewLibrary] = None
