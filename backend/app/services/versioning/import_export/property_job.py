"""Bulk property jobs: one property operation over many entities of a draft, run on the transfer lane.

A job is ONE operation (``op``) — ``set``, ``fillEmpty``, ``remove``, ``rename`` or ``copy`` of one
property key, or a clean-up of the values it holds (``replace``, ``normalize``, ``mapValues``,
``convert``) — over a target: up to ``PROPERTY_JOB_MAX_IDS`` entities named by id (their urns, or
``gv:<entity id>`` as the canvas names them), or every entity an Advanced Search predicate matches
in a view (``PROPERTY_JOB_MAX_TARGETS`` at most). It writes only to its draft, never to main.

Its writes are exact (``apply_ops``' ``exact_types``): a value is stored as the job computed it,
kind and all — a ``convert`` to Integer writes 42 over "42", a ``set`` of 1 writes 1 over 1.0 —
where a save keeps a stored value sent back in a lossier form. A value that ends up reading as a
date or a moment is stored the one way every write stores dates (``backend.common.moments``), and
the plan compares what is stored with that, so it counts as changed only what a write changes.

Its targets are kept as chunk files in the object store, ``property-jobs/{job}/targets/{i}.ndjson``,
``PROPERTY_JOB_WINDOW`` keys each: an id target's are written when the job is made; a search
target's by the job itself, from an export of the search (the injected ``targets`` hook). Each chunk
is then one WINDOW: its entities read from the draft as they stand, a properties patch planned for
each (:func:`plan_patch`), and the patches written as ONE commit — with the job's checkpoint (its
cursor, progress and running summary) in the same transaction, as an import window is. So the job
resumes where it stopped after a takeover, a window is never written twice, and a cancel (the row
no longer running) stops it at its next checkpoint, keeping the windows already written. Cursor:

  ``NULL``       a search target not resolved yet;
  ``apply:<i>``  the windows before chunk ``i`` written (``apply:0``: none yet).

What a window could not write as asked is kept in ``property-jobs/{job}/refused/{i}.ndjson`` (the
job's refused rows, as CSV through the API) and counted in the summary by reason: ``missing`` (no
such entity in the draft), ``deleted_in_draft``, ``conflict`` (a rename or copy whose new key is
held already, skipped), ``unconvertible`` (a ``convert`` whose value is not of the kind asked for,
left as it is — with ``onFail: remove`` it is removed, and counted but not refused) and
``write_refused`` (the write gate turned it away; the window's other entities are written, as an
import's are).

When the draft is published, the jobs that wrote to it are listed in the publish's commit
(``stats.propertyJobs``, :func:`audit_entry`) and its activity event, and stamped with that commit
(``summary.publishedCommitId``), so a later publish never lists them again.
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import logging
import math
import re
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Callable, Dict, Iterable, List, Mapping, NamedTuple, Optional, Tuple

from sqlalchemy import select

from backend.app.services.storage.object_store import storage_key
from backend.common.moments import canonical
from backend.common.property_patch import PROP_DELETE
from backend.common.search_semantics import INT64_MAX, INT64_MIN, fold_case

from .. import config, db
from ..change_csv import cell
from ..errors import BranchNotOpen
from ..job_lease import Lease, Superseded
from ..models import BranchORM, CommitORM, JobORM
from ..service import OntologyViolation
from .snapshot import Snapshot, open_snapshot
from .stream import resolve_placements

logger = logging.getLogger(__name__)

KINDS = ("set", "fillEmpty", "remove", "rename", "copy", "replace", "normalize", "mapValues", "convert")
#: The kinds that rewrite the values a key holds, where it is held — a clean-up. Each writes the key
#: itself, so none adds a property name.
CLEANUPS = ("replace", "normalize", "mapValues", "convert")
#: The kinds a ``convert`` writes, as the catalog names them (``typeOf``).
CONVERT_KINDS = ("Integer", "Float", "String", "Boolean")
#: The refused rows a job's summary shows; every one is in its refused files.
REFUSED_EXAMPLES = 20
#: Times a window's other entities are written again after the write gate refused some of them
#: (the gate stops at its first failing check), as an import window's are.
_QUARANTINE_ROUNDS = 4
_DETAIL_CHARS = 300
#: What a job's summary counts, before its first window.
COUNTERS = ("changed", "unchanged", "missing", "deletedInDraft", "conflicts", "unconvertible")
#: The bulk property jobs a publish lists in its commit; past these it counts them.
AUDIT_LISTED = 20


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def empty_summary(chunks: int = 0) -> Dict[str, Any]:
    return {**dict.fromkeys(COUNTERS, 0), "refused": {"count": 0, "byReason": {}, "examples": []},
            "commits": 0, "firstCommitId": None, "lastCommitId": None, "chunks": chunks}


# --------------------------------------------------------------------------- #
# The plan: what one operation does to one entity's properties (pure)          #
# --------------------------------------------------------------------------- #
def _empty(value: Any) -> bool:
    return value is None or value == ""


def _same(a: Any, b: Any) -> bool:
    """Equal as stored: ``1``, ``1.0`` and ``True`` are three values."""
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def _written(value: Any) -> Any:
    """``value`` as a write stores it: a date or a moment in its one form (``property_patch``)."""
    return canonical(value) if isinstance(value, str) else value


def plan_patch(op: Mapping[str, Any], props: Mapping[str, Any],
               rewrite: Optional["Rewrite"] = None) -> Optional[Dict[str, Any]]:
    """The properties patch ``op`` makes to an entity holding ``props`` — a removal as
    :data:`PROP_DELETE` — or ``None`` when it changes nothing:

    * ``set`` writes ``value``, unless the entity holds it already;
    * ``fillEmpty`` writes ``value`` only where the key is absent, null or ``''``;
    * ``remove`` removes the key, where it is held;
    * ``rename`` moves the key's value to ``to`` and removes the key; ``copy`` keeps the key. An
      entity without the key is left as it is, and so is one that holds ``to`` already (a conflict,
      :func:`is_conflict`) unless ``onConflict`` is ``overwrite``;
    * a clean-up (``CLEANUPS``) rewrites the value the key holds (:func:`rewriter`); an entity
      without the key, or whose value it leaves as it is, is unchanged.

    Compared as written — exactly, a date in its one form — so what it plans to change is what the
    job's (exact) write changes. ``rewrite``: the op's :func:`rewriter`, made once for many
    entities."""
    kind, key = op["kind"], op["key"]
    if kind in CLEANUPS:
        return _cleanup(op, props, rewrite or rewriter(op))[0]
    if kind == "set":
        value = _written(op["value"])
        return None if key in props and _same(props[key], value) else {key: value}
    if kind == "fillEmpty":
        return {key: _written(op["value"])} if _empty(props.get(key)) else None
    if kind == "remove":
        return {key: PROP_DELETE} if key in props else None
    to = op["to"]
    if key not in props or is_conflict(op, props):
        return None
    value = _written(props[key])
    patch = {} if to in props and _same(props[to], value) else {to: value}
    if kind == "rename":
        patch[key] = PROP_DELETE
    return patch or None


# --------------------------------------------------------------------------- #
# Clean-ups: the values a key holds, rewritten where it is held                #
# --------------------------------------------------------------------------- #
#: What a clean-up makes of one stored value: the value to store (``_REMOVE``: none), and whether it
#: held something a ``convert`` could not convert.
Rewrite = Callable[[Any], Tuple[Any, bool]]
_REMOVE = object()
_FAIL = object()
_SPACES = re.compile(r"\s+")
_WORD = re.compile(r"\S+")
_INT_TEXT = re.compile(r"[+-]?\d+(?:\.0*)?")
_DEC_TEXT = re.compile(r"[+-]?(?:\d+\.?\d*|\.\d+)")


def kind_of(value: Any) -> Optional[str]:
    """``typeOf`` for a value read from JSON, as the catalog names it
    (``falkordb_search.catalog._kind_of``)."""
    if isinstance(value, bool):
        return "Boolean"
    if isinstance(value, int):
        return "Integer"
    if isinstance(value, float):
        return "Float"
    if isinstance(value, str):
        return "String"
    if isinstance(value, list):
        return "List"
    return None


def _slot(kind: Optional[str], value: Any) -> str:
    """A value's identity, as the catalog counts it (``catalog._slot``): its kind with its JSON, so
    the Integer 1, the Float 1.0, the Boolean true and the String "1" stay four values."""
    return json.dumps([kind, value], separators=(",", ":"), sort_keys=True)


def as_kind(kind: str, value: Any) -> Any:
    """``value`` as the scalar of ``kind`` it stands for — a whole number sent for a Float is that
    Float (JSON writes 1.0 as 1). Raises ``ValueError`` for a value of another kind."""
    number = isinstance(value, (int, float)) and not isinstance(value, bool)
    if kind == "Float" and number and math.isfinite(value):
        return float(value)
    if kind == "Integer" and number and math.isfinite(value) and float(value).is_integer():
        return int(value)
    if kind == "Boolean" and isinstance(value, bool):
        return value
    if kind == "String" and isinstance(value, str):
        return value
    raise ValueError(f"{json.dumps(value)} is not a {kind}")


def convert_value(value: Any, kind: str) -> Any:
    """``value`` stored as ``kind``, exactly — or ``_FAIL`` when it is not one. Null and objects are
    no kind, and are left as they are.

    * String: text as it is; a boolean as ``true`` / ``false``; a number as its exact digits (a
      decimal as the shortest text that reads back as it: 1.5 → "1.5", 1.0 → "1.0").
    * Integer: a whole number in int64 — an integer, a whole decimal, or text that spells one
      ("42", "+42", "42.0").
    * Float: a decimal; an integer a double holds exactly (past 2^53 it would be rounded); text that
      spells a decimal ("1.5", ".5", "15"). No exponents, hex, inf or nan, as search reads text.
    * Boolean: a boolean, or the text true / false in any case.

    A boolean is never a number, nor a number a boolean."""
    if value is None or isinstance(value, dict):
        return value
    if kind == "String":
        if isinstance(value, bool):
            return "true" if value else "false"
        return repr(value) if isinstance(value, float) else str(value)
    if kind == "Boolean":
        if isinstance(value, bool):
            return value
        word = fold_case(value.strip()) if isinstance(value, str) else None
        return (word == "true") if word in ("true", "false") else _FAIL
    if isinstance(value, bool):
        return _FAIL
    if kind == "Integer":
        if isinstance(value, float):
            n = int(value) if math.isfinite(value) and value.is_integer() else None
        elif isinstance(value, int):
            n = value
        else:
            text = value.strip()
            n = int(text.partition(".")[0]) if _INT_TEXT.fullmatch(text) else None
        return n if n is not None and INT64_MIN <= n <= INT64_MAX else _FAIL
    if isinstance(value, float):
        return value
    try:
        if isinstance(value, int):
            f = float(value)
            return f if int(f) == value else _FAIL
        text = value.strip()
        f = float(text) if _DEC_TEXT.fullmatch(text) else math.nan
    except OverflowError:
        return _FAIL
    return f if math.isfinite(f) else _FAIL


def _dedupe(items: List[Any]) -> List[Any]:
    """A list's elements, each value once (as the catalog tells values apart), in order."""
    seen, out = set(), []
    for item in items:
        slot = _slot(kind_of(item), item)
        if slot not in seen:
            seen.add(slot)
            out.append(item)
    return out


