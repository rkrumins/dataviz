"""Update progress and time left, for readers and admins: how far the projector is in writing a
graph's next version into the graph store and how fast it goes (``gvprog:<graph id>``), and the
last update that finished (``gvlast:<graph id>``). The projector publishes both, best effort, to
the coordination bus's Redis; they are read only when someone asks (the watermark, sync status, the
admin inventory, a graph's health), never on a read's path.

Publishing (:class:`Update`, one per pass): a pass names its ``phase`` and the version it writes
(``targetSeq``; ``targetVersion`` is the same number, as readers name a version: "Version 42"):

* ``updating`` — a version written into the copy readers read (a window, or a rebuild in place);
* ``building`` — a new version built beside it (a copy, or a seed from the database);
* ``switching`` — the build catching up with the latest version, then readers switched to it;
* ``loading`` — a copy loaded back into memory;
* ``seeding`` — a copy written from nothing (a graph's first).

Where the pass knows how many rows it writes, it says so (``total``) and counts them as they land
(``done``): a window's changes, a paged window's version rows, a full write's differences or live
entities. A pass that resumes one an earlier pass stopped carries its count, its start and its rate
on its cursor. Where it doesn't know (a ``GRAPH.COPY``, the summaries a build carries over), the
phase goes alone: nothing then shows a percentage or a time. The rate (``ratePerSec``) is an
exponentially weighted average of rows a second over about ``TAU_SECS``, measured from the first
rows that land, and published only once it has been measured over ``TRUST_SECS``: younger, it is
too young to trust.

A snapshot is written at most every ``EVERY_SECS`` per graph, the first ``EVERY_SECS`` after the
update starts (a pass that ends sooner writes only its end), kept ``TTL_SECS``, and deleted when
the update ends. An update that publishes records itself as the last one (``LAST_TTL_SECS``):
``finishedAt``, ``durationSecs`` (since it started), ``rows``, ``ratePerSec``, ``seq``, ``phase``.
Writes run in the background, one at a time per graph, the latest state first: a pass never waits
on Redis, and a Redis that fails fails nothing (logged once until a write lands again).

Reading: one round trip each (:func:`read`, :func:`read_many`, :func:`read_health`). The time left
(``etaSecs``) is derived then: ``(total - done) / ratePerSec``, less the snapshot's age. It is null
without a total or a trusted rate, once the snapshot is older than ``STALE_SECS`` (rows stopped
landing, so its rate says nothing any more), and when the sum comes to less than a second.
"""
from __future__ import annotations

import asyncio
import logging
import math
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, Iterable, Mapping, Optional, Tuple

logger = logging.getLogger(__name__)

PHASES = ("updating", "building", "switching", "loading", "seeding")
KEY = "gvprog:"
LAST_KEY = "gvlast:"
TTL_SECS = 600
LAST_TTL_SECS = 30 * 24 * 3600
EVERY_SECS = 2.0
TAU_SECS = 20.0
TRUST_SECS = 10.0
STALE_SECS = 30.0
_WRITE_WAIT_S = 2.0
_READ_WAIT_S = 0.5
#: A graph with a pass running.
_RUNNING = frozenset(("projecting", "rebuilding", "reseeding", "rehydrating"))
#: A graph out of memory, or waiting for room: no pass runs for it.
_OUT = frozenset(("evicted", "waiting_capacity"))

_clock = time.time            # startedAt, updatedAt, finishedAt (patched in tests)
_mono = time.monotonic        # the rate and the limit on writes (patched in tests)

#: Graph id -> when this process last queued a snapshot of it (monotonic).
_last_write: Dict[str, float] = {}
#: Graph id -> the update this process writes for it: an older one writes nothing more.
_owner: Dict[str, "Update"] = {}
#: Graph id -> its next write: the latest replaces one not yet sent.
_queued: Dict[str, Callable[[Any], Awaitable[None]]] = {}
#: Graph id -> the task sending its writes, one at a time.
_writers: Dict[str, "asyncio.Task[None]"] = {}
_told = {"write": False, "read": False}


