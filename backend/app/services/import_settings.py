"""A data source's import settings: what its imports' rows find their entities by when an import
names no ``identifier``, and the replace guard's limits (doc 08 §3, §6).

Each field is a setting in the settings store (``config/versioned_graph_settings.py``,
``imports.*``), and resolves on its own: the data source's graph's value, else its workspace's,
else the platform's (its environment's, ``GRAPHVER_IMPORT_IDENTIFIER`` and ``IMPORT_REPLACE_*``,
before a system administrator sets one). They are read where an import is made and kept on its job
(``jobs.import_settings``), with the replace guard's switch, the refused rows it allows and how many
properties its graph may match by. So a job runs to the end under the settings it started with,
resumed or not. A fork's are its root's, but for a ``prop.<name>`` identifier (with ``,urn`` or
not): a fork's rows can't be matched by a property yet (``keys.NotOnAFork``), so there that
default is ``entity_id``. The exception is the data source's identifier property, which holds the
urn and is matched as ``urn``.

:func:`resolve` is the same rule over the old columns (``WorkspaceDataSourceORM.import_*``), which
one release keeps writing (``settings.legacy``) and compares against.
"""
from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

from backend.app.services.versioning.import_export import identifier as identifiers

SOURCE_REQUEST, SOURCE_DATA_SOURCE, SOURCE_WORKSPACE, SOURCE_PLATFORM, SOURCE_FORK = (
    "request", "data_source", "workspace", "platform", "fork")

#: (old column, API field, setting)
FIELDS = (
    ("import_identifier", "identifier", "imports.identifier"),
    ("import_replace_min_live", "replaceMinLive", "imports.guardMinLive"),
    ("import_replace_delete_fraction", "replaceDeleteFraction", "imports.guardDeleteShare"),
    ("import_replace_create_fraction", "replaceCreateFraction", "imports.guardCreateShare"),
    ("import_replace_min_match_fraction", "replaceMinMatchFraction", "imports.minMatchShare"),
)
#: The guard's fields, by the names a job's limits give them (``replace_verdict``).
_LIMITS = (("replaceMinLive", "minLive"), ("replaceDeleteFraction", "deleteFraction"),
           ("replaceCreateFraction", "createFraction"), ("replaceMinMatchFraction", "minMatchFraction"))
#: Where a value came from, as the resolver names it, in these settings' words: the platform's,
#: the environment's and the built-in one are all ``platform``.
_SOURCES = {"graph": SOURCE_DATA_SOURCE, "workspace": SOURCE_WORKSPACE}


def platform() -> Dict[str, Any]:
    """The platform's settings, by API field, as this process last read them."""
    from backend.app.services.settings import effective as settings

    return {api: settings.value(key) for _column, api, key in FIELDS}


def settings_of(row: Any) -> Dict[str, Any]:
    """What a data source's old columns hold, by API field; None where it sets nothing."""
    return {api: (getattr(row, column, None) if row is not None else None)
            for column, api, _key in FIELDS}


def _on_a_fork(values: Dict[str, Any], sources: Dict[str, str],
               identity_property: Optional[str]) -> None:
    """A fork's identifier: a ``prop.<name>`` one (with ``,urn`` or not), which a fork can't match by
    yet, becomes ``entity_id``, from ``fork``. The exception is ``prop.<identity_property>`` (with
    ``,urn`` or not), the data source's identifier property, which holds the urn: an import
    matches it as ``urn``, on a fork too."""
    held_by_urn = (bool(identity_property)
                   and identifiers.property_of(values["identifier"]) == identity_property)
    if values["identifier"].startswith("prop.") and not held_by_urn:
        values["identifier"], sources["identifier"] = identifiers.ENTITY_ID, SOURCE_FORK


def resolve(row: Any, *, fork: bool = False,
            identity_property: Optional[str] = None) -> Dict[str, Any]:
    """The settings the old columns give a data source's imports (``row`` may be None), each with
    where it came from (``sources``: ``data_source`` or ``platform``), and on a fork's graph
    (``fork``) its identifier as :func:`_on_a_fork` has it. Pure, but for the platform's."""
    own, values, sources = settings_of(row), {}, {}
    defaults = platform()
    for _column, api, _key in FIELDS:
        if own[api] is not None:
            values[api], sources[api] = own[api], SOURCE_DATA_SOURCE
        else:
            values[api], sources[api] = defaults[api], SOURCE_PLATFORM
    if fork:
        _on_a_fork(values, sources, identity_property)
    return {**values, "sources": sources}


