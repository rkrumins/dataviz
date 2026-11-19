"""The View Bundle file format (``*.view.json``), version 1.

One bundle carries 1..N views. A single-view export is a bundle with one entry, so there is
one schema, one parser and one importer.

    {
      "format": "view-bundle", "formatVersion": 1,
      "exportedAt": "...", "exportedBy": {"displayName": "..."},
      "generator": {"product": "...", "environment": "dev"},
      "sources": {"s1": {workspace, dataSource, ontology}},     # descriptive only
      "views": [{source, portableId, sourceViewId, version, definitionHash,
                 metadata, definition, manifest, history, members?}],
      "bundleHash": "sha256:..."
    }

Only ``definition`` is hashed. ``metadata`` (name, description, icon, tags) travels beside it
so a renamed copy still proves it holds the same view. ``sources`` describes where the views
came from so the target can suggest where they belong; its ids are never used as ids.

``members`` — a snapshot (a view made from a query that keeps its members as they are) only:
its members, which are data, not design, so outside the definition and its hash:

    {"format": "rows-v1", "count": 2,
     "columns": ["urn", "layerId", "whole", "name", "type", "orderKey", "logicalNodeId"],
     "rows": [["urn:a", "l1", true, "orders", "table", null, null], ...]}

one row per member, in name order, read by its columns' names. They count with the
assignments against a file's limit. A view kept up to date carries none: it works its members
out again where it arrives.

Field names are the wire names (camelCase), like the other file and API envelopes here.
Unknown keys are ignored when parsing so a newer exporter's additions don't break an older
importer; a newer ``formatVersion`` is refused outright (see ``bundle.parse_bundle``).
"""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

#: Longest name accepted anywhere in a bundle. Mirrors ``view_transfer.limits.MAX_NAME_LENGTH``;
#: kept here because the shared models don't import app code.
MAX_NAME_LENGTH = 500

BUNDLE_FORMAT = "view-bundle"
BUNDLE_FORMAT_VERSION = 1

#: A snapshot's members in a file: their format, and the columns each row holds, in order.
MEMBERS_FORMAT = "rows-v1"
MEMBER_COLUMNS = ("urn", "layerId", "whole", "name", "type", "orderKey", "logicalNodeId")


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


class WorkspaceRef(_Model):
    id: Optional[str] = None
    name: Optional[str] = Field(None, max_length=MAX_NAME_LENGTH)


class DataSourceRef(_Model):
    id: Optional[str] = None
    label: Optional[str] = Field(None, max_length=MAX_NAME_LENGTH)
    providerType: Optional[str] = Field(None, max_length=64)
    graphName: Optional[str] = Field(None, max_length=MAX_NAME_LENGTH)
    catalogSourceIdentifier: Optional[str] = Field(None, max_length=MAX_NAME_LENGTH)
    identityProperty: Optional[str] = Field(None, max_length=128)


class OntologyRef(_Model):
    #: The semantic layer's id where the file was made: matched only within the same environment
    #: (ids differ between environments).
    id: Optional[str] = Field(None, max_length=128)
    name: Optional[str] = Field(None, max_length=MAX_NAME_LENGTH)
    version: Optional[int] = None
    #: The data source's resolved ontology, its graph's gap-filled types included: what ranks
    #: import targets (a target whose engine gives the same digest is the same source).
    digest: Optional[str] = Field(None, max_length=128)
    #: The semantic layer's own digest, without any data source's gap-fill
    #: (``sources.ontology_digest``): what tells whether it changed since the file was made.
    definitionDigest: Optional[str] = Field(None, max_length=128)


class SourceDescriptor(_Model):
    workspace: WorkspaceRef = Field(default_factory=WorkspaceRef)
    dataSource: DataSourceRef = Field(default_factory=DataSourceRef)
    ontology: OntologyRef = Field(default_factory=OntologyRef)


