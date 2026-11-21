"""Bring your own data: a graph started in the Playground from a person's own things and
connections (``POST /playground/imports``).

The client reads the file (CSV or JSON) and sends its rows; the server never takes a file. What
it sends is held to the limits here — at most ``THINGS_MAX`` things, ``CONNECTIONS_MAX``
connections and ``TYPES_MAX`` types of each (413 ``too_large``, with the ``limit``) — and each row
to its own (422 ``invalid_rows``, naming the first ``ERRORS_SHOWN`` rows that are wrong and why:
a field out of bounds, a key used twice, a connection naming a key no thing has).

The rows become a starter graph (``playground_starter``) with a data model of its own, made for
this graph alone: an entity type per thing type and a lineage relationship per connection type,
named as the file names them, each relationship joining the types its rows join. Its id is
``bp_import_<token>``, minted before the data source is (a blank graph needs its data model first).
"""
from __future__ import annotations

import re
import unicodedata
import uuid
from typing import Annotated, Any, Dict, List, Optional, Union

from fastapi import HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StringConstraints, ValidationError

from backend.app.services.playground_starter import EntityType, RelationshipType, Starter

THINGS_MAX = 5000
CONNECTIONS_MAX = 20000
TYPES_MAX = 50
ERRORS_SHOWN = 50

_Text = Annotated[str, StringConstraints(max_length=2000)]
_Number = Annotated[float, Field(strict=True, allow_inf_nan=False)]
_Key = Annotated[str, StringConstraints(min_length=1, max_length=128)]
_Tag = Annotated[str, StringConstraints(min_length=1, max_length=40)]


class Thing(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    key: str = Field(min_length=1, max_length=200)
    type: str = Field(min_length=1, max_length=60)
    name: str = Field(min_length=1, max_length=200)
    description: Optional[str] = Field(None, max_length=4000)
    properties: Dict[_Key, Union[StrictBool, StrictInt, _Number, _Text, None]] = Field(
        default_factory=dict, max_length=50)
    tags: List[_Tag] = Field(default_factory=list, max_length=20)


class Connection(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, populate_by_name=True)

    source: str = Field(alias="from", min_length=1, max_length=200)
    type: str = Field(min_length=1, max_length=60)
    target: str = Field(alias="to", min_length=1, max_length=200)


class PlaygroundImport(BaseModel):
    """What the client read from the file. Each thing and connection is checked as a
    :class:`Thing` or :class:`Connection` of its own, so a refusal names its row."""
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=80)
    description: Optional[str] = Field(None, max_length=4000)
    things: List[Any] = Field(min_length=1)
    connections: List[Any] = Field(default_factory=list)


def _too_large(section: str, limit: int, what: str, count: int) -> HTTPException:
    return HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail={
        "type": "too_large", "section": section, "limit": limit,
        "message": f"A graph started here holds at most {limit:,} {what}; this one has {count:,}."})


def _row_errors(section: str, index: int, exc: ValidationError) -> List[dict]:
    return [{"section": section, "index": index, "field": str(err["loc"][0]) if err["loc"] else "row",
             "code": "invalid", "message": err["msg"]} for err in exc.errors()]


def _words(name: str) -> List[str]:
    return re.findall(r"[A-Za-z0-9]+", unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode())


def _entity_type_id(name: str, taken: set) -> str:
    """A type's id from its name, as the types the platform ships are named (``warehouseTable``)."""
    words = _words(name)
    base = (words[0].lower() + "".join(w[:1].upper() + w[1:] for w in words[1:])) if words else "type"
    return _unique(base if base[0].isalpha() else f"t{base}", taken, "")


def _relationship_type_id(name: str, taken: set) -> str:
    """A relationship's id from its name, as the platform's are (``LOADS_INTO``)."""
    base = "_".join(w.upper() for w in _words(name)) or "LINKED_TO"
    return _unique(base if base[0].isalpha() else f"R_{base}", taken, "_")


def _unique(base: str, taken: set, sep: str) -> str:
    out, n = base, 1
    while out in taken:
        n += 1
        out = f"{base}{sep}{n}"
    taken.add(out)
    return out


def urn_of(key: str) -> str:
    """A thing's urn: its key when that is one, else one made from it."""
    return key if key.startswith("urn:") else f"urn:playground:{key}"


