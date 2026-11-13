"""Which key an import's rows find their entities by: its ``identifier`` (doc 08 §3, doc 18 §4).

* ``entity_id``, the default: a row names its entity by an entity id of the graph; else by its
  urn, or its value of the data source's identifier property; else by a field its type matches
  imports by; else, a row with no urn, by a unique qualifiedName.
* ``urn``: by an entity id of the graph, else by its urn, and nothing else.
* ``prop.<name>``: by an entity id of the graph, else by its value of the property ``<name>``,
  through the property's index (:mod:`.keys`), which the first import naming it builds.
* ``prop.<name>,urn``: the property, then the urn — a row that carries the property is found by
  it, one that doesn't (a top-level container the source system has no id for) by its urn, as
  ``urn`` finds it; and a node found by its urn takes the row's value, so the next import finds it
  by the property. Any key a row carries must name the same entity as the one it is found by.

Whichever it is, an entity's id never changes: the identifier only says how a row finds it. An
import names one, else its data source's default holds, else the platform's
(``services.import_settings``); its job keeps it (``jobs.identity_strategy``), and a resumed job
keeps it too.
"""
from __future__ import annotations

from typing import Optional

from .. import config

ENTITY_ID, URN = "entity_id", "urn"
_PROP = "prop."
#: What follows a property to fall back to the urn: ``prop.<name>,urn``.
URN_FALLBACK = f",{URN}"
_GRAMMAR = "identifier is entity_id, urn, prop.<name>, or prop.<name>,urn (the property, then the urn)"


class IdentifierError(ValueError):
    """An ``identifier`` the request may not name; the message says what it may."""


def parse(value: Optional[str]) -> Optional[str]:
    """The identifier a request names, checked; None when it names none (anything but text: a
    route called directly holds its query parameter's declaration)."""
    v = value.strip() if isinstance(value, str) else ""
    if not v:
        return None
    head, comma, tail = v.rpartition(",")
    if comma and tail.strip() == URN:
        first = _one(head.strip())
        if not first.startswith(_PROP):
            raise IdentifierError(f"{_GRAMMAR}: only a property falls back to the urn, not {v!r}")
        return first + URN_FALLBACK
    return _one(v)


def _one(v: str) -> str:
    if v in (ENTITY_ID, URN):
        return v
    if v.startswith(_PROP):
        name = v[len(_PROP):].strip()
        if not name:
            raise IdentifierError(f"{_GRAMMAR}: prop. needs the property's name")
        if name in (ENTITY_ID, URN):
            raise IdentifierError(f"the {name} is not a property: use identifier={name}")
        if len(name) > 200 or any(c in name for c in "\r\n\t"):
            raise IdentifierError(f"{_GRAMMAR}: a property's name is one line of up to 200 characters")
        return f"{_PROP}{name}"
    raise IdentifierError(f"{_GRAMMAR}, not {v!r}")


def property_of(identifier: Optional[str]) -> Optional[str]:
    """The property an identifier matches by — ``<name>`` of ``prop.<name>`` or
    ``prop.<name>,urn`` — or None for ``entity_id`` and ``urn``."""
    if not identifier or not identifier.startswith(_PROP):
        return None
    name = identifier[len(_PROP):]
    return name[:-len(URN_FALLBACK)] if name.endswith(URN_FALLBACK) else name


def falls_back(identifier: Optional[str]) -> bool:
    """Whether an identifier finds a row without its property by the urn (``prop.<name>,urn``)."""
    return bool(identifier) and identifier.startswith(_PROP) and identifier.endswith(URN_FALLBACK)


def platform_default() -> str:
    """``GRAPHVER_IMPORT_IDENTIFIER``, when it is one an import may name; else ``entity_id``."""
    try:
        return parse(config.IMPORT_IDENTIFIER) or ENTITY_ID
    except IdentifierError:
        return ENTITY_ID