def _strings(one: Callable[[str], str], dedupe: bool = False) -> "Rewrite":
    """``one`` over a string, or over each string element of a list (``dedupe``: then each value
    once); any other value is left as it is."""
    def rewrite(value: Any) -> Tuple[Any, bool]:
        if isinstance(value, str):
            return one(value), False
        if isinstance(value, list):
            out = [one(e) if isinstance(e, str) else e for e in value]
            return (_dedupe(out) if dedupe else out), False
        return value, False
    return rewrite


def _replacer(op: Mapping[str, Any]) -> "Rewrite":
    """``replace``: every ``find`` in the text by ``replaceWith`` — or, ``wholeValue``, a text that
    is ``find`` — in any case unless ``matchCase`` (``fold_case``, as search folds case)."""
    find, to = op["find"], op.get("replaceWith") or ""
    match_case, whole = bool(op.get("matchCase")), bool(op.get("wholeValue"))
    folded = find if match_case else fold_case(find)

    def one(text: str) -> str:
        if whole:
            return to if (text if match_case else fold_case(text)) == folded else text
        if match_case:
            return text.replace(find, to)
        # fold_case keeps every character one character, so a match in the folded text is the
        # same span of the text itself.
        hay, parts, at = fold_case(text), [], 0
        while (i := hay.find(folded, at)) >= 0:
            parts += [text[at:i], to]
            at = i + len(folded)
        return "".join(parts) + text[at:] if parts else text
    return _strings(one)