def _redis():
    """The coordination bus, as the projection's wake-up stream uses it."""
    from .messaging import get_broker_redis

    return get_broker_redis()


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat()


def _epoch(value: Any) -> Optional[float]:
    """Seconds since the epoch from an ISO time or a number; None for none or an unreadable one."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        at = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    return (at if at.tzinfo else at.replace(tzinfo=timezone.utc)).timestamp()


def _text(value: Any) -> str:
    return value.decode() if isinstance(value, bytes) else str(value)


def _number(value: Optional[str], kind: Callable[[str], Any] = int) -> Optional[Any]:
    try:
        return kind(value) if value not in (None, "") else None
    except ValueError:
        return None


class Update:
    """One graph's update as this process writes it: its phase, the version it writes, its rows
    done and to do, and how fast they land. It never waits on Redis, and nothing Redis does reaches
    the pass."""

    __slots__ = ("graph_id", "target_seq", "started_at", "phase", "total", "done", "_rate",
                 "_measured", "_t", "_d", "_flowing", "_timer", "_open")

    def __init__(self, graph_id: str, phase: str, target_seq: int, *, started: Any = None) -> None:
        self.graph_id, self.target_seq = graph_id, int(target_seq or 0)
        self.started_at = _epoch(started) or _clock()
        self._timer: Optional[asyncio.TimerHandle] = None
        self._open = True
        _owner[graph_id] = self
        _last_write[graph_id] = _mono()       # its first snapshot goes EVERY_SECS from now
        self.enter(phase)

    @property
    def open(self) -> bool:
        """Neither held for a pass that resumes it nor finished."""
        return self._open

    @property
    def rate(self) -> Optional[float]:
        """Rows a second, once measured over ``TRUST_SECS``; None before (too young to trust)."""
        return (self._rate if self._rate is not None and self._rate > 0
                and self._measured >= TRUST_SECS else None)

    def enter(self, phase: str) -> None:
        """Move to ``phase``: no rows known in it yet, its rate measured afresh."""
        if phase not in PHASES:
            raise ValueError(f"unknown update phase {phase!r}")
        self.phase, self.total, self.done = phase, None, None
        self._rate, self._measured, self._flowing = None, 0.0, False
        self._t, self._d = _mono(), 0
        self.publish()

    def resume(self, *, started: Any = None, rate: Optional[float] = None) -> None:
        """A pass that takes up an update an earlier pass began: when that one started, and the
        rate it went at (trusted at once)."""
        if _epoch(started) is not None:
            self.started_at = _epoch(started)
        if rate is not None and rate > 0:
            self._rate, self._measured = float(rate), TRUST_SECS

    def count(self, total: int, done: int = 0) -> None:
        """The phase writes ``total`` rows, ``done`` of them already (by the passes before)."""
        self.total, self.done, self._flowing = int(total), int(done), False
        self.publish()

    async def add(self, n: int) -> None:
        """``n`` rows landed (a progress callback: nothing waits)."""
        if self.done is None:
            return                            # a phase that counts no rows
        self.done += int(n)
        if not self._flowing:                 # the rate is measured from the first rows landed
            self._flowing, self._t, self._d = True, _mono(), self.done
        self.publish()

    def publish(self) -> None:
        """Write the snapshot, at most every ``EVERY_SECS`` for the graph: one asked for sooner is
        written when that time comes, as the update then stands, unless it ends first."""
        if not self._open or self._timer is not None:
            return
        wait = _last_write.get(self.graph_id, float("-inf")) + EVERY_SECS - _mono()
        if wait <= 0:
            self._send()
            return
        try:
            self._timer = asyncio.get_running_loop().call_later(wait, self._due)
        except RuntimeError:                  # no loop: nothing could be written
            pass

    def hold(self) -> None:
        """The pass stopped part-way, its cursor written: its snapshot stays, as it stands now,
        for the pass that resumes it."""
        if not self._open:
            return
        self._cancel()
        self._send()
        self._open = False
        self._release()

    def finish(self, *, published: bool, counted: bool = True) -> None:
        """The update ended: its snapshot goes. One that ``published`` a version readers now get
        records itself as the last update: when it finished, how long since it started, and the
        rows it counted with their rate (none for a build, ``counted`` False: a copy counts
        none)."""
        if not self._open:
            return
        self._cancel()
        self._open = False
        if _owner.get(self.graph_id) is not self:
            return
        self._release()
        last = None
        if published:
            now = _clock()
            secs = max(0.0, now - self.started_at)
            # To a tenth under ten seconds, where a tenth says something; to the second above.
            last = {"finishedAt": _iso(now), "durationSecs": f"{secs:.1f}" if secs < 10 else
                    f"{round(secs)}", "seq": str(self.target_seq), "phase": self.phase}
            if counted and self.done is not None:
                last["rows"] = str(self.done)
                if secs > 0:
                    last["ratePerSec"] = f"{self.done / secs:.3f}"
        _send(self.graph_id, _ending(self.graph_id, last))

    def _due(self) -> None:
        self._timer = None
        if self._open:
            self._send()

    def _release(self) -> None:
        """Its graph is no longer this update's to write: what this process holds of it goes."""
        if _owner.get(self.graph_id) is self:
            del _owner[self.graph_id]
            _last_write.pop(self.graph_id, None)

    def _cancel(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None

    def _measure(self) -> None:
        if not self._flowing:
            return
        now = _mono()
        dt = now - self._t
        if dt <= 0:
            return
        sample = (self.done - self._d) / dt
        weight = 1.0 - math.exp(-dt / TAU_SECS)
        self._rate = sample if self._rate is None else self._rate + weight * (sample - self._rate)
        self._measured += dt
        self._t, self._d = now, self.done

    def _send(self) -> None:
        if _owner.get(self.graph_id) is not self:
            return
        self._measure()
        fields = {"phase": self.phase, "unit": "rows", "targetSeq": str(self.target_seq),
                  "targetVersion": str(self.target_seq), "startedAt": _iso(self.started_at),
                  "updatedAt": _iso(_clock())}
        if self.total is not None:
            fields.update(total=str(self.total), done=str(self.done or 0))
        if self.rate is not None:
            fields["ratePerSec"] = f"{self.rate:.3f}"
        _last_write[self.graph_id] = _mono()
        _send(self.graph_id, _snapshot(self.graph_id, fields))


class _Nothing:
    """No update: what code outside a pass's update reports to (the default). It keeps nothing."""

    graph_id = phase = started_at = total = done = rate = None
    target_seq, open = 0, False

    def __setattr__(self, name: str, value: Any) -> None:
        pass

    def enter(self, phase: str) -> None:
        pass

    def resume(self, **_kw: Any) -> None:
        pass

    def count(self, total: int, done: int = 0) -> None:
        pass

    async def add(self, n: int) -> None:
        pass

    def hold(self) -> None:
        pass

    def finish(self, **_kw: Any) -> None:
        pass


NOTHING = _Nothing()


def _snapshot(graph_id: str, fields: Dict[str, str]) -> Callable[[Any], Awaitable[None]]:
    async def write(r) -> None:
        key = KEY + graph_id
        pipe = r.pipeline(transaction=True)
        pipe.delete(key)                      # a field the update no longer has goes with it
        pipe.hset(key, mapping=fields)
        pipe.expire(key, TTL_SECS)
        await pipe.execute()
    return write


def _ending(graph_id: str, last: Optional[Dict[str, str]]) -> Callable[[Any], Awaitable[None]]:
    async def write(r) -> None:
        pipe = r.pipeline(transaction=True)
        pipe.delete(KEY + graph_id)
        if last is not None:
            pipe.delete(LAST_KEY + graph_id)
            pipe.hset(LAST_KEY + graph_id, mapping=last)
            pipe.expire(LAST_KEY + graph_id, LAST_TTL_SECS)
        await pipe.execute()
    return write


def _send(graph_id: str, write: Callable[[Any], Awaitable[None]]) -> None:
    """Queue ``write`` as the graph's next, replacing one not yet sent, for its writer task."""
    _queued[graph_id] = write
    task = _writers.get(graph_id)
    if task is not None and not task.done():
        return                                # its writer sends it next
    try:
        task = asyncio.get_running_loop().create_task(_drain(graph_id))
    except RuntimeError:                      # no loop: nothing can be written
        _queued.pop(graph_id, None)
        return
    _writers[graph_id] = task
    task.add_done_callback(lambda t: _writers.pop(graph_id, None) if _writers.get(graph_id) is t
                           else None)


async def _drain(graph_id: str) -> None:
    while (write := _queued.pop(graph_id, None)) is not None:
        try:
            await asyncio.wait_for(write(_redis()), timeout=_WRITE_WAIT_S)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — best effort: the pass never hears of it
            if not _told["write"]:
                _told["write"] = True
                logger.warning("update progress: Redis took no write (graph %s); readers see no "
                               "progress until one lands: %s", graph_id, exc)
        else:
            _told["write"] = False


# ── reading ─────────────────────────────────────────────────────────────────────────────────────

def in_flight(*, status: Optional[str], behind: bool, building: bool) -> bool:
    """Whether an update may be in flight, so its progress is worth a read: a build beside, or,
    for a graph in memory, a pass running or a version not yet written."""
    return building or (status not in _OUT and (status in _RUNNING or behind))


def view(fields: Optional[Mapping[Any, Any]], *, now: Optional[float] = None
         ) -> Optional[Dict[str, Any]]:
    """The API's ``progress`` from a snapshot as read, None for none: ``{phase, done, total, unit,
    ratePerSec, etaSecs, startedAt, updatedAt, targetSeq, targetVersion}``. ``done`` and ``total``
    are null where the phase counts no rows; ``ratePerSec`` and ``etaSecs`` once the snapshot is
    stale (``STALE_SECS``) or the rate untrusted, and ``etaSecs`` also when less than a second is
    left or every row is written."""
    f = {_text(k): _text(v) for k, v in (fields or {}).items()}
    if f.get("phase") not in PHASES:
        return None
    now = _clock() if now is None else now
    total, done = _number(f.get("total")), _number(f.get("done"))
    updated = _epoch(f.get("updatedAt"))
    age = None if updated is None else max(0.0, now - updated)
    rate = _number(f.get("ratePerSec"), float)
    if age is None or age > STALE_SECS or not rate or rate <= 0:
        rate = None
    eta = None
    if rate is not None and total is not None and done is not None and done < total:
        left = (total - done) / rate - age
        eta = math.ceil(left) if left >= 1 else None
    seq = _number(f.get("targetSeq"))
    return {"phase": f["phase"], "done": done if total is not None else None, "total": total,
            "unit": f.get("unit") or "rows",
            "ratePerSec": round(rate, 1) if rate is not None else None, "etaSecs": eta,
            "startedAt": f.get("startedAt"), "updatedAt": f.get("updatedAt"),
            "targetSeq": seq, "targetVersion": _number(f.get("targetVersion"))}


def _failed_read(what: str, exc: BaseException) -> None:
    if not _told["read"]:
        _told["read"] = True
        logger.warning("update progress: %s could not be read from Redis; shown as none until it "
                       "can: %s", what, exc)


async def read(graph_id: str) -> Optional[Dict[str, Any]]:
    """The graph's update in flight (:func:`view`), None for none. Raises when Redis can't be
    read."""
    got = await asyncio.wait_for(_redis().hgetall(KEY + graph_id), timeout=_READ_WAIT_S)
    _told["read"] = False
    return view(got)


async def read_many(graph_ids: Iterable[str]) -> Dict[str, Optional[Dict[str, Any]]]:
    """Each graph's update in flight, in one pipelined round trip: ``{graph id: progress or
    None}``. Raises when Redis can't be read."""
    ids = list(dict.fromkeys(graph_ids))
    if not ids:
        return {}
    pipe = _redis().pipeline(transaction=False)
    for gid in ids:
        pipe.hgetall(KEY + gid)
    got = await asyncio.wait_for(pipe.execute(), timeout=_READ_WAIT_S)
    _told["read"] = False
    now = _clock()
    return {gid: view(fields, now=now) for gid, fields in zip(ids, got, strict=True)}


async def for_watermark(graph_id: str, wm: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    """``progress`` for ``graph_id``'s watermark (``projection_watermark``'s answer): a fork's is
    its root's, whose store it reads. None, without asking Redis, while no update can be in flight
    (:func:`in_flight`); None too, logged once, while Redis can't be read."""
    if not in_flight(status=wm.get("status"), behind=wm.get("fresh") is False,
                     building=bool(wm.get("candidate"))):
        return None
    try:
        return await read(wm.get("reads_through") or graph_id)
    except Exception as exc:  # noqa: BLE001 — progress is best effort
        _failed_read("progress", exc)
        return None


NOT_RECORDED = ("Not recorded: none has finished since updates began to be recorded, or its "
                "record was lost or passed the 30 days it is kept.")
OLDER_RECORD = "Not recorded: the record kept is of an earlier update than the last one."
UNCHECKED = ("Can't be told: which version it is at can't be read right now, so the record kept "
             "can't be checked against it.")


def last_update(fields: Optional[Mapping[Any, Any]], wm: Optional[Mapping[str, Any]]
                ) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """The last update that finished, as recorded (``{finishedAt, durationSecs, rows,
    ratePerSec}``), checked against the watermark ``wm``: it must be the update its last publish
    came from (finished no earlier than ``last_projected_at``, and, while the copy holds a
    version, at the version it holds). Else ``(None, why)``: never an older one, nor one that
    can't be checked (no ``wm``)."""
    f = {_text(k): _text(v) for k, v in (fields or {}).items()}
    finished = _epoch(f.get("finishedAt"))
    if finished is None:
        return None, NOT_RECORDED
    if wm is None:
        return None, UNCHECKED
    published = _epoch(wm.get("last_projected_at"))
    projected = int(wm.get("projected") or 0)
    if published is None or finished < published or (
            projected and _number(f.get("seq")) != projected):
        return None, OLDER_RECORD
    return {"finishedAt": f["finishedAt"], "durationSecs": _number(f.get("durationSecs"), float),
            "rows": _number(f.get("rows")),
            "ratePerSec": _number(f.get("ratePerSec"), float)}, None


async def read_health(graph_id: str, wm: Optional[Mapping[str, Any]]
                      ) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]], Optional[str]]:
    """For a graph's health, in one round trip: its update in flight (:func:`view`), its last
    update (:func:`last_update`, against its watermark ``wm``) and, when that is None, why. Raises
    when Redis can't be read."""
    pipe = _redis().pipeline(transaction=False)
    pipe.hgetall(KEY + graph_id)
    pipe.hgetall(LAST_KEY + graph_id)
    snapshot, record = await asyncio.wait_for(pipe.execute(), timeout=_READ_WAIT_S)
    _told["read"] = False
    last, why = last_update(record, wm)
    return view(snapshot), last, why


def reset() -> None:
    """Forget what this process holds and logged (tests)."""
    for update in list(_owner.values()):
        update._cancel()
    _owner.clear()
    _last_write.clear()
    _queued.clear()
    _writers.clear()
    _told.update(write=False, read=False)
