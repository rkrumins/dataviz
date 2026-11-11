"""Which key an import's rows find their entities by: its ``identifier`` (doc 08 §3, doc 18 §4).

* ``entity_id``, the default: a row names its entity by an entity id of the graph; else by its
  urn, or its value of the data source's identifier property; else by a field its type matches
  imports by; else, a row with no urn, by a unique qualifiedName.
* ``urn``: by an entity id of the graph, else by its urn, and nothing else.
* ``prop.<name>``: by an entity id of the graph, else by its value of the property ``<name>``,
  through the property's index (:mod:`.keys`), which the first import naming it builds.

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
_GRAMMAR = "identifier is entity_id, urn or prop.<name>"


class IdentifierError(ValueError):
    """An ``identifier`` the request may not name; the message says what it may."""


def parse(value: Optional[str]) -> Optional[str]:
    """The identifier a request names, checked; None when it names none (anything but text: a
    route called directly holds its query parameter's declaration)."""
    v = value.strip() if isinstance(value, str) else ""
    if not v:
        return None
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


def platform_default() -> str:
    """``GRAPHVER_IMPORT_IDENTIFIER``, when it is one an import may name; else ``entity_id``."""
    try:
        return parse(config.IMPORT_IDENTIFIER) or ENTITY_ID
    except IdentifierError:
        return ENTITY_ID