def _target(workspace_id: Optional[str], data_source_id: Optional[str],
            root_id: Optional[str]) -> Dict[str, Any]:
    return {"workspace_id": workspace_id, "graph_id": data_source_id,
            "graph_facts": {"fork_of": root_id} if root_id else None}


async def effective(workspace_id: Optional[str] = None, data_source_id: Optional[str] = None, *,
                    root_id: Optional[str] = None, fork: bool = False,
                    identity_property: Optional[str] = None) -> Dict[str, Any]:
    """The settings a data source's imports run under, from the settings store: its graph's value
    (``root_id``: a fork's root data source, whose values it follows), else its workspace's, else
    the platform's. Each comes with where it came from (``sources``: ``data_source``,
    ``workspace`` or ``platform``). On a fork's graph (``fork``), the identifier is as
    :func:`_on_a_fork` has it."""
    from backend.app.services.settings import effective as settings, resolver

    ctx = await settings.refresh()
    target = settings.target(**_target(workspace_id, data_source_id, root_id))
    values, sources = {}, {}
    for _column, api, key in FIELDS:
        found = resolver.resolve(ctx, key, target)
        values[api], sources[api] = found["effective"], _SOURCES.get(found["source"],
                                                                     SOURCE_PLATFORM)
    if fork:
        _on_a_fork(values, sources, identity_property)
    return {**values, "sources": sources}


async def for_import(workspace_id: Optional[str], data_source_id: Optional[str],
                     requested: Optional[str], *, root_id: Optional[str] = None,
                     fork: bool = False,
                     identity_property: Optional[str] = None) -> Tuple[str, Dict[str, Any]]:
    """What an import into a data source's graph runs under, as :func:`effective` has it. Returns
    its identifier: the request's, checked
    (:class:`~backend.app.services.versioning.import_export.identifier.IdentifierError`), else the
    graph's. Returns too what its job keeps, so the import never changes its rules on the way:
    where the identifier came from (``identifierSource``: ``request``, ``data_source``,
    ``workspace``, ``platform`` or ``fork``), the replace guard's switch (``replaceGuard``) and
    limits with where each came from (``replaceLimits``), the refused rows it allows
    (``maxRefusedRows``, as ``import_worker.refused_budget`` reads it) and how many properties its
    graph's imports may match by (``maxMatchingProperties``). A property the request names is
    kept, on a fork too."""
    from backend.app.services.settings import effective as settings, registry, resolver

    found = await effective(workspace_id, data_source_id, root_id=root_id, fork=fork,
                            identity_property=identity_property)
    named = identifiers.parse(requested)
    identifier, source = ((named, SOURCE_REQUEST) if named
                          else (found["identifier"], found["sources"]["identifier"]))
    limits = {short: found[api] for api, short in _LIMITS}
    limits["sources"] = {short: found["sources"][api] for api, short in _LIMITS}
    target = _target(workspace_id, data_source_id, root_id)
    budget = settings.value("imports.maxRefusedRows", **target)
    return identifier, {
        "identifierSource": source, "replaceLimits": limits,
        "replaceGuard": settings.value("imports.replaceGuard", **target),
        "maxRefusedRows": resolver.encode(registry().BY_KEY["imports.maxRefusedRows"], budget),
        "maxMatchingProperties": settings.value("imports.maxMatchingProperties")}


async def own(session, data_source_id: str) -> Dict[str, Any]:
    """What a data source's graph chose itself in the settings store, by API field; None where it
    chose nothing."""
    from backend.app.services.settings import registry, store

    held = {r.key: r.value for r in await store.read_scope(session, registry().DOMAIN, "graph",
                                                           data_source_id)}
    return {api: held.get(key) for _column, api, key in FIELDS}


def apply(row: Any, changes: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Write ``changes`` (by API field; ``"inherit"`` clears one) onto a data source row's old
    columns. Returns what the fields that changed were and became, by API field."""
    before = settings_of(row)
    for column, api, _key in FIELDS:
        if api in changes:
            value = changes[api]
            setattr(row, column, None if value == "inherit" else value)
    after = settings_of(row)
    changed = [api for api in after if after[api] != before[api]]
    return ({api: before[api] for api in changed}, {api: after[api] for api in changed})


def changes_from(body: Any) -> Dict[str, Any]:
    """The fields a request set, by API field name (``"inherit"`` included; left out excluded)."""
    sent = body.model_dump(by_alias=True, exclude_unset=True)
    return {api: sent[api] for _column, api, _key in FIELDS if sent.get(api) is not None}