def _normalizer(op: Mapping[str, Any]) -> "Rewrite":
    """``normalize``: the text trimmed (``trim``), each run of white space one space
    (``collapseSpaces``), in ``lower`` / ``upper`` / ``title`` case (``case``); a list's elements
    so, and each value once (``dedupeList``)."""
    trim, collapse, case = op.get("trim", True), op.get("collapseSpaces"), op.get("case")

    def one(text: str) -> str:
        if trim:
            text = text.strip()
        if collapse:
            text = _SPACES.sub(" ", text)
        if case == "lower":
            text = fold_case(text)
        elif case == "upper":
            text = text.upper()
        elif case == "title":
            text = _WORD.sub(lambda m: m.group()[:1].upper() + fold_case(m.group()[1:]), text)
        return text
    return _strings(one, dedupe=bool(op.get("dedupeList")))


def _mapper(op: Mapping[str, Any]) -> "Rewrite":
    """``mapValues``: each value the map names — exactly, kind and all, as the catalog counts it
    (``fromKind``, else the kind ``from`` is) — becomes its ``to`` (of ``toKind``, else the kind it
    is); in a list, each element, and then each value once (``dedupeList``, on unless turned off).
    Applied once: with a → b and b → c, a becomes b."""
    table: Dict[str, Any] = {}
    for entry in op["map"]:
        kind = entry.get("fromKind") or kind_of(entry["from"])
        table[_slot(kind, as_kind(kind, entry["from"]))] = as_kind(
            entry.get("toKind") or kind_of(entry["to"]), entry["to"])
    dedupe = op.get("dedupeList", True)

    def one(value: Any) -> Any:
        kind = kind_of(value)
        return value if kind in (None, "List") else table.get(_slot(kind, value), value)

    def rewrite(value: Any) -> Tuple[Any, bool]:
        if isinstance(value, list):
            out = [one(e) for e in value]
            return (_dedupe(out) if dedupe else out), False
        return one(value), False
    return rewrite


