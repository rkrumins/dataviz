"""Keep a stored property's type when a patch sends the same value back in a lossier form.

The canvas round-trips a node's whole ``properties`` object on every save
(``stagedChangesToOps.ts`` sends ``after.properties`` verbatim), and that object has
been through the browser. Two things happen to a value on the way:

* ``JSON.parse`` turns every integer into an IEEE double, so any integer beyond
  ±(2^53 − 1) — ids, hashes, snowflakes — comes back ROUNDED
  (-3746471915534727923 → -3746471915534727700). Saved as-is, one unrelated edit on the
  drawer rewrote the stored value with a different number.
* Editors that hold text send digits back as a string ("42" for 42), which silently
  retypes the property: an equality predicate typed as a number stops matching it.

Neither is a change the user made. So for a key the stored payload already has, an
incoming value that is EQUAL to the stored one — equal as the client could represent it
— keeps the stored value, type and all. Anything that differs is a real edit and wins.
The rule never invents a value: it only ever chooses between the two it was given.
"""
from __future__ import annotations

import math
import re
from typing import Any

_INT_TEXT = re.compile(r"-?\d+")


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _same_int(stored: int, incoming: Any) -> bool:
    if isinstance(incoming, str):
        text = incoming.strip()
        return bool(_INT_TEXT.fullmatch(text)) and int(text) == stored
    if isinstance(incoming, float):
        # For a safe integer this is exact equality; past 2^53 it is "the double the
        # client parsed this value into", which is the only form it could send back.
        return math.isfinite(incoming) and float(stored) == incoming
    return False


def _same_float(stored: float, incoming: Any) -> bool:
    if isinstance(incoming, str):
        try:
            return float(incoming.strip()) == stored
        except ValueError:
            return False
    if isinstance(incoming, int) and not isinstance(incoming, bool):
        # JSON.stringify(1.0) is "1": a whole float comes back as an integer.
        return float(incoming) == stored
    return False


def _same_bool(stored: bool, incoming: Any) -> bool:
    return isinstance(incoming, str) and incoming.strip().lower() == ("true" if stored else "false")


def _same_text(stored: str, incoming: Any) -> bool:
    """A string that holds a number, sent back as the number ("1.50" as 1.5)."""
    if not _is_number(incoming):
        return False
    try:
        return float(stored.strip()) == float(incoming)
    except ValueError:
        return False


def preserve_stored_type(stored: Any, incoming: Any) -> Any:
    """The value to store for one key when a patch sends ``incoming`` over ``stored``.

    Returns ``stored`` when ``incoming`` is the same value in a lossier or retyped form,
    else ``incoming``. Lists and dicts are compared element by element (same length /
    same key), so a list of ids keeps every element the client could not represent.
    """
    if stored is None or incoming is None or incoming is stored:
        return incoming
    if isinstance(stored, bool):
        return stored if _same_bool(stored, incoming) else incoming
    if isinstance(stored, int):
        return stored if _same_int(stored, incoming) else incoming
    if isinstance(stored, float):
        return stored if _same_float(stored, incoming) else incoming
    if isinstance(stored, str):
        return stored if _same_text(stored, incoming) else incoming
    if isinstance(stored, list) and isinstance(incoming, list) and len(stored) == len(incoming):
        return [preserve_stored_type(s, i) for s, i in zip(stored, incoming)]
    if isinstance(stored, dict) and isinstance(incoming, dict):
        return {k: (preserve_stored_type(stored[k], v) if k in stored else v)
                for k, v in incoming.items()}
    return incoming
