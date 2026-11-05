"""The import/export record format, version 1 — the contract a connector builds on.

One flat record per node or edge, with the same columns in every format: a CSV/TSV/XLSX row, or
an NDJSON line or JSON object. :mod:`rowmodel` reads and writes them; this module says what each
column means, as the models :class:`ImportNodeRecord` and :class:`ImportEdgeRecord`. Their JSON
Schema is the published contract: ``backend/common/schema/import-record.v1.json``
(``backend/scripts/export_import_schema.py``), and ``GET …/imports/schema``, which narrows it to
one data source's types and properties. The import template (:func:`template_records`) and its
spreadsheet guide (:func:`columns_guide`) are drawn from the same models.

Version 1 only ever gains columns: a connector written against it keeps working.
"""
from __future__ import annotations

import re
from typing import Annotated, Any, Dict, List, Literal, Mapping, Optional, Sequence, Tuple, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator

FORMAT_VERSION = 1
SCHEMA_ID = f"https://synodic.dev/schemas/import-record.v{FORMAT_VERSION}.json"
#: The cell (or value) that removes a property.
DELETE_TOKEN = "\\N"

# What a row may carry beyond its named columns: a property, and on an edge a field of an end's
# node that the end is found by (its identifier property, or a field matched by "Match imports by
# this").
_NODE_EXTRA = re.compile(r"^prop\.[^.].*$")
_EDGE_EXTRA = re.compile(r"^(prop|source|target)\.[^.].*$")
_SCALAR = {"anyOf": [{"type": "string"}, {"type": "number"}, {"type": "boolean"},
                     {"type": "array", "items": {"type": ["string", "number", "boolean"]}}]}

_POINTER = ("A pointer, not stored: it finds the node that carries it as its urn, or the node an "
            "earlier import made from it — whose id is derived from it, so importing the same file "
            "again updates what it made. A `urn:uuid:` no node holds is kept as the new node's id. "
            "To see your own id on the node, keep it in a property marked \"Match imports by "
            "this\" too.")


class _Record(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)

    entity_id: Optional[str] = Field(
        None, description="The node or edge's own id, as an export writes it: a row with one "
        "updates that entity. Any other value is the file's own id for the row — it links the "
        "file's rows to each other (an edge to a node) and nothing more.")
    baseVersion: Optional[str] = Field(
        None, description="The entity's content hash, as an export writes it. If the entity has "
        "changed since, only the cells you changed apply, and a row whose cell someone else also "
        "changed is refused, naming it. Leave it out to set what the row carries.")
    properties_json: Optional[Union[Dict[str, Any], str]] = Field(
        None, description="Properties too nested for a column, as a JSON object. A `null` value "
        "removes the property.")
    op: Optional[Literal["", "upsert", "delete"]] = Field(
        None, alias="_op", description="Blank or `upsert` creates or updates; `delete` deletes the "
        "entity the row names.")


class ImportNodeRecord(_Record):
    """A node row. ``prop.<name>`` columns set its properties: a value sets one, a blank cell
    leaves it as it is, and ``\\N`` removes it."""
    model_config = ConfigDict(json_schema_extra={
        "patternProperties": {_NODE_EXTRA.pattern: _SCALAR}, "additionalProperties": False})

    kind: Literal["node"]
    urn: Optional[str] = Field(None, description=f"The node's urn. {_POINTER}")
    entityType: Optional[str] = Field(
        None, description="The node's type, one of the data source's entity types. Required for "
        "a new node.")
    displayName: Optional[str] = Field(None, description="The node's name.")
    qualifiedName: Optional[str] = Field(
        None, description="A dotted path naming the node. A row with no urn and no identifier "
        "value finds the node by it, if exactly one node carries it.")
    description: Optional[str] = Field(None, description="The node's description.")
    sourceSystem: Optional[str] = Field(None, description="Where the node comes from.")
    layerAssignment: Optional[str] = Field(
        None, description="The layer of the view an import into a view places a new node in.")
    tags: Optional[Union[List[str], str]] = Field(
        None, description="Tags: a list, or one comma-separated text.")

    @model_validator(mode="after")
    def _known_columns(self):
        _check_extra(self.model_extra, _NODE_EXTRA, "node")
        return self


class ImportEdgeRecord(_Record):
    """An edge row. Each end is found the way a node row is — by an entity id, a pointer
    (``sourceUrn``, or ``source.<identifier property>``), a field matched by "Match imports by
    this" (``source.<field>``), or a qualifiedName — and the edge by its two ends and its type."""
    model_config = ConfigDict(json_schema_extra={
        "patternProperties": {_EDGE_EXTRA.pattern: _SCALAR}, "additionalProperties": False})

    kind: Literal["edge"]
    edgeType: str = Field(description="The edge's type, one of the data source's relationship "
                                      "types.")
    sourceUrn: Optional[str] = Field(None, description=f"The source node's urn. {_POINTER}")
    targetUrn: Optional[str] = Field(None, description=f"The target node's urn. {_POINTER}")
    source_entity_id: Optional[str] = Field(
        None, description="The source node's entity id, or the file's own id of a node row.")
    target_entity_id: Optional[str] = Field(
        None, description="The target node's entity id, or the file's own id of a node row.")
    sourceQualifiedName: Optional[str] = Field(
        None, description="The source node's qualifiedName, for an end named by nothing else.")
    targetQualifiedName: Optional[str] = Field(
        None, description="The target node's qualifiedName, for an end named by nothing else.")
    confidence: Optional[Union[float, str]] = Field(None, description="A number from 0 to 1.")

    @model_validator(mode="after")
    def _known_columns(self):
        _check_extra(self.model_extra, _EDGE_EXTRA, "edge")
        return self