def _converter(op: Mapping[str, Any]) -> "Rewrite":
    """``convert``: the value stored as ``toKind`` (:func:`convert_value`); a list, element by
    element. A value that does not convert is left as it is (``onFail: skip``) or removed
    (``remove``); a list with one that doesn't is left whole (``skip``), or loses those elements
    (``remove``)."""
    kind, drop = op["toKind"], op.get("onFail") == "remove"

    def rewrite(value: Any) -> Tuple[Any, bool]:
        if isinstance(value, list):
            out = [convert_value(e, kind) for e in value]
            if not any(e is _FAIL for e in out):
                return out, False
            return ([e for e in out if e is not _FAIL] if drop else value), True
        out = convert_value(value, kind)
        if out is _FAIL:
            return (_REMOVE if drop else value), True
        return out, False
    return rewrite


def rewriter(op: Mapping[str, Any]) -> Optional["Rewrite"]:
    """What a clean-up makes of each value — made once for a window; ``None`` for another kind."""
    make = {"replace": _replacer, "normalize": _normalizer, "mapValues": _mapper,
            "convert": _converter}.get(op["kind"])
    return make(op) if make else None


def _cleanup(op: Mapping[str, Any], props: Mapping[str, Any],
             rewrite: "Rewrite") -> Tuple[Optional[Dict[str, Any]], bool]:
    """A clean-up's patch for one entity (or None), and whether its value didn't convert."""
    key = op["key"]
    if key not in props:
        return None, False
    held = props[key]
    value, failed = rewrite(held)
    if value is _REMOVE:
        return {key: PROP_DELETE}, failed
    if _same(held, value):                      # left as it is: never re-stored in another form
        return None, failed
    value = _written(value)
    return (None if _same(held, value) else {key: value}), failed


def unconvertible(op: Mapping[str, Any], props: Mapping[str, Any],
                  rewrite: Optional["Rewrite"] = None) -> bool:
    """A ``convert`` whose entity holds a value that is not of the kind asked for."""
    return op["kind"] == "convert" and _cleanup(op, props, rewrite or rewriter(op))[1]


def is_conflict(op: Mapping[str, Any], props: Mapping[str, Any]) -> bool:
    """A rename or copy that skips an entity because it holds the new key already."""
    return (op["kind"] in ("rename", "copy") and op["key"] in props and op["to"] in props
            and op.get("onConflict", "skip") != "overwrite")


#: How a ``convert``'s kind reads (the catalog's labels).
KIND_LABEL = {"Integer": "Integer", "Float": "Decimal", "String": "Text", "Boolean": "Boolean"}
_KIND_PHRASE = {"Integer": "an integer", "Float": "a decimal", "String": "text",
                "Boolean": "true or false"}


def _quoted(text: str, most: int = 40) -> str:
    return f"“{text if len(text) <= most else text[:most - 1] + '…'}”"


def describe(op: Mapping[str, Any]) -> str:
    """The operation as its commits name it."""
    key, to, kind = op["key"], op.get("to"), op["kind"]
    if kind == "replace":
        return f"Replace {_quoted(op['find'])} → {_quoted(op.get('replaceWith') or '')} in {key}"
    if kind == "normalize":
        parts = [label for on, label in (
            (op.get("trim", True), "trim"), (op.get("collapseSpaces"), "collapse spaces"),
            (op.get("case") == "lower", "lower case"), (op.get("case") == "upper", "UPPER CASE"),
            (op.get("case") == "title", "Title Case"), (op.get("dedupeList"), "each value once"))
            if on]
        return f"Normalize {key}" + (f" ({', '.join(parts)})" if parts else "")
    if kind == "mapValues":
        n = len(op.get("map") or ())
        return f"Merge {n:,} value{'' if n == 1 else 's'} of {key}"
    if kind == "convert":
        return f"Convert {key} to {KIND_LABEL.get(op.get('toKind'), op.get('toKind'))}"
    return {"set": f"Set {key}", "fillEmpty": f"Fill {key} where empty", "remove": f"Remove {key}",
            "rename": f"Rename {key} → {to}", "copy": f"Copy {key} → {to}"}[kind]