_COLORS = ("#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ec4899", "#8b5cf6", "#14b8a6", "#f97316",
           "#64748b", "#84cc16")
_FIELDS = (
    {"id": "name", "name": "Name", "type": "string", "show_in_tooltip": True, "display_order": 1},
    {"id": "description", "name": "Description", "type": "markdown", "show_in_node": False, "display_order": 2},
)


def new_ontology_id() -> str:
    return f"bp_import_{uuid.uuid4().hex[:12]}"


def starter_of(body: PlaygroundImport, ontology_id: str) -> Starter:
    """The import as a starter graph — or the refusal: 413 ``too_large``, 422 ``invalid_rows``."""
    if len(body.things) > THINGS_MAX:
        raise _too_large("things", THINGS_MAX, "things", len(body.things))
    if len(body.connections) > CONNECTIONS_MAX:
        raise _too_large("connections", CONNECTIONS_MAX, "connections", len(body.connections))
    errors: List[dict] = []
    things: Dict[str, Thing] = {}
    for i, raw in enumerate(body.things):
        try:
            thing = Thing.model_validate(raw)
        except ValidationError as exc:
            errors += _row_errors("things", i, exc)
            continue
        if thing.key in things:
            errors.append({"section": "things", "index": i, "field": "key", "code": "duplicate_key",
                           "message": f"Another thing already has the key “{thing.key}”."})
        else:
            things[thing.key] = thing
    connections: Dict[tuple, Connection] = {}
    for i, raw in enumerate(body.connections):
        try:
            link = Connection.model_validate(raw)
        except ValidationError as exc:
            errors += _row_errors("connections", i, exc)
            continue
        missing = [(field, key) for field, key in (("from", link.source), ("to", link.target)) if key not in things]
        errors += [{"section": "connections", "index": i, "field": field, "code": "unknown_key",
                    "message": f"No thing has the key “{key}”."} for field, key in missing]
        if not missing:
            connections.setdefault((link.source, link.type, link.target), link)    # once is enough
    if errors:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail={
            "type": "invalid_rows", "count": len(errors), "errors": errors[:ERRORS_SHOWN],
            "message": f"{len(errors):,} problem{'s' if len(errors) != 1 else ''} in the rows: "
                       "fix them and send it again. Nothing was made."})

    thing_types = list(dict.fromkeys(t.type for t in things.values()))
    link_types = list(dict.fromkeys(c.type for c in connections.values()))
    if len(thing_types) > TYPES_MAX:
        raise _too_large("thingTypes", TYPES_MAX, "types of thing", len(thing_types))
    if len(link_types) > TYPES_MAX:
        raise _too_large("connectionTypes", TYPES_MAX, "types of connection", len(link_types))
    entity_taken: set = set()
    relationship_taken: set = set()
    entity_ids = {name: _entity_type_id(name, entity_taken) for name in thing_types}
    relationship_ids = {name: _relationship_type_id(name, relationship_taken) for name in link_types}
    rows = tuple(
        {"kind": "node", "urn": urn_of(t.key), "entityType": entity_ids[t.type], "displayName": t.name,
         **({"description": t.description} if t.description else {}),
         "properties": dict(t.properties), "tags": list(t.tags)}
        for t in things.values()
    ) + tuple(
        {"kind": "edge", "edgeType": relationship_ids[c.type], "source": urn_of(c.source),
         "target": urn_of(c.target)}
        for c in connections.values()
    )
    return Starter(
        title=body.name, description=body.description, icon="Upload",
        ontology_id=ontology_id, ontology_name=f"{body.name} data model",
        ontology_description=f"Made for the graph “{body.name}”, from the things and connections "
                             "imported into the Playground.",
        entity_types={tid: EntityType(name, name, f"{name}, as the import names them.", "Box",
                                      _COLORS[i % len(_COLORS)])
                      for i, (name, tid) in enumerate(entity_ids.items())},
        relationship_types={rid: RelationshipType(name, f"{name}, as the import names it.",
                                                  _COLORS[i % len(_COLORS)])
                            for i, (name, rid) in enumerate(relationship_ids.items())},
        fields=_FIELDS, rows=rows, message=f"Imported {body.name}", view_name=body.name,
    )