ImportRecord = Annotated[Union[ImportNodeRecord, ImportEdgeRecord], Field(discriminator="kind")]
_RECORD = TypeAdapter(ImportRecord)


def _check_extra(extra: Optional[Mapping[str, Any]], allowed: re.Pattern, kind: str) -> None:
    unknown = sorted(k for k in (extra or {}) if not allowed.match(k))
    if unknown:
        raise ValueError(f"a {kind} row has no column {', '.join(map(repr, unknown))}")


def validate_record(record: Mapping[str, Any]) -> Union[ImportNodeRecord, ImportEdgeRecord]:
    """``record`` checked against the contract: raises on an unknown column or a wrong value."""
    return _RECORD.validate_python(dict(record))


def unknown_columns(records: Sequence[Mapping[str, Any]]) -> List[str]:
    """The columns these records carry that the contract doesn't name — a typo, most often
    (``prop_owner`` for ``prop.owner``); an import ignores them."""
    named = {f.alias or name for model in (ImportNodeRecord, ImportEdgeRecord)
             for name, f in model.model_fields.items()} | {"kind"}
    return sorted({k for r in records for k in r if k not in named
                   and not _EDGE_EXTRA.match(k)})


# ── The JSON Schema ─────────────────────────────────────────────────────────────────────────────

#: A property column, by the field type a data source's ontology gives it. Every one may also be
#: the removal token.
_FIELD_SCHEMA: Dict[str, Dict[str, Any]] = {
    "number": {"type": "number"}, "progress": {"type": "number"},
    "boolean": {"type": "boolean"},
    "date": {"type": "string", "format": "date"},
    "datetime": {"type": "string", "format": "date-time"},
    "url": {"type": "string", "format": "uri"},
    "email": {"type": "string", "format": "email"},
    "tags": {"type": "array", "items": {"type": "string"}},
    "json": {},
}


def json_schema(ontology: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
    """The record format's JSON Schema (draft 2020-12), describing one NDJSON line or JSON
    object. With a data source's ``ontology`` (as the import reads it, with ``fields`` and
    ``edge_ends``), its entity and edge types are enumerated and its properties typed."""
    schema = _RECORD.json_schema()
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": SCHEMA_ID,
        "title": f"Import record v{FORMAT_VERSION}",
        "description": (
            "One node or edge of an import or export file: a CSV/TSV/XLSX row (every cell text), "
            "an NDJSON line or a JSON object. Imported with POST …/versioning/graphs/{graphId}/"
            "imports; checked without writing with POST …/imports/validate. Version 1 only "
            "gains columns. See docs/CONNECTOR_GUIDE.md."),
        "x-format-version": FORMAT_VERSION,
        **schema,
    }
    if not ontology:
        return schema
    defs = schema["$defs"]
    node, edge = defs["ImportNodeRecord"], defs["ImportEdgeRecord"]
    if ontology.get("node_types"):
        node["properties"]["entityType"] = {
            **node["properties"]["entityType"], "anyOf": [
                {"enum": sorted(set(ontology["node_types"]))}, {"type": "null"}]}
    if ontology.get("edge_types"):
        edge["properties"]["edgeType"] = {
            **edge["properties"]["edgeType"], "enum": sorted(set(ontology["edge_types"]))}
    for prop, spec in sorted(_typed_properties(ontology).items()):
        node["properties"][prop] = spec
    return schema