def window_message(op: Mapping[str, Any], message: Optional[str], window: int, windows: int) -> str:
    return f"{message or 'Bulk property: ' + describe(op)} ({window}/{windows})"


def window_messages(op: Mapping[str, Any], message: Optional[str], windows: int) -> List[str]:
    """Every window commit's message, as the job names them — how its commits are found."""
    return [window_message(op, message, i, windows) for i in range(1, windows + 1)]


def _audit_op(op: Mapping[str, Any]) -> Dict[str, Any]:
    """The op as an audit lists it: a value past 1 KiB, and a map past its first 50 values, left
    out (``mapSize`` says how many it has) — the label says what it did."""
    out = {k: v for k, v in op.items() if k not in ("value", "map")}
    if "value" in op and len(json.dumps(op["value"], ensure_ascii=False)) <= 1024:
        out["value"] = op["value"]
    if "map" in op:
        out["map"], out["mapSize"] = list(op["map"] or [])[:50], len(op["map"] or [])
    return out


def audit_entry(job: Any, *, partial: bool = False) -> Dict[str, Any]:
    """A bulk property job as a publish lists it (``stats.propertyJobs``): which job, what it did
    (``label``) and to how many entities of the draft (``changed`` — changed in the draft: a later
    edit may have changed some again), what it couldn't write (``refused``), how it ended, who ran it
    and why (``message``), when, and its first and last commit on the draft. ``partial``: a review
    merged in part landed some of what it changed, the rest still on the draft. ``job``: its row."""
    fields = job.field_scope if isinstance(job.field_scope, dict) else {}
    summary = job.summary if isinstance(job.summary, dict) else {}
    op = fields.get("op") if isinstance(fields.get("op"), dict) else {}
    out = {
        "jobId": job.id, "op": _audit_op(op), "label": describe(op) if op else "Bulk property edit",
        "changed": int(summary.get("changed") or 0),
        "refused": int((summary.get("refused") or {}).get("count") or 0),
        "status": job.status, "actor": fields.get("actor"), "message": fields.get("message"),
        "createdAt": job.created_at, "firstCommitId": summary.get("firstCommitId"),
        "lastCommitId": summary.get("lastCommitId"),
    }
    if partial:
        out["partial"] = True
    return out


class Planned(NamedTuple):
    ops: List[Dict[str, Any]]
    counts: Dict[str, int]
    refused: List[Dict[str, Any]]


def plan_window(op: Mapping[str, Any], found: Mapping[str, Tuple[str, Dict[str, Any], Optional[str]]]) -> Planned:
    """A window's update ops, from what its keys found (``key -> (entity id, properties, urn)``):
    one an entity, however many of its keys name it. Pure."""
    ops: List[Dict[str, Any]] = []
    counts = dict.fromkeys(COUNTERS, 0)
    refused: List[Dict[str, Any]] = []
    seen = set()
    rewrite = rewriter(op)
    for key, (eid, props, urn) in found.items():
        if eid in seen:
            counts["unchanged"] += 1
            continue
        seen.add(eid)
        patch, failed = _cleanup(op, props, rewrite) if rewrite else (plan_patch(op, props), False)
        counts["unconvertible"] += failed
        if patch is not None:
            ops.append({"op": "update", "entity_kind": "node", "entity_id": eid,
                        "payload": {"properties": patch}})
            counts["changed"] += 1
        elif is_conflict(op, props):
            counts["conflicts"] += 1
            refused.append(_refused(urn or key, eid, "conflict", f"It already has {op['to']}."))
        elif failed:
            held = json.dumps(props[op["key"]], ensure_ascii=False)
            refused.append(_refused(urn or key, eid, "unconvertible", (
                f"Its {op['key']} holds {held[:120]}, which isn't "
                f"{_KIND_PHRASE.get(op.get('toKind'), op.get('toKind'))}.")))
        else:
            counts["unchanged"] += 1
    return Planned(ops, counts, refused)


def _refused(urn: Optional[str], eid: Optional[str], reason: str, detail: str) -> Dict[str, Any]:
    return {"urn": urn, "entityId": eid, "reason": reason, "detail": detail[:_DETAIL_CHARS]}


