"""A property operation, decided for one entity on the value it has now.

The Property Manager's bulk operations reach :meth:`GraphVersioningService.apply_ops` as
directives, not patches. A patch is what the browser decided from what it last saw; a directive is
decided inside the commit's transaction on the entity's current value in the draft, and again on
each retry, so an operation across many entities never writes over an edit it didn't see, and says
for each entity what it did.

For the key ``k`` (``n`` the new key of a rename):

* ``set k=v`` — absent: added; blank or another value: replaced, written as typed (``"42"``
  becomes ``42``); the same value of the same type: unchanged.
* ``fillEmpty k=v`` — absent or blank: set; any other value: unchanged.
* ``rename k→n`` — absent: unchanged; otherwise the value moves to ``n`` verbatim (type, list and
  nesting kept) and ``k`` goes — unless ``n`` has a value of its own (``targetExists``); a blank
  ``n`` is overwritten.
* ``remove k`` — absent: unchanged; otherwise dropped.

"Blank" is exactly what search's ``isEmpty`` matches (:func:`search_semantics.is_blank`), so an
operation acts on what a search for it finds.
"""
from __future__ import annotations

from typing import Any, Mapping, NamedTuple, Optional

from backend.common.search_semantics import is_blank

KINDS = ("set", "fillEmpty", "rename", "remove")


class Resolution(NamedTuple):
    outcome: str                    # "changed" | "unchanged" | "targetExists"
    payload: Optional[dict] = None  # the entity's new payload, when changed


_UNCHANGED = Resolution("unchanged")


def check(directive: Mapping[str, Any]) -> None:
    """Raise ``ValueError`` for a directive no entity could be decided by."""
    kind, key = directive.get("kind"), directive.get("key")
    if kind not in KINDS:
        raise ValueError(f"unknown property operation {kind!r}")
    if not isinstance(key, str) or not key:
        raise ValueError(f"a {kind} needs the key it acts on")
    if kind in ("set", "fillEmpty") and "value" not in directive:
        raise ValueError(f"a {kind} needs a value")
    if kind == "rename":
        new_key = directive.get("newKey")
        if not isinstance(new_key, str) or not new_key or new_key == key:
            raise ValueError("a rename needs a new key other than the old one")


def resolve(current: Mapping[str, Any], directive: Mapping[str, Any]) -> Resolution:
    """What ``directive`` does to an entity whose current payload is ``current``."""
    kind, key = directive["kind"], directive["key"]
    props = dict(current.get("properties") or {})
    if kind == "set":
        value = directive["value"]
        if key in props and type(props[key]) is type(value) and props[key] == value:
            return _UNCHANGED
        props[key] = value
    elif kind == "fillEmpty":
        if not is_blank(props.get(key)):
            return _UNCHANGED
        props[key] = directive["value"]
    elif kind == "rename":
        if key not in props:
            return _UNCHANGED
        new_key = directive["newKey"]
        if not is_blank(props.get(new_key)):
            return Resolution("targetExists")
        props[new_key] = props.pop(key)
    elif kind == "remove":
        if key not in props:
            return _UNCHANGED
        del props[key]
    else:
        raise ValueError(f"unknown property operation {kind!r}")
    return Resolution("changed", {**current, "properties": props})
