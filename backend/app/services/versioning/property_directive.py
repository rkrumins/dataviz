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

Undoing an operation is a ``revert`` per entity: ``restore`` holds each key the operation changed,
as it was ``before`` and as the operation left it (``after``) — a side left out is an absent key.
Every key still as the operation left it goes back; every key already back is unchanged; anything
else was edited since (``changedSince``) and is left as it is. Values compare by type as well:
``42`` is not ``"42"``.
"""
from __future__ import annotations

from typing import Any, Mapping, NamedTuple, Optional

from backend.common.search_semantics import is_blank

KINDS = ("set", "fillEmpty", "rename", "remove")


class Resolution(NamedTuple):
    outcome: str                    # "changed" | "unchanged" | "targetExists" | "changedSince"
    payload: Optional[dict] = None  # the entity's new payload, when changed


_UNCHANGED = Resolution("unchanged")


def check(directive: Mapping[str, Any]) -> None:
    """Raise ``ValueError`` for a directive no entity could be decided by."""
    kind, key = directive.get("kind"), directive.get("key")
    if kind == "revert":
        restore = directive.get("restore")
        if not isinstance(restore, Mapping) or not restore or not all(
                isinstance(k, str) and k and isinstance(v, Mapping) and set(v) <= {"before", "after"}
                for k, v in restore.items()):
            raise ValueError("a revert needs each key it restores, with its value before and after")
        return
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
    kind, key = directive["kind"], directive.get("key")
    props = dict(current.get("properties") or {})
    if kind == "revert":
        restore = directive["restore"]
        if all(_holds(props, k, side, "before") for k, side in restore.items()):
            return _UNCHANGED
        if not all(_holds(props, k, side, "after") for k, side in restore.items()):
            return Resolution("changedSince")
        for k, side in restore.items():
            if "before" in side:
                props[k] = side["before"]
            else:
                props.pop(k, None)
    elif kind == "set":
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


def _holds(props: Mapping[str, Any], key: str, side: Mapping[str, Any], which: str) -> bool:
    """Whether ``props`` holds ``key`` as ``side[which]`` has it — absent when that is left out."""
    if which not in side:
        return key not in props
    return key in props and _identical(props[key], side[which])


def _identical(a: Any, b: Any) -> bool:
    """Equal and of the same type all the way down: ``42`` is not ``"42"``, ``True`` is not ``1``."""
    if type(a) is not type(b):
        return False
    if isinstance(a, list):
        return len(a) == len(b) and all(_identical(x, y) for x, y in zip(a, b))
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(_identical(a[k], b[k]) for k in a)
    return a == b