# --------------------------------------------------------------------------- #
# Reading a window's entities from the draft                                    #
# --------------------------------------------------------------------------- #
async def read_targets(snap: Snapshot, keys: Iterable[str]):
    """What ``keys`` name in the draft ``snap`` reads: ``key -> (entity id, properties, urn)`` for
    those live there; ``key -> entity id`` for those main holds and the draft deleted; and the keys
    neither holds. A key is an entity's urn or ``gv:<entity id>``; one whose urn the draft changed
    is found by what main calls it."""
    keys = list(dict.fromkeys(k for k in keys if k))
    at = await resolve_placements(snap, keys)
    rest = [k for k in keys if k not in at]
    deleted: Dict[str, str] = {}
    missing: List[str] = []
    if rest and snap.is_draft:
        on_main = await resolve_placements(snap.main_at_base(), rest)
        live = await snap.lookup_live("node", set(on_main.values()))
        for k in rest:
            eid = on_main.get(k)
            if eid is None:
                missing.append(k)
            elif eid in live:
                at[k] = eid
            else:
                deleted[k] = eid
    else:
        missing = rest
    winners = await snap.lookup_live("node", set(at.values()), payload=True)

    def parse() -> Dict[str, Tuple[str, Dict[str, Any], Optional[str]]]:
        out = {}
        for k, eid in at.items():
            w = winners.get(eid)
            if w is None:                       # gone between the two reads
                missing.append(k)
                continue
            payload = json.loads(w.payload) if w.payload else {}
            out[k] = (eid, dict(payload.get("properties") or {}), w.urn)
        return out

    return await asyncio.to_thread(parse), deleted, missing


# --------------------------------------------------------------------------- #
# Chunk files                                                                  #
# --------------------------------------------------------------------------- #
def targets_key(job_id: str, i: int) -> str:
    return storage_key("property-jobs", job_id, "targets", f"{i}.ndjson")


def refused_key(job_id: str, i: int) -> str:
    return storage_key("property-jobs", job_id, "refused", f"{i}.ndjson")


async def _once(data: bytes):
    yield data


async def write_lines(store, key: str, items: Iterable[Any]) -> None:
    await store.put_stream(key, _once(b"".join(json.dumps(x).encode("utf-8") + b"\n" for x in items)))


async def read_lines(store, key: str) -> List[Any]:
    data = b"".join([c async for c in store.open_stream(key)])
    return [json.loads(line) for line in data.split(b"\n") if line.strip()]


async def write_targets(store, job_id: str, keys: Iterable[str], *, start: int = 0) -> int:
    """``keys`` as chunk files from chunk ``start``, ``PROPERTY_JOB_WINDOW`` a file; returns how
    many were written."""
    keys, size, n = list(keys), max(1, config.PROPERTY_JOB_WINDOW), 0
    for at in range(0, len(keys), size):
        await write_lines(store, targets_key(job_id, start + n), keys[at:at + size])
        n += 1
    return n


async def refused_csv(store, job_id: str, chunks: int) -> AsyncIterator[bytes]:
    """A job's refused rows as CSV — urn, entityId, reason, detail — window by window, each cell
    defused against spreadsheet formulas."""
    def rows(items) -> bytes:
        buf = io.StringIO()
        writer = csv.writer(buf, lineterminator="\r\n")
        for item in items:
            writer.writerow(item)
        return buf.getvalue().encode("utf-8")

    yield rows([["urn", "entityId", "reason", "detail"]])
    for i in range(chunks):
        key = refused_key(job_id, i)
        if not (await store.stat(key)).exists:
            continue
        yield rows([[cell(r.get("urn")), cell(r.get("entityId")), cell(r.get("reason")), cell(r.get("detail"))]
                    for r in await read_lines(store, key)])


# --------------------------------------------------------------------------- #
# The worker                                                                   #
# --------------------------------------------------------------------------- #
class PropertyJobStopped(Exception):
    """The job can't go on, for a reason the person can act on (``code``; ``action``, if any)."""

    def __init__(self, message: str, code: str, action: Optional[str] = None):
        super().__init__(message)
        self.code, self.action = code, action


def _tally(summary: Mapping[str, Any], counts: Mapping[str, int], refused: List[Dict[str, Any]],
           commit_id: Optional[str]) -> Dict[str, Any]:
    """The running summary with one window's counts, refused rows and commit added."""
    out = dict(summary)
    for name in COUNTERS:
        out[name] = int(out.get(name) or 0) + counts.get(name, 0)
    report = dict(out.get("refused") or {"count": 0, "byReason": {}, "examples": []})
    by_reason = dict(report.get("byReason") or {})
    for row in refused:
        by_reason[row["reason"]] = by_reason.get(row["reason"], 0) + 1
    examples = list(report.get("examples") or [])
    examples += refused[:max(0, REFUSED_EXAMPLES - len(examples))]
    out["refused"] = {"count": int(report.get("count") or 0) + len(refused), "byReason": by_reason,
                      "examples": examples}
    if commit_id:
        out["commits"] = int(out.get("commits") or 0) + 1
        out["firstCommitId"] = out.get("firstCommitId") or commit_id
        out["lastCommitId"] = commit_id
    return out