class ViewMetadata(_Model):
    name: str = Field(..., min_length=1, max_length=MAX_NAME_LENGTH)
    description: Optional[str] = Field(None, max_length=10_000)
    icon: Optional[str] = Field(None, max_length=128)
    tags: List[str] = Field(default_factory=list, max_length=200)
    viewType: str = Field("graph", max_length=64)


class EntityInfo(_Model):
    name: Optional[str] = Field(None, max_length=2_000)
    type: Optional[str] = Field(None, max_length=256)
    qualifiedName: Optional[str] = Field(None, max_length=2_000)


class Manifest(_Model):
    counts: Dict[str, int] = Field(default_factory=dict)
    entities: Dict[str, EntityInfo] = Field(default_factory=dict)
    #: False when the source graph couldn't be asked for names at export time. The file is
    #: still complete; the importer just can't name entities it doesn't find.
    entitiesResolved: bool = True


class HistoryEntry(_Model):
    environment: Optional[str] = Field(None, max_length=128)
    viewId: Optional[str] = Field(None, max_length=128)
    version: Optional[int] = None
    hash: str = Field(..., max_length=128)
    source: Optional[str] = Field(None, max_length=32)
    createdAt: Optional[str] = Field(None, max_length=64)
    createdBy: Optional[str] = Field(None, max_length=MAX_NAME_LENGTH)
    message: Optional[str] = Field(None, max_length=2_000)


class ViewMembers(_Model):
    """A snapshot's members, as its file carries them: data, not design, so beside the
    definition and never hashed. ``rows``, one per member in name order, each holding
    ``columns`` in order — read by the columns' names, so ones this reads nothing of are
    ignored; ``urn`` and ``layerId`` it can't do without."""
    format: Literal["rows-v1"] = MEMBERS_FORMAT
    count: int = Field(0, ge=0)
    columns: List[str] = Field(default_factory=lambda: list(MEMBER_COLUMNS), max_length=64)
    rows: List[List[Any]] = Field(default_factory=list)

    @model_validator(mode="after")
    def _whole(self) -> "ViewMembers":
        if "urn" not in self.columns or "layerId" not in self.columns:
            raise ValueError("members name no urn or layerId column")
        if self.count != len(self.rows):
            raise ValueError(f"members say {self.count} rows and hold {len(self.rows)}")
        if any(len(row) != len(self.columns) for row in self.rows):
            raise ValueError("a member row doesn't hold one value per column")
        return self

    def by_urn(self) -> Dict[str, Dict[str, Any]]:
        """Each member's row, keyed by its columns' names."""
        out: Dict[str, Dict[str, Any]] = {}
        for row in self.rows:
            entry = dict(zip(self.columns, row))
            if isinstance(entry.get("urn"), str) and entry["urn"] and isinstance(entry.get("layerId"), str):
                out[entry["urn"]] = entry
        return out


class BundleView(_Model):
    source: str = Field(..., max_length=64)
    portableId: str = Field(..., min_length=1, max_length=128)
    sourceViewId: Optional[str] = Field(None, max_length=128)
    version: Optional[int] = None
    definitionHash: str = Field(..., max_length=128)
    metadata: ViewMetadata
    definition: Dict[str, Any]
    manifest: Manifest = Field(default_factory=Manifest)
    history: List[HistoryEntry] = Field(default_factory=list)
    historyTruncated: bool = False
    #: A snapshot's members: never hashed (see the module docstring).
    members: Optional[ViewMembers] = None


class Person(_Model):
    displayName: Optional[str] = Field(None, max_length=MAX_NAME_LENGTH)


class Generator(_Model):
    product: Optional[str] = Field(None, max_length=MAX_NAME_LENGTH)
    environment: Optional[str] = Field(None, max_length=128)


class ViewBundle(_Model):
    format: str
    formatVersion: int
    exportedAt: Optional[str] = None
    exportedBy: Person = Field(default_factory=Person)
    generator: Generator = Field(default_factory=Generator)
    sources: Dict[str, SourceDescriptor] = Field(default_factory=dict)
    views: List[BundleView]
    bundleHash: Optional[str] = Field(None, max_length=128)
