"""A data source's import settings: what its imports' rows find their entities by when an import
names no ``identifier``, and the replace guard's limits (doc 08 §3, §6).

Each field resolves on its own: the data source's own (``WorkspaceDataSourceORM.import_*``), else
the platform's (``GRAPHVER_IMPORT_IDENTIFIER``, ``IMPORT_REPLACE_*``). NULL at the data source means
"not set here". They are read where an import is made and kept on its job (``jobs.import_settings``),
so a job runs to the end under the settings it started with, resumed or not. A fork's are its
parent's (``fork_sources.GOVERNING``), but for a ``prop.<name>`` identifier: a fork's rows can't be
matched by a property yet (``keys.NotOnAFork``), so there that default is ``entity_id`` — unless
the property is the data source's identifier property, which holds the urn and is matched as
``urn``. The guard's on/off switch, ``IMPORT_REPLACE_GUARD``, is the platform's alone.
"""
from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

from backend.app.services.versioning import config
from backend.app.services.versioning.import_export import identifier as identifiers

SOURCE_REQUEST, SOURCE_DATA_SOURCE, SOURCE_PLATFORM, SOURCE_FORK = (
    "request", "data_source", "platform", "fork")

#: (column, API field, the platform's value)
FIELDS = (
    ("import_identifier", "identifier", identifiers.platform_default),
    ("import_replace_min_live", "replaceMinLive", lambda: config.IMPORT_REPLACE_GUARD_MIN_LIVE),
    ("import_replace_delete_fraction", "replaceDeleteFraction",
     lambda: config.IMPORT_REPLACE_GUARD_DELETE_FRACTION),
    ("import_replace_create_fraction", "replaceCreateFraction",
     lambda: config.IMPORT_REPLACE_GUARD_CREATE_FRACTION),
    ("import_replace_min_match_fraction", "replaceMinMatchFraction",
     lambda: config.IMPORT_REPLACE_MIN_MATCH_FRACTION),
)
#: The guard's fields, by the names a job's limits give them (``replace_verdict``).
_LIMITS = (("replaceMinLive", "minLive"), ("replaceDeleteFraction", "deleteFraction"),
           ("replaceCreateFraction", "createFraction"), ("replaceMinMatchFraction", "minMatchFraction"))


def platform() -> Dict[str, Any]:
    """The platform's settings, by API field."""
    return {api: default() for _column, api, default in FIELDS}


def settings_of(row: Any) -> Dict[str, Any]:
    """What a data source sets itself, by API field; None where it sets nothing."""
    return {api: (getattr(row, column, None) if row is not None else None)
            for column, api, _default in FIELDS}


def resolve(row: Any, *, fork: bool = False,
            identity_property: Optional[str] = None) -> Dict[str, Any]:
    """The settings a data source's imports run under (``row`` may be None), each with where it came
    from (``sources``: ``data_source`` or ``platform``). On a fork's graph (``fork``) a
    ``prop.<name>`` identifier, which a fork can't match by yet, is ``entity_id``, from ``fork`` —
    but ``prop.<identity_property>``, the data source's identifier property, which holds the urn:
    an import matches it as ``urn``, on a fork too. Pure."""
    own, values, sources = settings_of(row), {}, {}
    for _column, api, default in FIELDS:
        if own[api] is not None:
            values[api], sources[api] = own[api], SOURCE_DATA_SOURCE
        else:
            values[api], sources[api] = default(), SOURCE_PLATFORM
    held_by_urn = bool(identity_property) and values["identifier"] == f"prop.{identity_property}"
    if fork and values["identifier"].startswith("prop.") and not held_by_urn:
        values["identifier"], sources["identifier"] = identifiers.ENTITY_ID, SOURCE_FORK
    return {**values, "sources": sources}


def for_import(row: Any, requested: Optional[str], *, fork: bool = False,
               identity_property: Optional[str] = None) -> Tuple[str, Dict[str, Any]]:
    """What an import into ``row``'s graph (``fork``: a fork's, whose data source identifies its
    nodes by ``identity_property``) runs under: its identifier (the request's, checked —
    :class:`~backend.app.services.versioning.import_export.identifier.IdentifierError` — else the
    data source's, else the platform's, as :func:`resolve` has it), and what its job keeps: where
    the identifier came from (``identifierSource``: ``request``, ``data_source``, ``platform``, or
    ``fork``) and the replace guard's limits with where each came from (``replaceLimits``). A
    property the request names is kept, on a fork too."""
    effective = resolve(row, fork=fork, identity_property=identity_property)
    named = identifiers.parse(requested)
    identifier, source = ((named, SOURCE_REQUEST) if named
                          else (effective["identifier"], effective["sources"]["identifier"]))
    limits = {short: effective[api] for api, short in _LIMITS}
    limits["sources"] = {short: effective["sources"][api] for api, short in _LIMITS}
    return identifier, {"identifierSource": source, "replaceLimits": limits}


def apply(row: Any, changes: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Write ``changes`` (by API field; ``"inherit"`` clears one) onto a data source row. Returns what
    the fields that changed were and became, by API field."""
    before = settings_of(row)
    for column, api, _default in FIELDS:
        if api in changes:
            value = changes[api]
            setattr(row, column, None if value == "inherit" else value)
    after = settings_of(row)
    changed = [api for api in after if after[api] != before[api]]
    return ({api: before[api] for api in changed}, {api: after[api] for api in changed})


def changes_from(body: Any) -> Dict[str, Any]:
    """The fields a request set, by API field name (``"inherit"`` included; left out excluded)."""
    sent = body.model_dump(by_alias=True, exclude_unset=True)
    return {api: sent[api] for _column, api, _default in FIELDS if sent.get(api) is not None}