def _typed_properties(ontology: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    """``prop.<field>`` → its schema, for every field an entity type of ``ontology`` defines."""
    out: Dict[str, Dict[str, Any]] = {}
    for etype, fields in sorted((ontology.get("fields") or {}).items()):
        for f in fields:
            column = f"prop.{f['id']}"
            typed = _FIELD_SCHEMA.get(str(f.get("type") or "").lower(), {"type": "string"})
            notes = [f"{f.get('name') or f['id']} ({f.get('type') or 'text'})"]
            if f.get("required"):
                notes.append(f"required for a new {etype}")
            if f.get("key"):
                notes.append(f"{etype} rows are matched by it")
            if f.get("unique"):
                notes.append("unique")
            have = out.get(column)
            if have is not None:                         # several types define it: name them all
                have["description"] += f"; on {etype}: " + ", ".join(notes)
                continue
            out[column] = {"anyOf": [typed, {"const": DELETE_TOKEN}],
                           "description": f"On {etype}: " + ", ".join(notes)}
    return out


# ── The template ────────────────────────────────────────────────────────────────────────────────

_EXAMPLE_VALUE = {"number": 1, "progress": 50, "boolean": True, "date": "2026-01-31",
                  "datetime": "2026-01-31T09:00:00Z", "url": "https://example.com",
                  "email": "owner@example.com", "tags": "a, b", "urn": "urn:example:ref:1",
                  "json": "{}"}
_TEMPLATE_CAP = 25


def _example_urn(etype: str) -> str:
    return f"urn:example:{re.sub(r'[^A-Za-z0-9_.-]+', '-', etype).lower()}:1"


def template_records(ontology: Optional[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    """Worked rows for the import template from the data source's ``ontology``: a node of each
    entity type, its properties filled with an example of each field's type, and an edge of each
    relationship type between example nodes of types it may join. Each row points at its nodes
    by an example urn (a pointer). ``[]`` without an ontology."""
    if not ontology or not ontology.get("node_types"):
        return []
    fields = ontology.get("fields") or {}
    node_types = sorted(dict.fromkeys(ontology["node_types"]))[:_TEMPLATE_CAP]
    rows: List[Dict[str, Any]] = []
    for etype in node_types:
        row: Dict[str, Any] = {"kind": "node", "urn": _example_urn(etype), "entityType": etype,
                               "displayName": f"Example {etype}", "_op": ""}
        for f in fields.get(etype) or []:
            row[f"prop.{f['id']}"] = _EXAMPLE_VALUE.get(str(f.get("type") or "").lower(),
                                                        f"example {f.get('name') or f['id']}")
        rows.append(row)
    ends = ontology.get("edge_ends") or {}
    for etype in sorted(dict.fromkeys(ontology.get("edge_types") or []))[:_TEMPLATE_CAP]:
        allowed = ends.get(etype) or {}
        source = next((t for t in allowed.get("source") or node_types if t in node_types), None)
        target = next((t for t in allowed.get("target") or node_types[1:] + node_types[:1]
                       if t in node_types), None)
        if source and target:
            rows.append({"kind": "edge", "edgeType": etype, "sourceUrn": _example_urn(source),
                         "targetUrn": _example_urn(target), "_op": ""})
    return rows


def template_columns(ontology: Optional[Mapping[str, Any]],
                     identity_property: Optional[str] = None) -> Dict[str, List[str]]:
    """The property and end-key columns a template carries beyond its rows' own, as
    ``column_order`` takes them: every field the ontology defines, the identifier property, and
    for edges the identifier and the fields types are matched by, at either end."""
    node = sorted({f"prop.{f['id']}" for fs in ((ontology or {}).get("fields") or {}).values()
                   for f in fs} | ({f"prop.{identity_property}"} if identity_property else set()))
    keyed = sorted({k for ks in ((ontology or {}).get("keys") or {}).values() for k in ks}
                   | ({identity_property} if identity_property else set()))
    edge = [f"{end}.{k}" for k in keyed for end in ("source", "target")]
    return {"node": node, "edge": edge}


def columns_guide(columns: Sequence[str], ontology: Optional[Mapping[str, Any]] = None,
                  identity_property: Optional[str] = None) -> List[Tuple[str, str, str, str]]:
    """``(column, for, required, meaning)`` for each of ``columns``, for the template's Columns
    sheet: what the contract says of it, and of a ``prop.<field>`` what the ontology does."""
    spec = {name: (f.alias or name, f.description or "") for model in
            (ImportNodeRecord, ImportEdgeRecord) for name, f in model.model_fields.items()}
    meaning = {alias: text for alias, text in spec.values()}
    applies = {alias: "node" for alias, _ in (spec[n] for n in ImportNodeRecord.model_fields)}
    for name in ImportEdgeRecord.model_fields:
        alias = spec[name][0]
        applies[alias] = "node, edge" if applies.get(alias) == "node" else "edge"
    typed = _typed_properties(ontology or {})
    out: List[Tuple[str, str, str, str]] = []
    for column in columns:
        if column == "kind":
            out.append((column, "node, edge", "yes", "`node` or `edge`. On a spreadsheet, the "
                        "sheet it is on (Nodes, Edges) says it."))
        elif column in meaning:
            required = {"entityType": "for a new node", "edgeType": "yes"}.get(column, "")
            out.append((column, applies[column], required, meaning[column]))
        elif identity_property and column == f"prop.{identity_property}":
            out.append((column, "node", "", "The data source's identifier property: reserved, it "
                        f"holds the node's urn. A value here is a pointer, like `urn`. {_POINTER}"))
        elif column.startswith("prop."):
            note = (typed.get(column, {}).get("description") or "A property").rstrip(".")
            out.append((column, "node, edge", "", f"{note}. A blank cell leaves it as it is; "
                        f"`{DELETE_TOKEN}` removes it."))
        elif column.startswith(("source.", "target.")):
            end, _, field = column.partition(".")
            out.append((column, "edge", "", f"The {end} node's `{field}`: the end is found by it."))
        else:
            out.append((column, "", "", ""))
    return out