class _Position(NamedTuple):
    cursor: Optional[str]
    summary: Dict[str, Any]
    processed: int
    total: int


class PropertyJobWorker:
    """Runs one bulk property job on its lease, from its cursor (see the module docstring).

    ``targets(job)`` — an async iterator of the keys a search target matches (injected at the API
    layer, which runs the search); ``write_context(job)`` — ``{ontology_rules, containment,
    node_identity}`` its windows are written with, as a save is."""

    def __init__(self, versioning, store, *, targets=None, write_context=None) -> None:
        self._svc = versioning
        self._store = store
        self._targets = targets
        self._write_context = write_context
        self._lease: Optional[Lease] = None

    async def run(self, job_id: str, *, lease: Lease) -> Dict[str, Any]:
        """Run the job to the end on ``lease``; returns its summary. Raises :class:`Superseded`
        once it is no longer this worker's (taken over, or cancelled)."""
        self._lease = lease
        job = await self._job(job_id)
        context = (await lease.retry_transient(lambda: self._write_context(job))
                   if self._write_context is not None else {})
        if (await self._position(job_id)).cursor is None:
            await lease.retry_transient(lambda: self._resolve(job_id, job))
        while await lease.retry_transient(lambda: self._next_window(job_id, job, context)):
            pass
        summary = (await self._position(job_id)).summary
        if not await lease.finish("completed", progress=100, summary=summary):
            raise Superseded(f"property job {job_id} (epoch {lease.epoch}) was taken over before it "
                             "could finish")
        return summary

    async def _job(self, job_id: str) -> Dict[str, Any]:
        async with db.graphver_session() as s:
            row = await s.get(JobORM, job_id)
            if row is None:
                raise ValueError(f"unknown property job {job_id}")
            return {**dict(row.field_scope or {}), "jobId": row.id, "graphId": row.graph_id,
                    "branchId": row.branch_id, "workspaceId": row.workspace_id,
                    "dataSourceId": row.data_source_id}

    async def _position(self, job_id: str) -> _Position:
        """Where the job has got, read afresh by every unit of work. Raises :class:`Superseded`
        when the row is no longer this worker's — taken over, or cancelled."""
        async with db.graphver_session() as s:
            row = (await s.execute(select(
                JobORM.last_cursor, JobORM.summary, JobORM.processed, JobORM.total,
                JobORM.retry_count, JobORM.status).where(JobORM.id == job_id))).one()
        if (row.retry_count, row.status) != (self._lease.epoch, "running"):
            raise Superseded(f"property job {job_id} (epoch {self._lease.epoch}) is no longer this "
                             "worker's")
        return _Position(row.last_cursor, dict(row.summary) if isinstance(row.summary, dict) else {},
                         row.processed or 0, row.total or 0)

    async def _resolve(self, job_id: str, job: Dict[str, Any]) -> None:
        """A search target's matches, as chunk files, then ``apply:0``. Run again whole when it
        stops part-way: the files are written over, and the search's export resumes as it is."""
        pos = await self._position(job_id)
        if pos.cursor is not None:
            return
        cap = config.PROPERTY_JOB_MAX_TARGETS
        keys: List[str] = []
        chunks = total = 0
        async for key in self._targets(job):
            keys.append(key)
            total += 1
            if total > cap:
                raise PropertyJobStopped(
                    f"The search matches more than {cap:,} entities, the most one job edits. Narrow "
                    "it, or split the edit into several jobs.", "too_many_targets")
            if len(keys) >= config.PROPERTY_JOB_WINDOW:
                chunks += await write_targets(self._store, job_id, keys, start=chunks)
                keys = []
                self._lease.check()
                async with db.graphver_session() as s:          # a fenced beat: a cancel stops here
                    await self._lease.checkpoint(s, expect_cursor=None, current_phase="resolve",
                                                 processed=total)
        chunks += await write_targets(self._store, job_id, keys, start=chunks)
        async with db.graphver_session() as s:
            await self._lease.checkpoint(s, expect_cursor=None, last_cursor="apply:0", total=total,
                                         processed=0, progress=0, current_phase="apply",
                                         summary={**pos.summary, "chunks": chunks})

    async def _next_window(self, job_id: str, job: Dict[str, Any], context: Dict[str, Any]) -> bool:
        """Write the window after the job's cursor; False once none is left."""
        pos = await self._position(job_id)
        i, chunks = int(pos.cursor.partition(":")[2]), int(pos.summary.get("chunks") or 0)
        if i >= chunks:
            return False
        graph_id, branch_id, op = job["graphId"], job["branchId"], job["op"]
        async with db.graphver_session() as s:
            status = await s.scalar(select(BranchORM.status).where(BranchORM.id == branch_id))
        if status != "open":
            raise self._closed(status, pos)
        keys = await read_lines(self._store, targets_key(job_id, i))
        found, deleted, missing = await read_targets(
            await open_snapshot(graph_id=graph_id, branch_id=branch_id), keys)
        ops, counts, refused = await asyncio.to_thread(plan_window, op, found)
        counts["missing"] += len(missing)
        counts["deletedInDraft"] += len(deleted)
        refused += [_refused(k, eid, "deleted_in_draft", "Deleted in this draft.") for k, eid in deleted.items()]
        refused += [_refused(k, None, "missing", "Not in this draft.") for k in missing]
        message = window_message(op, job.get("message"), i + 1, chunks)
        processed = pos.processed + len(keys)
        started = _now()

        async def on_commit(s) -> None:
            # Recorded with the window, so a window that rolls back leaves no trace in the summary.
            commit_id = await _window_commit(s, graph_id, branch_id, message, started)
            if refused:
                await write_lines(self._store, refused_key(job_id, i), refused)
            else:
                await self._store.delete(refused_key(job_id, i))
            await self._lease.checkpoint(
                s, expect_cursor=pos.cursor, last_cursor=f"apply:{i + 1}", processed=processed,
                summary=_tally(pos.summary, counts, refused, commit_id), current_phase="apply",
                progress=min(99, processed * 100 // pos.total) if pos.total else 0)

        urns = {eid: urn or key for key, (eid, _props, urn) in found.items()}
        try:
            await self._apply(graph_id, branch_id, job["actor"], ops, counts, refused, urns,
                              message, on_commit, context)
        except BranchNotOpen as exc:
            raise self._closed(exc.status, pos) from exc
        return True

    @staticmethod
    def _closed(status: Optional[str], pos: _Position) -> PropertyJobStopped:
        n = int(pos.summary.get("commits") or 0)
        was = {"publishing": "being published"}.get(status or "", status or "closed")
        return PropertyJobStopped(
            f"The draft was {was} while this job ran, so it stopped. "
            f"{n} commit(s) it had written are in the draft's history; the rest was not edited.",
            "draft_closed")

    async def _apply(self, graph_id, branch_id, actor, ops, counts, refused, urns, message,
                     on_commit, context) -> None:
        """Write a window's ``ops`` as one commit with ``on_commit`` (alone when there are none).
        An entity the write gate refuses (:class:`OntologyViolation`) is left out and refused
        (``write_refused``), and the others are written again — up to ``_QUARANTINE_ROUNDS`` times;
        past them, or when a violation names an entity the window doesn't write, the window
        fails (resumable from its cursor)."""
        for attempt in range(_QUARANTINE_ROUNDS + 1):
            if not ops:
                async with db.graphver_session() as s:
                    await on_commit(s)
                return
            try:
                await self._svc.apply_ops(
                    graph_id=graph_id, branch_id=branch_id, ops=ops, actor=actor, message=message,
                    on_commit=on_commit, ontology_rules=context.get("ontology_rules"),
                    containment_edge_types=context.get("containment") or None,
                    node_identity=context.get("node_identity"), exact_types=True)
                return
            except OntologyViolation as exc:
                reasons: Dict[str, List[str]] = {}
                for v in exc.violations or []:
                    reasons.setdefault(v.get("entity_id"), []).append(
                        str(v.get("reason") or v.get("rule") or "refused by the write gate"))
                written = {o["entity_id"] for o in ops}
                if attempt == _QUARANTINE_ROUNDS or not reasons or not set(reasons) <= written:
                    raise
                for o in ops:
                    if o["entity_id"] in reasons:
                        refused.append(_refused(urns.get(o["entity_id"]), o["entity_id"], "write_refused",
                                                "; ".join(reasons[o["entity_id"]])))
                counts["changed"] -= len(reasons)
                ops = [o for o in ops if o["entity_id"] not in reasons]
                logger.info("property job window: %d entit(ies) refused by the write gate, the other "
                            "%d written again", len(reasons), len(ops))


async def _window_commit(s, graph_id: str, branch_id: str, message: str, started: str) -> Optional[str]:
    """The commit this window wrote, in ``s`` (the window's transaction, the draft locked): the
    draft's head, when it is this window's — its message, written since the window began — and
    ``None`` when the window changed nothing."""
    head = (await s.get(BranchORM, branch_id)).head_commit_id
    row = (await s.execute(select(CommitORM.message, CommitORM.created_at).where(
        CommitORM.graph_id == graph_id, CommitORM.id == head))).first() if head else None
    return head if row is not None and row.message == message and row.created_at >= started else None
