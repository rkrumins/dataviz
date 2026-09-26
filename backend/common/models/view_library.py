"""A view's library: its display rules and its saved queries — and the pack
they travel in between views.

A rule tags on-screen entities that match its predicate; a saved query is a
search kept under a name. Both belong to the view (a rule to the branch it
was written on, as the view's layout does) and both are exported and
imported together as a ``LibraryPack``.

Predicates are validated as a search's are (``backend.common.models.search``)
but stored as the client sent them, so the editor gets back exactly the tree
it wrote.
"""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

LIBRARY_RULES_MAX = 200
LIBRARY_QUERIES_MAX = 500

PACK_FORMAT = "synodic.view-library"
PACK_VERSION = 1


class _Base(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class DisplayRule(_Base):
    """One display rule, as the Property Manager edits it."""
    id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=120)
    color: str = Field(pattern=r"^#[0-9a-fA-F]{3,8}$")
    icon: Optional[str] = Field(None, max_length=64)
    predicate: Dict[str, Any]
    enabled: bool = True
    created_at: Optional[str] = Field(None, alias="createdAt", max_length=64)


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


class LibraryOrder(_Base):
    """A new order for a view's rules or queries: their ids, first to last."""
    ids: List[str] = Field(max_length=LIBRARY_QUERIES_MAX)


class ViewLibrary(_Base):
    view_id: str = Field(alias="viewId")
    branch_id: Optional[str] = Field(None, alias="branchId")
    display_rules: List[Dict[str, Any]] = Field(default_factory=list, alias="displayRules")
    saved_queries: List[SavedQuery] = Field(default_factory=list, alias="savedQueries")
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
