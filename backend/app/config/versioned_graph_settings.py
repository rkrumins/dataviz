"""Every versioned-graph and loading setting, described once: its facts and the words that explain it.

The API (``GET /api/v1/settings/versioned-graphs/schema``), the app's catalogue
(``frontend/src/generated/versionedGraphSettings.json``) and the guide
(``docs/guide/VERSIONED_GRAPH_SETTINGS.md``) are all generated from this module, so a setting is
explained in one place, and the explanation is checked against the code that reads it
(``tests/test_settings_registry.py``). The shape is ``settings_types``; the store owns the values.

    WRITING HERE
    ------------
    Every word below is UI copy. Plain, short, concrete sentences, one name per concept: the graph
    store and the database; a copy (never a "key"); a platform copy or a connected graph; updating,
    loading and unloading; a new-version build and a switch; Always, Standard and Coldline. The
    engineering words (FalkorDB, Postgres, GRAPH.COPY, watermark, projection) belong only in a
    term's ``technical`` note and in ``evidence``. Say only what the code does; each ``evidence``
    names where it does it, and the measured numbers where there are some.

    EFFECTS
    -------
    For a number, ``up`` is raising it; for a switch, turning it on; for a choice (and an
    identifier), ``up`` names the choices that do better on that dimension. ``up_verdict`` says
    whether ``up`` is the better side, so the app can draw the trade without reading the words.

    RULES
    -----
    ``Rule(op, other, margin)``: ``<=`` means this <= other - margin, ``>=`` this >= other + margin.

Standard library and ``settings_types`` only, so CI's guard job imports it with nothing installed.
"""
from __future__ import annotations

from typing import Any, Mapping, Optional, Tuple

from backend.app.config.settings_types import (
    Cap,
    Category,
    Choice,
    Default,
    DeploymentFact,
    Effect,
    Frame,
    Guidance,
    Legacy,
    Profile,
    Recommendation,
    Requirement,
    Retired,
    Rule,
    Setting,
    Signal,
    Term,
    Why,
    schema,
)

DOMAIN = "versioned-graphs"

# ---------------------------------------------------------------------------------------------
# Words for values
# ---------------------------------------------------------------------------------------------

_GB = 1 << 30


def _v(values: Optional[Mapping[str, Any]], key: str) -> Any:
    """``values[key]``, else the setting's code default."""
    if values is not None and key in values:
        return values[key]
    return BY_KEY[key].default.code


def _dur(secs: Any) -> str:
    """604800 → '7 days', 900 → '15 minutes', 90 → '90 seconds'."""
    secs = int(secs)
    for unit, size in (("day", 86_400), ("hour", 3_600), ("minute", 60)):
        if secs >= size and secs % size == 0:
            n = secs // size
            return f"{n:,} {unit}{'' if n == 1 else 's'}"
    return f"{secs:,} second{'' if secs == 1 else 's'}"


def _ms(ms: Any) -> str:
    """15000 → '15 seconds', 500 → '500 ms'."""
    ms = int(ms)
    return _dur(ms // 1000) if ms >= 1000 and ms % 1000 == 0 else f"{ms:,} ms"


def _size(n: Any) -> str:
    """Bytes as the graph store reports them: 1288490188 → '1.2 GB'."""
    n = int(n)
    for unit, size in (("TB", 1 << 40), ("GB", 1 << 30), ("MB", 1 << 20), ("KB", 1 << 10)):
        if abs(n) >= size:
            return f"{n / size:.1f}".removesuffix(".0") + f" {unit}"
    return f"{n:,} bytes"


def _share(x: Any) -> str:
    """0.05 → '5%', 0.125 → '12.5%'."""
    return f"{float(x) * 100:g}%"


def _days(v: Any) -> str:
    return "for good" if v == "forever" else f"{int(v):,} day{'' if int(v) == 1 else 's'}"


def _title(key: str, choice_id: Any) -> str:
    return next((c.title for c in BY_KEY[key].choices if c.id == choice_id), str(choice_id))


def _facts(facts: Optional[Mapping[str, Any]], *names: str) -> Optional[Tuple[Any, ...]]:
    """The named live facts, or None when any is missing: a recommendation from a fact it doesn't
    have would be a guess."""
    if not facts:
        return None
    got = tuple(facts.get(name) for name in names)
    return None if any(g is None for g in got) else got


def _limited(nodes: Any) -> list:
    """The nodes that set a memory limit and report their use: the only ones room is measured on."""
    return [n for n in nodes or () if isinstance(n, Mapping) and n.get("maxBytes")
            and n.get("usedBytes") is not None]


def _node_name(node: Mapping[str, Any]) -> str:
    return str(node.get("name") or "a node")


def _roomiest(nodes: Any, start_pct: int) -> Optional[Tuple[str, int, int]]:
    """(name, bytes free under the start mark, its limit) of the node with the most room."""
    best = None
    for n in _limited(nodes):
        free = int(n["maxBytes"]) * int(start_pct) // 100 - int(n["usedBytes"])
        if best is None or free > best[1]:
            best = (_node_name(n), free, int(n["maxBytes"]))
    return best


# ---------------------------------------------------------------------------------------------
# Who sets what, and what a setting needs
# ---------------------------------------------------------------------------------------------

_P = {"platform": "system_admin"}
_PW = {"platform": "system_admin", "workspace": "workspace_admin"}
_PWG = {"platform": "system_admin", "workspace": "workspace_admin", "graph": "workspace_admin"}
_PWG_SYSTEM = {"platform": "system_admin", "workspace": "system_admin", "graph": "system_admin"}

_BUILDS_ON = (Requirement(feature="candidateKeysEnabled", why="switch_off"),)
_RESIDENCY_ON = (Requirement(feature="residencyEnabled", why="switch_off"),)
_GUARD_ON = (Requirement(setting="imports.replaceGuard", one_of=(True,), why="guard_off"),)

_NEXT_READ = ("next_read", "The next read of each graph. A save reaches every process within seconds.")
_NEXT_WRITE = ("next_write", "The next write, once the worker reads its settings again, which it does "
                             "as it updates each graph.")
_ROOM_ASKED = ("build_start", "The next time a build asks for room: a waiting build asks every "
                              "minute. A build already copying or catching up carries on.")
_NEXT_IMPORT = ("next_import", "Imports started after the change. An import already running keeps "
                               "the settings it started with.")


# ---------------------------------------------------------------------------------------------
# Recommendations from live facts
# ---------------------------------------------------------------------------------------------

def _rec_copy_room(values, facts):
    got = _facts(facts, "largestGraphBytes", "nodes")
    room = _roomiest(got[1], _v(values, "residency.unloadStartPct")) if got else None
    if room is None or not got[0]:
        return None
    largest, (name, free, _limit) = int(got[0]), room
    need = largest * 220 // 100
    if need <= free:
        return 220, (f"A copy of your largest graph ({_size(largest)}) needs {_size(need)} free at "
                     f"220%; {name} has {_size(free)} under its start mark, so it fits.")
    then = {"copy": "With Copy only, builds of it wait for room.",
            "reseed": "Its builds come from the database anyway (From the database only)."}.get(
        _v(values, "builds.method"),
        "With Auto, its builds come from the database instead, which needs about half the memory.")
    return 220, (f"Your largest graph ({_size(largest)}) needs {_size(need)} free to copy; your "
                 f"roomiest node, {name}, has {_size(max(free, 0))} under its start mark. Keep 220%: "
                 f"a copy was measured at 2.0 times the graph's memory at its peak. {then}")


def _rec_copy_max(values, facts):
    got = _facts(facts, "largestGraphBytes", "nodes")
    room = _roomiest(got[1], _v(values, "residency.unloadStartPct")) if got else None
    if room is None or not got[0]:
        return None
    largest, (name, free, _limit) = int(got[0]), room
    pct = int(_v(values, "builds.copyRoomPct"))
    need = largest * pct // 100
    if need <= free:
        return "unlimited", (f"No limit is needed: a copy of your largest graph ({_size(largest)}) "
                             f"needs {_size(need)}, and {name} has {_size(free)} free under its "
                             f"start mark.")
    cap = max(free, 0) * 100 // pct
    if cap < 1 << 20:
        return "unlimited", ("No node has room for a copy now, so no limit would change anything: "
                             "builds come from the database (Auto) or wait (Copy only) until a node "
                             "has room.")
    cap -= cap % ((1 << 26) if cap >= _GB else (1 << 20))
    return cap, (f"Your roomiest node, {name}, has {_size(free)} free under its start mark: enough "
                 f"to copy graphs up to {_size(cap)} at {pct}%. A copy of your largest graph "
                 f"({_size(largest)}) needs {_size(need)}. A limit of {_size(cap)} builds larger "
                 f"graphs from the database from the start, which needs about half the memory.")


def _rec_per_worker(values, facts):
    got = _facts(facts, "projectionConcurrency")
    if got is None:
        return None
    workers_graphs = max(1, int(got[0]))
    rec = min(2, workers_graphs)
    why = (f"Each worker updates {workers_graphs} graphs at once, and builds count among them; "
           f"{rec} at a time keeps big changes moving without taking every turn."
           if rec < workers_graphs else
           f"Each worker updates only {workers_graphs} graph{'s' if workers_graphs > 1 else ''} at "
           f"once, so builds can't run more than that.")
    nodes, largest = (facts or {}).get("nodes"), (facts or {}).get("largestGraphBytes")
    need = int(largest) * int(_v(values, "builds.copyRoomPct")) // 100 if largest else 0
    if need and _limited(nodes):
        start = int(_v(values, "residency.unloadStartPct"))
        fits = sum(max(0, int(n["maxBytes"]) * start // 100 - int(n["usedBytes"])) // need
                   for n in _limited(nodes))
        why += (" No node has room to copy your largest graph now, so its builds are made from "
                "the database or wait." if fits == 0 else
                f" The graph store has room for {fits} cop{'y' if fits == 1 else 'ies'} of your "
                f"largest graph at once now; more builds wait for room.")
    return rec, why


def _rec_start(values, facts):
    got = _facts(facts, "nodes", "largestGraphBytes")
    limited = _limited(got[0]) if got else []
    if not limited:
        return None
    fullest = max(limited, key=lambda n: int(n["usedBytes"]) / int(n["maxBytes"]))
    used, limit = int(fullest["usedBytes"]), int(fullest["maxBytes"])
    mark = limit * 80 // 100
    now = round(100 * used / limit)
    state = (f"{_node_name(fullest)}, your fullest node, is at {now}%: past the mark, so graphs "
             f"there are being unloaded." if used >= mark else
             f"{_node_name(fullest)}, your fullest node, is at {now}%, with {_size(mark - used)} "
             f"left under the mark for loads and copies.")
    load = int(got[1]) * int(_v(values, "residency.loadMarginPct")) // 100
    if load > max(int(n["maxBytes"]) for n in limited) * 80 // 100:
        fit = (f" A load of your largest graph asks for {_size(load)}, more than 80% of any node, "
               f"so it can't load: add memory, or make that graph Coldline.")
    else:
        fit = f" A load of your largest graph asks for {_size(load)}."
    return 80, f"At 80%, {_node_name(fullest)} starts unloading at {_size(mark)} used. {state}{fit}"


def _rec_stop(values, facts):
    got = _facts(facts, "nodes", "largestGraphBytes")
    limited = _limited(got[0]) if got else []
    if not limited:
        return None
    start = int(_v(values, "residency.unloadStartPct"))
    smallest = min(limited, key=lambda n: int(n["maxBytes"]))
    limit, name = int(smallest["maxBytes"]), _node_name(smallest)
    load = int(got[1]) * int(_v(values, "residency.loadMarginPct")) // 100
    gap = -(-load * 100 // limit)
    if gap > 20:
        stop = min(start - 5, max(30, start - 10))
        return stop, (f"A load of your largest graph ({_size(load)}) takes {gap} points of {name}'s "
                      f"memory ({_size(limit)}): freeing that much every round would unload graphs "
                      f"people use. Keep {stop}%; a load of it makes room as it needs, unloading the "
                      f"graphs read longest ago.")
    stop = min(start - 5, max(30, start - max(10, gap)))
    return stop, (f"{stop}% leaves {start - stop} points free under the start mark after "
                  f"unloading: {_size(limit * (start - stop) // 100)} on {name}, your smallest "
                  f"node, room for a load of your largest graph ({_size(load)}).")


def _rec_reads_process(values, facts):
    got = _facts(facts, "poolSize")
    if got is None:
        return None
    pool = int(got[0])
    rec = max(1, min(64, pool - 2))
    why = (f"Each process keeps {pool} database connections for versioned graphs; {rec} reads at "
           f"once leave {max(0, pool - rec)} for writes and other work.")
    procs = (facts or {}).get("readerProcesses")
    if procs:
        why += f" Across your {procs} processes, that is up to {rec * int(procs)} reads at once."
    return rec, why


def _rec_reads_graph(values, facts):
    got = _facts(facts, "poolSize")
    if got is None:
        return None
    per_process = max(1, min(int(_v(values, "database.readsPerProcess")), int(got[0]) - 2))
    rec = max(1, per_process // 2)
    why = (f"Half of the {per_process} reads each process runs from the database: one graph takes "
           f"at most half, and other graphs keep the rest.")
    procs = (facts or {}).get("readerProcesses")
    if procs:
        why += (f" Across your {procs} processes, one graph can have up to {rec * int(procs)} "
                f"reads on the database at once.")
    return rec, why


# ---------------------------------------------------------------------------------------------
# Examples, rendered with the values in force
# ---------------------------------------------------------------------------------------------

def _ex_read_mode(values, facts):
    mode = _v(values, "reads.mode")
    if mode == "in_place":
        return ("With Keep serving, update in place, an import of 100,000 changes appears a batch "
                "at a time while reads stay on the graph store, fast; once it is all written, "
                "every view shows the new version.")
    if mode == "beside":
        return (f"With Keep serving, switch when ready, a publish of more than "
                f"{_v(values, 'builds.aboveRows'):,} changes is built in a second copy while "
                f"readers keep the current version, then everyone switches at once. Smaller ones "
                f"are written in place.")
    return ("With Always the latest, an import of 100,000 changes shows the moment it is "
            "published, read from the database until the graph store has it: slower on a large "
            "graph, and without lineage summaries meanwhile.")


def _ex_max_behind(values, facts):
    lag = _v(values, "reads.maxVersionsBehind")
    if lag == "unlimited":
        return ("A graph set to update in place keeps serving its copy, however many versions it "
                "falls behind, until it catches up.")
    if int(lag) == 0:
        return ("A graph set to update in place sends its readers to the database whenever its "
                "copy is behind, as Always the latest does.")
    return (f"A graph set to update in place serves its copy while it is up to {int(lag):,} "
            f"version{'s' if int(lag) != 1 else ''} behind; further behind, its readers go to the "
            f"database until it catches up.")


def _ex_pacing(values, facts):
    target, ratio = int(_v(values, "updates.statementTargetMs")), float(_v(values, "updates.pacingRatio"))
    if ratio == 0:
        return ("With no pause, writes follow one another; the worker pauses only while reads on "
                "the node are waiting (Pause while reads wait).")
    pause = min(5000, round(target * ratio))
    return (f"A write that takes {target:,} ms is followed by a {pause:,} ms pause, so reads on that "
            f"node get about {round(100 * pause / (target + pause))}% of its time while a graph "
            f"updates.")


def _ex_pressure(values, facts):
    target = int(_v(values, "updates.statementTargetMs"))
    ratio, usual = float(_v(values, "updates.readPressureRatio")), float(_v(values, "updates.pacingRatio"))
    if ratio <= usual:
        return (f"At {ratio:g}, no longer than the usual pause ({usual:g}), so waiting reads get no "
                f"extra time.")
    pause = min(5000, round(target * ratio))
    return (f"While reads on a node are waiting, a write that takes {target:,} ms is followed by a "
            f"{pause:,} ms pause: reads get about {round(100 * pause / (target + pause))}% of the "
            f"node's time until they catch up.")


def _ex_method(values, facts):
    pct = _v(values, "builds.copyRoomPct")
    return {
        "copy": (f"Copy only: a build waits until the current copy's node has {pct}% of the graph's "
                 f"size free, then copies it."),
        "reseed": ("From the database only: every build reads the graph from the database into a "
                   "new copy, on the node with the most room."),
    }.get(_v(values, "builds.method"),
          f"Auto: a build copies the current copy when its node has {pct}% of the graph's size "
          f"free, else builds it from the database on the node with the most room.")


def _ex_copy_room(values, facts):
    pct = int(_v(values, "builds.copyRoomPct"))
    largest = (facts or {}).get("largestGraphBytes")
    if largest:
        return (f"A copy of your largest graph, {_size(largest)}, needs "
                f"{_size(int(largest) * pct // 100)} free on its node, under the node's start mark.")
    return (f"A copy of a 2 GB graph needs {_size(2 * _GB * pct // 100)} free on its node, under "
            f"the node's start mark.")


def _ex_copy_max(values, facts):
    cap = _v(values, "builds.copyMaxBytes")
    if cap == "unlimited":
        return "Any graph may be copied once its node has room."
    return (f"Graphs over {_size(cap)} are never copied: Auto builds them from the database, and "
            f"Copy only waits.")


def _ex_no_room(values, facts):
    if _v(values, "builds.noRoom") == "in_place":
        return ("With no room, the build is dropped and the change is written in place, so readers "
                "may see it partly applied.")
    return (f"With no room, a build waits, asking again every minute, while readers keep the "
            f"current version; after {_dur(_v(values, 'builds.noRoomAlertSecs'))} it raises an "
            f"alert.")


def _ex_per_worker(values, facts):
    n = _v(values, "builds.perWorker")
    pc = (facts or {}).get("projectionConcurrency")
    if pc:
        return (f"Each worker runs up to {min(int(n), int(pc))} builds at once, among the {pc} "
                f"graphs it updates at once; more builds wait their turn.")
    return f"Each worker runs up to {n} builds at once; more wait their turn."


def _ex_class(values, facts):
    cls = _v(values, "residency.class")
    if cls == "always":
        return ("An Always graph is never unloaded; if it isn't in memory, it loads as soon as there "
                "is room.")
    if cls == "coldline":
        return (f"A Coldline graph is unloaded after {_dur(_v(values, 'residency.coldlineIdleSecs'))} "
                f"unread. It loads again only when a canvas opens it with more than "
                f"{_v(values, 'residency.coldlineLoadAbove'):,} items, or a search needs it.")
    return (f"A Standard graph nobody reads for {_dur(_v(values, 'residency.standardIdleSecs'))} is "
            f"unloaded; its next read comes from the database and loads it again.")


def _ex_auto_unload(values, facts):
    if not _v(values, "residency.autoUnload"):
        return "Nothing is unloaded; graphs not in memory load only where there is room."
    return (f"Standard graphs unread for {_dur(_v(values, 'residency.standardIdleSecs'))} and "
            f"Coldline graphs unread for {_dur(_v(values, 'residency.coldlineIdleSecs'))} are "
            f"unloaded, and a node past {_v(values, 'residency.unloadStartPct')}% of its memory "
            f"unloads graphs until it is at {_v(values, 'residency.unloadStopPct')}%.")


def _ex_start(values, facts):
    start = int(_v(values, "residency.unloadStartPct"))
    limited = _limited((facts or {}).get("nodes"))
    if limited:
        node = limited[0]
        return (f"{_node_name(node)} ({_size(node['maxBytes'])}) starts unloading graphs at "
                f"{_size(int(node['maxBytes']) * start // 100)} used; a load or a copy must fit "
                f"under that.")
    return (f"On a 16 GB node, graphs start to unload at {_size(16 * _GB * start // 100)} used, and "
            f"a load or a copy must fit under that.")


def _ex_identifier(values, facts):
    ident = str(_v(values, "imports.identifier"))
    if ident == "urn":
        return "Rows find existing items by their id or their URN, and nothing else."
    if ident.startswith("prop."):
        name = ident[len("prop."):].removesuffix(",urn")
        if ident.endswith(",urn"):
            return (f"Rows find existing items by their value of {name}, else by their URN; an item "
                    f"found by its URN takes the value.")
        return f"Rows find existing items by their id, else by their value of {name}."
    return ("Rows find existing items by their id, then their URN, their identifier property, a "
            "field their type is matched by, or a unique qualified name.")


def _ex_guard(values, facts):
    if not _v(values, "imports.replaceGuard"):
        return "A replace deletes whatever its file leaves out, however much that is."
    return (f"A replace of {_v(values, 'imports.guardMinLive'):,} items or more that would delete "
            f"{_share(_v(values, 'imports.guardDeleteShare'))} of them and make "
            f"{_share(_v(values, 'imports.guardCreateShare'))} as many again is stopped before it "
            f"deletes anything.")


def _ex_refused(values, facts):
    budget = str(_v(values, "imports.maxRefusedRows"))
    if budget == "0":
        return ("An import with any refused row holds: a replace deletes nothing, and an import set "
                "to publish itself waits for review.")
    if budget == "unlimited":
        return "Imports go on whatever is refused; each refused row is reported, with why."
    allowed = f"{budget} of a file's rows" if budget.endswith("%") else f"{int(budget):,} rows"
    return f"Up to {allowed} may be refused; past that, the import holds."


# ---------------------------------------------------------------------------------------------
# Posture: one sentence for a category, from the values in force and the feature switches
# ---------------------------------------------------------------------------------------------

def _posture_reads(values, switches):
    mode = _v(values, "reads.mode")
    if mode == "latest":
        return ("Readers get Always the latest: the newest version as soon as it is published, read "
                "from the database while the graph store catches up.")
    lag = _v(values, "reads.maxVersionsBehind")
    behind = "" if lag == "unlimited" else f", up to {lag} versions behind"
    if mode == "in_place":
        return (f"Readers get Keep serving, update in place: they stay on the graph store while a "
                f"new version is written into it{behind}, and may see part of it before the rest.")
    sentence = (f"Readers get Keep serving, switch when ready: a publish of more than "
                f"{_v(values, 'builds.aboveRows'):,} changes is built in a second copy and switched "
                f"to; smaller ones are written in place.")
    if (switches or {}).get("candidateKeysEnabled") is False:
        sentence += " New-version builds is off, so until it is on, graphs update in place."
    return sentence


def _posture_updates(values, switches):
    return (f"Each write to the graph store aims at {_v(values, 'updates.statementTargetMs'):,} ms "
            f"and stops at {_dur(_v(values, 'updates.writeCeilingSecs'))}; after it, the worker "
            f"pauses {_share(_v(values, 'updates.pacingRatio'))} of the write's time, or "
            f"{_share(_v(values, 'updates.readPressureRatio'))} while reads wait. A previous copy "
            f"is kept {_dur(_v(values, 'updates.retireGraceSecs'))} after a switch or a move.")


def _posture_builds(values, switches):
    method = {"auto": "copied when there's room, else from the database", "copy": "always copied",
              "reseed": "always from the database"}[_v(values, "builds.method")]
    what = (f"publishes of more than {_v(values, 'builds.aboveRows'):,} changes to graphs set to "
            f"switch when ready are built in a second copy ({method}), "
            f"{_v(values, 'builds.perWorker')} at a time per worker"
            + (", and so are their rebuilds and moves" if _v(values, "builds.forRebuilds") else ""))
    on = (switches or {}).get("candidateKeysEnabled")
    if on is False:
        return ("New-version builds is off: every change is written in place, and graphs set to "
                "switch when ready update in place.")
    if on is True:
        return f"New-version builds is on: {what}."
    return f"With New-version builds on, {what}."


def _posture_residency(values, switches):
    on = (switches or {}).get("residencyEnabled")
    if on is False:
        return ("Graph residency is off: every graph stays in the graph store, and graphs not in it "
                "are loaded back as memory allows.")
    lead = "Graph residency is on" if on is True else "With Graph residency on"
    cls = _title("residency.class", _v(values, "residency.class"))
    if not _v(values, "residency.autoUnload"):
        return (f"{lead}, graphs are {cls} unless set otherwise, but nothing is unloaded "
                f"automatically: graphs load as memory allows.")
    return (f"{lead}, graphs are {cls} unless set otherwise. Standard graphs unload after "
            f"{_dur(_v(values, 'residency.standardIdleSecs'))} unread and Coldline after "
            f"{_dur(_v(values, 'residency.coldlineIdleSecs'))}; a node unloads graphs from "
            f"{_v(values, 'residency.unloadStartPct')}% of its memory down to "
            f"{_v(values, 'residency.unloadStopPct')}%.")


def _posture_database(values, switches):
    return (f"While a graph is read from the database, each read may run "
            f"{_ms(_v(values, 'database.readTimeoutMs'))}; each process runs "
            f"{_v(values, 'database.readsPerGraph')} reads of one graph at once and "
            f"{_v(values, 'database.readsPerProcess')} in all, and asks the rest to retry.")


def _posture_drafts(values, switches):
    idle, keep = _v(values, "drafts.idleCloseDays"), _v(values, "drafts.keepClosedDays")
    levels = _v(values, "drafts.levels")
    start = levels.removesuffix("_only") if levels != "any" else _v(values, "drafts.defaultVisibility")
    closing = ("Idle drafts are never closed" if idle == "forever"
               else f"Idle drafts close after {_days(idle)}")
    kept = "for good" if keep == "forever" else f"for {_days(keep)}"
    allowed = {"any": "", "public_only": " (public only)", "private_only": " (private only)"}[levels]
    may = {True: "may", False: "may not"}
    return (f"{closing}, and closed drafts keep their changes {kept}. New drafts start {start}"
            f"{allowed}. People {may[bool(_v(values, 'drafts.selfApproval'))]} approve their own "
            f"reviews and {may[bool(_v(values, 'drafts.selfMerge'))]} merge them. Each graph may "
            f"have {_v(values, 'forks.maxPerGraph')} forks, and a deleted data source can be "
            f"restored for {_days(_v(values, 'trash.restoreDays'))}.")


def _posture_imports(values, switches):
    ident = str(_v(values, "imports.identifier"))
    by = ("entity id, then URN and the rest the platform knows items by" if ident == "entity_id"
          else "URN" if ident == "urn" else
          f"the property {ident[len('prop.'):].removesuffix(',urn')}"
          + (", else URN" if ident.endswith(",urn") else ""))
    guard = (f"on: a replace of {_v(values, 'imports.guardMinLive'):,} items or more that would "
             f"delete {_share(_v(values, 'imports.guardDeleteShare'))} and make "
             f"{_share(_v(values, 'imports.guardCreateShare'))} as many again is stopped"
             if _v(values, "imports.replaceGuard") else "off")
    budget = str(_v(values, "imports.maxRefusedRows"))
    refused = ("An import holds on any refused row." if budget == "0" else
               "Imports go on whatever is refused." if budget == "unlimited" else
               f"Imports hold once more than {budget} of a file's rows are refused."
               if budget.endswith("%") else
               f"Imports hold once more than {int(budget):,} rows are refused.")
    return f"Imports match rows by {by}. The replace guard is {guard}. {refused}"


# ---------------------------------------------------------------------------------------------
# Reads & consistency
# ---------------------------------------------------------------------------------------------

_LATEST = Choice(
    id="latest",
    title="Always the latest",
    short="Always the latest",
    promise=("Readers see the newest published version as soon as it is published. Until the graph "
             "store has it, they read it from the database."),
    effects={
        "consistency": ("better", "Always the newest version, whole."),
        "read_speed": ("worse", "Reads during an update come from the database: slower on a large "
                                "graph."),
        "update_speed": ("better", "A new version shows the moment it is published."),
        "availability": ("worse", "Under heavy load, a read from the database may be asked to "
                                  "retry."),
        "database_load": ("worse", "Every read during an update goes to the database."),
        "memory": ("same", "No extra memory."),
    },
    good_for=("The default, and how reads have always worked. Small graphs, and graphs where the "
              "newest data matters more than speed."),
    needs="Database capacity for reads of whole graphs while they update.",
    pros=("The newest version, even mid-update", "Nothing extra to run or watch"),
    cons=("Reads during an update come from the database: slower on large graphs",
          "Lineage summaries are missing until the graph store catches up",
          "Under heavy load a read may be asked to retry"),
    frames=(
        Frame("before", "Version 5", "graph store"),
        Frame("while", "Version 6", "database",
              "The newest version, read from the database: slower, and without lineage summaries"),
        Frame("after", "Version 6", "graph store"),
    ),
    example=("An import changes 100,000 items in a graph of 10 million. Within seconds of the "
             "publish, canvases show version 6, read from the database while the graph store "
             "catches up: large views load slower, lineage summaries are missing until it has, and "
             "under heavy load a read may be asked to retry."),
)

_IN_PLACE = Choice(
    id="in_place",
    title="Keep serving, update in place",
    short="Update in place",
    promise=("Readers stay on the graph store, at full speed, while the next version is written into "
             "the same copy. They may see part of it before the rest."),
    effects={
        "consistency": ("worse", "While a version is written, readers can see part of it."),
        "read_speed": ("better", "Reads stay on the graph store; writes are paced around them."),
        "update_speed": ("better", "Changes show as they are written, as soon as with Always the "
                                   "latest."),
        "availability": ("better", "Every read is served from the graph store."),
        "database_load": ("better", "Reads stay off the database."),
        "memory": ("same", "No extra memory."),
    },
    good_for=("Large graphs whose views must stay fast while big imports land, where a moment of a "
              "partly applied change is fine."),
    needs="Nothing extra.",
    pros=("Reads stay fast throughout", "No extra memory",
          "Lineage summaries stay, moved as each part is written"),
    cons=("During a large update, readers can see some of the new version before the rest of it",
          "If an update fails part way, readers keep the partly updated copy until the retry lands"),
    frames=(
        Frame("before", "Version 5", "graph store"),
        Frame("while", "Version 5, with parts of 6", "graph store",
              "Version 5, with parts of 6 as they are written"),
        Frame("after", "Version 6", "graph store"),
    ),
    example=("An import changes 100,000 items in a graph of 10 million. Canvases stay fast and keep "
             "showing version 5; as version 6 is written, its changes appear a batch at a time; once "
             "it is all in, every view shows version 6."),
)

_BESIDE = Choice(
    id="beside",
    title="Keep serving, switch when ready",
    short="Switch when ready",
    promise=("For a large change, readers keep exactly the version they have while the next one is "
             "built in a second copy, then everyone switches at once. Smaller changes are written "
             "in place."),
    effects={
        "consistency": ("better", "One whole version at a time through a large change."),
        "read_speed": ("better", "Reads stay on the graph store; nothing writes the copy readers "
                                 "use during a build."),
        "update_speed": ("worse", "A large change shows only once it is built and checked: later "
                                  "than in place."),
        "availability": ("better", "Every read is served from the graph store."),
        "memory": ("worse", "Room for a second copy while a build runs: up to about twice the "
                            "graph's size."),
        "cost": ("worse", "Spare memory on a graph store node for second copies."),
    },
    good_for="Large graphs with big imports, where everyone should see one complete version at a time.",
    needs=("New-version builds turned on, a platform copy rather than a connected graph, and free "
           "memory on a graph store node for a second copy."),
    pros=("Readers see one complete version at a time during a large change",
          "Reads stay fast, and a build still under way is never shown"),
    cons=("A large change shows only once it is fully built: later than in place",
          "Takes room for a second copy while it is built",
          "Smaller changes are written in place, and so is a change whose build keeps failing"),
    frames=(
        Frame("before", "Version 5", "graph store"),
        Frame("while", "Version 5", "graph store", "Exactly version 5; version 6 is built alongside"),
        Frame("after", "Version 6", "graph store", "Switched in one step, once built and checked"),
    ),
    example=("An import changes 500,000 items in a graph of 10 million, more than the 200,000 "
             "changes above which a publish is built. Canvases keep showing exactly version 5 while "
             "version 6 is built and checked in a second copy; then every view switches to version "
             "6 at once. If the build fails every attempt, version 6 is written in place instead."),
    requires=(Requirement(feature="candidateKeysEnabled", why="builds_off"),
              Requirement(graph_fact="platform_copy", why="connected_graph")),
    falls_back_to="in_place",
)

_READS = (
    Setting(
        key="reads.mode",
        category="reads",
        label="Read mode",
        kind="choice",
        default=Default("latest", "GRAPHVER_READ_MODE", "READ_MODE"),
        scopes=_PWG,
        takes_effect=_NEXT_READ,
        audience="business",
        question="What should people see while new data loads?",
        section="while_loading",
        choices=(_LATEST, _IN_PLACE, _BESIDE),
        limitable=("allowed", "lock"),
        default_limits={"allowed": ("latest", "in_place")},
        uses=("reads.maxVersionsBehind", "builds.aboveRows", "builds.forRebuilds"),
        routing=True,
        freshness="strict",
        visual="read_timeline",
        legacy=Legacy(build_policy="readMode", projection_state_column="read_mode"),
        guidance=Guidance(
            summary="What people see while a new version of a graph loads into the graph store.",
            means=("A publish or an import lands in the database at once, as one new version. Then "
                   "the graph store, which answers reads fast, is updated, and on a large graph that "
                   "takes a while. The read mode decides what readers get meanwhile: the newest "
                   "version, read from the database; the graph store's copy as it is updated; or one "
                   "whole version until a new copy is built and everyone switches to it."),
            effects=(
                Effect("consistency", "Always the latest and Switch when ready: readers see one "
                                      "whole version.",
                       "Update in place: readers can see part of a new version while it is "
                       "written.", "high", "better"),
                Effect("read_speed", "Update in place and Switch when ready keep reads on the graph "
                                     "store at full speed.",
                       "Always the latest reads from the database during an update: slower on a "
                       "large graph.", "high", "better"),
                Effect("update_speed", "Always the latest and Update in place show a change as it "
                                       "lands.",
                       "Switch when ready shows a large change only once it is built.", "medium",
                       "better"),
                Effect("memory", "Always the latest and Update in place need no extra memory.",
                       "Switch when ready needs room for a second copy while it builds.", "high",
                       "better"),
                Effect("database_load", "Update in place and Switch when ready keep reads off the "
                                        "database.",
                       "Always the latest sends every read during an update to the database.",
                       "medium", "better"),
                Effect("availability", "Update in place and Switch when ready serve every read from "
                                       "the graph store.",
                       "Always the latest: under heavy load, a read from the database may be asked "
                       "to retry.", "low", "better"),
                Effect("cost", "Always the latest and Update in place cost nothing extra.",
                       "Switch when ready needs spare memory on a graph store node.", "low",
                       "better"),
            ),
            change_when=(
                "Views of a large graph slow down for a while after each big import: choose Keep "
                "serving, update in place for that graph.",
                "Readers must never see part of an update: choose Keep serving, switch when ready, "
                "with New-version builds on and memory for a second copy.",
                "The newest data must show the moment it is published, even if slower: keep Always "
                "the latest.",
            ),
            recommended=Recommendation(
                "latest",
                "How reads have always worked: exact, with nothing extra to run. Set Keep serving, "
                "update in place on the large graphs whose views must stay fast, and Keep serving, "
                "switch when ready only where readers must see one whole version and there is "
                "memory for a second copy."),
            risk="medium",
            risk_note=("Keep serving, switch when ready needs New-version builds and room for a "
                       "second copy, or it updates in place. Always the latest reads a graph that is "
                       "updating from the database, which a busy database feels."),
            symptoms=("Reads are slow while data loads", "Canvases are slow after a big import",
                      "People see half-updated data", "Lineage summaries are missing after an import",
                      "The database is busy after every publish"),
            example=_ex_read_mode,
            evidence=(
                "Measured by the versioning-scale workflow (docs/versioning/09 §2) at 1,000,000 nodes "
                "and 1,000,000 edges, a change of 100,000 rows, 4 readers: Always the latest landed "
                "in 29 s, reads p99 66 ms, 5% of them from Postgres; update in place 30 s, p99 9 ms, "
                "no extra memory; switch when ready by a copy 56 s, p99 9.6 ms, FalkorDB at 2.0x the "
                "graph's memory at the peak; by a seed from Postgres 522 s, at 1.1x. No read failed "
                "in any mode. With 200 readers at 1M nodes and 2M edges, GRAPH.COPY took 76 to 88 s, "
                "past the projector's 75 s socket, three times: the build was dropped and the change "
                "written in place. One rule applies the mode to every read: service.serving_seq with "
                "build_policy.max_lag_of (0 for latest). candidates.wanted builds beside only above "
                "buildAboveRows, on a platform-owned key, with candidateKeysEnabled on; a graph whose "
                "summaries live in a graph named from its key, or whose key other data sources read, "
                "is written in place (projection._keeps_its_key)."),
            aliases=("read mode", "consistency", "freshness", "stale reads", "blue-green",
                     "hydration", "serving while updating", "projection", "GRAPHVER_READ_MODE"),
        ),
    ),
    Setting(
        key="reads.maxVersionsBehind",
        category="reads",
        label="Most versions behind",
        kind="count_or_unlimited",
        default=Default("unlimited", "GRAPHVER_READ_MAX_LAG", "READ_MAX_LAG"),
        scopes=_PWG,
        takes_effect=_NEXT_READ,
        audience="business",
        question="How out of date may a fast view be while new data loads?",
        section="while_loading",
        range=(0, 10_000),
        unit="versions",
        limitable=("range", "lock"),
        requires=(Requirement(setting="reads.mode", one_of=("in_place", "beside"),
                              why="not_used_by_mode"),),
        uses=("reads.mode",),
        routing=True,
        legacy=Legacy(encode="minus_one_is_unlimited"),
        guidance=Guidance(
            summary=("How many versions behind the newest one a graph's copy may still serve readers "
                     "while it catches up."),
            means=("With Keep serving, update in place or Keep serving, switch when ready, readers "
                   "stay on the graph store's copy while it catches up, at the version it last "
                   "finished. This caps how many versions behind that may be. Further behind, "
                   "readers go to the database for the newest version until the copy catches up. "
                   "Always the latest doesn't use it: it never serves an older version."),
            effects=(
                Effect("consistency", "Readers may see a version further behind the newest one.",
                       "Readers get the newest version sooner, from the database when the copy is "
                       "behind.", "medium", "worse"),
                Effect("read_speed", "More reads stay on the fast graph store while it catches up.",
                       "More reads go to the slower database while the copy catches up.", "medium",
                       "better"),
                Effect("database_load", "Fewer reads go to the database.",
                       "More reads go to the database while a graph catches up.", "medium",
                       "better"),
            ),
            change_when=(
                "Readers of a graph set to update in place must never be more than a few versions "
                "out of date: set a small number.",
                "Reads of a large graph go slow every time it falls behind: raise it, or set no "
                "limit.",
            ),
            recommended=Recommendation(
                "unlimited",
                "The copy catches up on its own, and until it does readers keep a whole recent "
                "version at full speed. A limit sends them to the database instead, which is "
                "slower on a large graph."),
            risk="low",
            risk_note=("A small limit sends readers of a busy graph to the database whenever it "
                       "falls that far behind, which is slower and loads the database."),
            symptoms=("Readers see data that is a few versions old", "Reads are slow while data loads",
                      "The database is busy while a graph catches up"),
            example=_ex_max_behind,
            evidence=(
                "service.serving_seq: behind its head, a key serves main at the version it last "
                "published unless committed - held > lag; the lag is build_policy.max_lag_of(mode): "
                "0 for latest, else GRAPHVER_READ_MAX_LAG (-1, any). The same bound decides whether "
                "a rebuild or a move can be built beside the key (service._beside_ok)."),
            aliases=("max lag", "staleness", "versions behind", "read lag", "GRAPHVER_READ_MAX_LAG"),
        ),
    ),
)

# ---------------------------------------------------------------------------------------------
# Updates & loading
# ---------------------------------------------------------------------------------------------

_UPDATES = (
    Setting(
        key="updates.statementTargetMs",
        category="updates",
        label="Write target",
        kind="ms",
        default=Default(500, "GRAPHVER_PROJECTION_STATEMENT_TARGET_MS", "PROJECTION_STATEMENT_TARGET_MS"),
        scopes=_P,
        takes_effect=_NEXT_WRITE,
        section="pacing",
        range=(100, 10_000),
        uses=("updates.writeCeilingSecs",),
        legacy=Legacy(build_policy="statementTargetMs"),
        guidance=Guidance(
            summary=("How long each write to the graph store aims to take, so reads on the same node "
                     "keep their turn."),
            means=("While the worker writes new data into a graph's copy, every read of that graph "
                   "on the same node waits for the write to finish. So writes are kept short: one "
                   "that takes longer than this makes the next one smaller, down to 50 changes."),
            effects=(
                Effect("read_speed", "Reads on the node can wait longer behind each write.",
                       "Reads wait less behind each write.", "high", "worse"),
                Effect("update_speed", "Fewer, larger writes: a graph updates sooner.",
                       "More, smaller writes: a large update takes longer.", "medium", "better"),
            ),
            change_when=(
                "Canvases stall for a moment, again and again, while a graph updates: lower it.",
                "Large updates take too long while reads are quiet: raise it.",
            ),
            recommended=Recommendation(
                500, "Short enough that a read waits about half a second at most behind a write, "
                     "long enough that writes aren't split into tiny pieces."),
            risk="low",
            risk_note=("Too low splits writes into many small ones and slows large updates; too high "
                       "makes reads wait behind long writes."),
            symptoms=("Canvases stall while a graph updates", "Updates take too long to land"),
            example=lambda values, facts: (
                f"Each write to the graph store aims to take about "
                f"{_v(values, 'updates.statementTargetMs'):,} ms. One that runs longer makes the "
                f"next one smaller, so a read waits about that long at most behind a write."),
            evidence=(
                "projection._laddered: a chunk slower than statementTargetMs halves the next, no "
                "narrower than 50 rows for being slow (_SLOW_FLOOR). A write holds the graph's write "
                "lock, and every read of it on that node, while it runs (docs/versioning/04 §5, "
                "Serving while it updates)."),
            aliases=("statement target", "write target", "write batch", "pacing",
                     "GRAPHVER_PROJECTION_STATEMENT_TARGET_MS"),
        ),
    ),
    Setting(
        key="updates.writeCeilingSecs",
        category="updates",
        label="Longest write",
        kind="seconds",
        default=Default(10, "GRAPHVER_PROJECTION_WRITE_CEILING_S", "PROJECTION_WRITE_CEILING_S"),
        scopes=_P,
        takes_effect=_NEXT_WRITE,
        section="pacing",
        range=(1, 60),
        legacy=Legacy(build_policy="writeCeilingSecs"),
        guidance=Guidance(
            summary="The longest one write to the graph store may run before it is stopped and split.",
            means=("A write still running after this long is stopped and sent again in halves, so no "
                   "read waits longer than this behind one write. The graph store undoes a stopped "
                   "write, so nothing is left half-written."),
            effects=(
                Effect("read_speed", "A read can wait longer behind one write.",
                       "No read waits long behind a write.", "high", "worse"),
                Effect("update_speed", "Fewer writes are stopped and redone: a heavy update lands "
                                       "sooner.",
                       "More writes are stopped and redone in halves: a heavy update takes longer.",
                       "medium", "better"),
            ),
            change_when=(
                "Reads freeze for several seconds during big updates: lower it.",
                "Updates of a large graph keep failing on timeouts: raise it a little.",
            ),
            recommended=Recommendation(
                10, "Long enough for any well-sized write, short enough that a stuck write never "
                    "holds a node's reads for long."),
            risk="medium",
            risk_note=("Set very low, writes that can't fit are halved down to one change and "
                       "retried, and an update can fail."),
            symptoms=("Reads freeze during big updates", "Updates fail with timeouts on a large graph"),
            example=lambda values, facts: (
                f"A write still running after {_dur(_v(values, 'updates.writeCeilingSecs'))} is "
                f"stopped and sent again in halves; reads behind it wait no longer than that."),
            evidence=(
                "projection._laddered: every chunked write's budget is min(the client's write "
                "budget, writeCeilingSecs), on every FalkorDB mode; a timeout halves the chunk and "
                "sends the halves again, down to one row, then retries it 3 times "
                "(GRAPHVER_PROJECTION_FLOOR_RETRIES). FalkorDB rolls back a statement it aborts, and "
                "every projector write is an idempotent MERGE, SET or DELETE."),
            aliases=("write ceiling", "write timeout", "longest write",
                     "GRAPHVER_PROJECTION_WRITE_CEILING_S"),
        ),
    ),
    Setting(
        key="updates.pacingRatio",
        category="updates",
        label="Pause after a write",
        kind="ratio",
        default=Default(0.25, "GRAPHVER_PROJECTION_PACING_RATIO", "PROJECTION_PACING_RATIO"),
        scopes=_P,
        takes_effect=_NEXT_WRITE,
        section="pacing",
        range=(0, 5),
        unit="×",
        uses=("updates.statementTargetMs",),
        visual="write_rhythm",
        legacy=Legacy(build_policy="pacingRatio"),
        guidance=Guidance(
            summary="The pause after each write to the graph store, as a share of the time it took.",
            means=("After each write the worker pauses, so reads waiting on that node go first. At "
                   "0.25 it pauses a quarter as long as the write took, at most 5 seconds; at 0 it "
                   "pauses only while reads are waiting (Pause while reads wait)."),
            effects=(
                Effect("read_speed", "Reads get more of the node's time while a graph updates.",
                       "Reads get less of the node's time while a graph updates.", "high", "better"),
                Effect("update_speed", "Updates take longer to land.", "Updates land sooner.",
                       "high", "worse"),
            ),
            change_when=(
                "Canvases are slow whenever a graph updates: raise it.",
                "Updates take too long while reads are quiet: lower it.",
            ),
            recommended=Recommendation(
                0.25, "Reads get a fifth of the node's time even while a graph updates, and updates "
                      "still land quickly. While reads are waiting, the pause grows anyway (Pause "
                      "while reads wait)."),
            risk="low",
            risk_note="High values slow every update; 0 lets a long update hold the node's reads.",
            symptoms=("Canvases are slow while a graph updates", "Updates take too long to land"),
            example=_ex_pacing,
            evidence=(
                "projection._pace: after each write a pause of pacingRatio times its time, "
                "readPressureRatio times while the web tier marks reads on the node as starving "
                "(agg:readpressure:<node>), at most 5 s (_PACE_MAX_S), none under 5 ms."),
            aliases=("pacing", "pause", "yield to reads", "write rhythm",
                     "GRAPHVER_PROJECTION_PACING_RATIO"),
        ),
    ),
    Setting(
        key="updates.readPressureRatio",
        category="updates",
        label="Pause while reads wait",
        kind="ratio",
        default=Default(2.0, "GRAPHVER_PROJECTION_READ_PRESSURE_RATIO", "PROJECTION_READ_PRESSURE_RATIO"),
        scopes=_P,
        takes_effect=_NEXT_WRITE,
        section="pacing",
        range=(0, 10),
        unit="×",
        uses=("updates.pacingRatio", "updates.statementTargetMs"),
        legacy=Legacy(build_policy="readPressureRatio"),
        guidance=Guidance(
            summary="The longer pause after each write while reads on the node are waiting.",
            means=("When reads on a node are queueing, the worker pauses this share of each write's "
                   "time instead, at most 5 seconds, so readers catch up. It applies only when it is "
                   "longer than the usual pause."),
            effects=(
                Effect("read_speed", "Waiting reads catch up faster during an update.",
                       "Waiting reads stay queued longer.", "high", "better"),
                Effect("availability", "Fewer reads time out under load while a graph updates.",
                       "More reads may time out under load while a graph updates.", "medium",
                       "better"),
                Effect("update_speed", "An update slows more while reads are busy.",
                       "An update keeps its pace while reads are busy.", "medium", "worse"),
            ),
            change_when=(
                "Reads time out or are asked to retry while a large graph updates: raise it.",
                "Updates stall during busy hours: lower it.",
            ),
            recommended=Recommendation(
                2.0, "While reads wait, each write is followed by a pause twice as long, so reads "
                     "get two thirds of the node's time until they catch up."),
            risk="low",
            risk_note="High values can hold an update back for as long as reads stay busy.",
            symptoms=("Reads time out while a graph updates", "Updates stall during busy hours"),
            example=_ex_pressure,
            evidence=(
                "projection._pace: readPressureRatio replaces pacingRatio while reads on the node are "
                "starving and it is the larger, at most 5 s; graphver_projection_yields_total counts "
                "each such pause."),
            aliases=("read pressure", "starving reads", "yield", "GRAPHVER_PROJECTION_READ_PRESSURE_RATIO"),
        ),
    ),
    Setting(
        key="updates.retireGraceSecs",
        category="updates",
        label="Keep the previous copy for",
        kind="seconds",
        default=Default(900, "GRAPHVER_RETIRE_GRACE_SECS", "RETIRE_GRACE_SECS"),
        scopes=_P,
        takes_effect=("next_switch", "Switches and moves made after the change. A previous copy "
                                     "already waiting keeps the time it was given."),
        section="switch",
        range=(660, 86_400),
        legacy=Legacy(build_policy="retireGraceSecs"),
        guidance=Guidance(
            summary=("How long a graph's previous copy is kept after a switch or a move, so reads "
                     "under way finish on it."),
            means=("When readers move to a new copy, after a new-version build or a move, the old "
                   "copy stays in the graph store this long, so reads already running finish on it. "
                   "Then it is removed and its memory freed. It is at least 11 minutes."),
            effects=(
                Effect("memory", "Old copies hold memory longer after each switch.",
                       "Memory is freed sooner after a switch.", "high", "worse"),
                Effect("availability", "Long reads under way at a switch always finish.",
                       "A read that started before a switch is likelier to fail when its copy is "
                       "removed.", "medium", "better"),
            ),
            change_when=(
                "Graph store memory stays high for a while after each switch or move: lower it.",
                "Long-running reads fail just after a switch: raise it.",
            ),
            recommended=Recommendation(
                900, "Fifteen minutes is far longer than any read, and the memory comes back soon "
                     "after."),
            risk="low",
            risk_note=("Long values keep two copies of a graph in memory after every switch; the "
                       "graph store needs room for both."),
            symptoms=("Graph store memory stays high after a switch",
                      "Reads fail just after a switch or move"),
            example=lambda values, facts: (
                f"After a switch or a move, the previous copy stays "
                f"{_dur(_v(values, 'updates.retireGraceSecs'))}; then it is removed and its memory "
                f"freed."),
            evidence=(
                "Stamped on retired_keys when a build switches (switch_to_candidate) or a key is "
                "moved: retireAfter = now + retireGraceSecs; the retire loop drops a due key once the "
                "new one has caught up. Its range starts at 660 s, past "
                "versioned_sources.CACHE_TTL_SECS (600 s), within which a newly versioned data "
                "source may still read its own key."),
            aliases=("retire grace", "old copy", "previous copy", "GRAPHVER_RETIRE_GRACE_SECS"),
        ),
    ),
)

# ---------------------------------------------------------------------------------------------
# New-version builds
# ---------------------------------------------------------------------------------------------

_BUILDS = (
    Setting(
        key="builds.aboveRows",
        category="builds",
        label="Build above",
        kind="count",
        default=Default(200_000, "GRAPHVER_PROJECTION_CANDIDATE_ABOVE", "PROJECTION_CANDIDATE_ABOVE"),
        scopes=_P,
        takes_effect=("next_publish", "Publishes the worker starts updating after the change. A "
                                      "build already under way carries on."),
        section="when",
        range=(1_000, 100_000_000),
        unit="changes",
        requires=_BUILDS_ON,
        uses=("reads.mode",),
        legacy=Legacy(build_policy="buildAboveRows"),
        guidance=Guidance(
            summary="How large a publish must be to be built in a second copy rather than written in place.",
            means=("For a graph set to Keep serving, switch when ready, a publish that changes more "
                   "than this many items is built in a second copy while readers keep the current "
                   "version, then switched to. A smaller one is written into the current copy, "
                   "paced, as with update in place."),
            effects=(
                Effect("consistency", "More publishes are written in place, where readers can see "
                                      "part of them.",
                       "More publishes are built whole before readers see them.", "medium", "worse"),
                Effect("memory", "Fewer builds, so less room is taken by second copies.",
                       "More builds, each needing room for a second copy.", "high", "better"),
                Effect("update_speed", "Mid-sized publishes land sooner, written in place.",
                       "More publishes wait for a build before they show.", "medium", "better"),
            ),
            change_when=(
                "Readers of a graph set to switch when ready see mid-sized imports half-applied: "
                "lower it.",
                "Builds keep the graph store short of memory: raise it.",
            ),
            recommended=Recommendation(
                200_000, "Builds are worth their memory for large changes, which take long enough to "
                         "write that readers would notice. A change of 100,000 was written in place "
                         "in about 30 seconds (measured)."),
            risk="low",
            risk_note="Very low builds a second copy for almost every publish, which takes memory and time.",
            symptoms=("People see half-updated data after a mid-sized import", "Builds use too much memory"),
            example=lambda values, facts: (
                f"In a graph set to switch when ready, a publish of more than "
                f"{_v(values, 'builds.aboveRows'):,} changes is built in a second copy; one of "
                f"{_v(values, 'builds.aboveRows'):,} or fewer is written in place."),
            evidence=(
                "candidates.wanted: read mode beside, the switch on, a platform-owned key and more "
                "version rows than buildAboveRows (counted no further, projection._queue_build). "
                "Measured (docs/versioning/09 §2): in place landed 100,000 rows into a 1M + 1M graph "
                "in 30 s, reads p99 9 ms."),
            aliases=("build threshold", "build beside above", "GRAPHVER_PROJECTION_CANDIDATE_ABOVE"),
        ),
    ),
    Setting(
        key="builds.forRebuilds",
        category="builds",
        label="Rebuilds and moves too",
        kind="bool",
        default=Default(True, "GRAPHVER_PROJECTION_CANDIDATE_REBUILDS", "PROJECTION_CANDIDATE_REBUILDS"),
        scopes=_P,
        takes_effect=("build_start", "Rebuilds and moves asked for after the change. One already "
                                     "under way carries on."),
        section="when",
        requires=_BUILDS_ON,
        uses=("reads.mode",),
        legacy=Legacy(build_policy="buildForRebuilds"),
        guidance=Guidance(
            summary="Whether rebuilds and moves of a graph set to switch when ready are built in a second copy too.",
            means=("On, a rebuild or a move of a graph set to Keep serving, switch when ready builds "
                   "the new copy from the database while readers keep the current version, then "
                   "switches. Off, they are made in place: a rebuild repairs the copy readers use as "
                   "it goes, and a move builds the new copy from nothing while readers go to the "
                   "database."),
            effects=(
                Effect("consistency", "Readers see one whole version through a rebuild or a move.",
                       "Readers see a rebuild's repairs as they happen.", "medium", "better"),
                Effect("read_speed", "Reads stay on the graph store during a move.",
                       "During a move, reads come from the slower database.", "medium", "better"),
                Effect("memory", "A rebuild needs room for a second copy while it is built.",
                       "A rebuild needs no extra memory.", "medium", "worse"),
            ),
            change_when=(
                "Rebuilds of large graphs show partly repaired data, or moves send readers to the "
                "database for long: turn it on.",
                "The graph store has no room for second copies: turn it off.",
            ),
            recommended=Recommendation(
                True, "A rebuild or a move then never shows readers anything but a whole version, "
                      "and reads stay fast."),
            risk="low",
            risk_note=("On, each rebuild or move of such a graph needs room for a second copy; "
                       "without room it waits, or is made in place."),
            symptoms=("People see a graph being rebuilt", "Reads are slow while a graph is moved"),
            example=lambda values, facts: (
                "A rebuild of a graph set to switch when ready builds a new copy from the database "
                "while readers keep the current version, then everyone switches."
                if _v(values, "builds.forRebuilds") else
                "A rebuild repairs the copy readers use as it goes, and a move sends readers to the "
                "database until the new copy is built."),
            evidence=(
                "candidates.beside_wanted (beside, the switch on, buildForRebuilds on) and "
                "service._beside_ok (a live, platform-owned, idle key serving a version it "
                "published). A rebuild or a move is always seeded from Postgres, never copied "
                "(docs/versioning/04 §5, Rebuilds and moves built beside). In place, a rebuild keeps "
                "serving the version the key held (served_commit_seq), and a move's key, written "
                "from nothing, serves nothing until it is done."),
            aliases=("rebuilds beside", "moves beside", "GRAPHVER_PROJECTION_CANDIDATE_REBUILDS"),
        ),
    ),
    Setting(
        key="builds.method",
        category="builds",
        label="How a build makes its copy",
        kind="choice",
        default=Default("auto", "GRAPHVER_PROJECTION_CANDIDATE_MODE", "PROJECTION_CANDIDATE_MODE"),
        scopes=_P,
        takes_effect=_ROOM_ASKED,
        section="room",
        choices=(
            Choice(
                id="auto", title="Auto", short="Copy when there's room",
                promise=("Copies the current copy when its node has room, else builds the new copy "
                         "from the database on the node with the most room."),
                effects={"update_speed": ("better", "Copies when it can, which is much faster."),
                         "memory": ("same", "About twice the graph's size for a copy, its size from "
                                            "the database.")},
                good_for="Most platforms: the fastest build that fits.",
            ),
            Choice(
                id="copy", title="Copy only", short="Always copy",
                promise="Always copies the current copy, waiting for room on its node.",
                effects={"update_speed": ("better", "A copy lands fastest, once there is room."),
                         "memory": ("worse", "Needs about twice the graph's size free on one node, "
                                             "and waits until it is.")},
                good_for="Platforms with plenty of memory on every node.",
            ),
            Choice(
                id="reseed", title="From the database only", short="Always from the database",
                promise="Always builds the new copy from the database, on the node with the most room.",
                effects={"update_speed": ("worse", "Building from the database takes much longer."),
                         "memory": ("better", "About the graph's size, on whichever node has most "
                                              "room."),
                         "database_load": ("worse", "Each build reads the whole graph from the "
                                                    "database.")},
                good_for="Nodes too full for copies, or graphs too large to copy in time.",
            ),
        ),
        requires=_BUILDS_ON,
        uses=("builds.copyRoomPct", "builds.copyMaxBytes"),
        legacy=Legacy(build_policy="buildMode"),
        guidance=Guidance(
            summary="Whether a build copies the current copy or builds the new one from the database.",
            means=("A copy is fast, but needs about twice the graph's size free on the node the "
                   "current copy is on. Building from the database is much slower, but needs about "
                   "the graph's size, on whichever node has the most room. Auto copies when it can "
                   "and builds from the database when it can't. Rebuilds and moves are always "
                   "built from the database."),
            effects=(
                Effect("update_speed", "Auto and Copy only: a copy lands much sooner.",
                       "From the database only: each build reads the whole graph and takes much "
                       "longer.", "high", "better"),
                Effect("memory", "From the database only: about the graph's size, on the node with "
                                 "the most room.",
                       "Copy only: about twice the graph's size, on one node.", "high", "better"),
                Effect("database_load", "Auto and Copy only: a copy doesn't read the database.",
                       "From the database only: each build reads the whole graph from the database.",
                       "medium", "better"),
            ),
            change_when=(
                "Builds wait for room because the current copy's node is full: keep Auto, or "
                "choose From the database only.",
                "Copies of a very large graph time out: choose From the database only, or limit "
                "copies (Largest graph copied).",
            ),
            recommended=Recommendation("auto", "The fastest build that fits: a copy when the node "
                                               "has room, else the database."),
            risk="low",
            risk_note=("Copy only waits as long as the node lacks room; From the database only is "
                       "many times slower and reads the database hard."),
            symptoms=("Builds wait for room", "Builds take hours", "Copies time out on a large graph"),
            example=_ex_method,
            evidence=(
                "projection._build_queued: copy asks residency.admit_build_copy for room on the "
                "serving key's node; auto seeds (admit_build_seed, the master with most room) when "
                "the copy is refused for capacity or size; a rebuild or a move is always seeded. "
                "Measured (docs/versioning/09 §2): at 1M + 1M a change landed by GRAPH.COPY in 56 s "
                "at 2.0x the graph's memory at the peak, by a seed from Postgres in 522 s at 1.1x; "
                "at 100k + 100k, 14.5 s against 51.4 s."),
            aliases=("build mode", "copy or seed", "GRAPH.COPY", "reseed",
                     "GRAPHVER_PROJECTION_CANDIDATE_MODE"),
        ),
    ),
    Setting(
        key="builds.copyRoomPct",
        category="builds",
        label="Free memory a copy needs",
        kind="percent",
        default=Default(220, "GRAPHVER_PROJECTION_COPY_MARGIN_PCT", "PROJECTION_COPY_MARGIN_PCT"),
        scopes=_P,
        takes_effect=_ROOM_ASKED,
        section="room",
        range=(100, 400),
        requires=_BUILDS_ON,
        uses=("residency.unloadStartPct", "builds.method"),
        visual="copy_room",
        legacy=Legacy(build_policy="copyMarginPct"),
        guidance=Guidance(
            summary="The free memory a copy needs on its node, as a share of the graph's size.",
            means=("While a copy is made, its node holds the new copy and the copy's own working "
                   "buffer, each about the size of the graph. So a copy waits until the node has "
                   "this share of the graph's size free under its start mark, and that room is held "
                   "for it until it lands."),
            effects=(
                Effect("availability", "A copy never pushes a node out of memory.",
                       "Under 200%, a copy can run a node out of memory, and every graph on it with "
                       "it.", "high", "better"),
                Effect("memory", "Copies wait for more free memory, keeping nodes further from "
                                 "their limit.",
                       "Copies start with less free memory, closer to the node's limit.", "high",
                       "better"),
                Effect("update_speed", "Builds wait longer for room, or are built from the database "
                                       "instead.",
                       "Builds copy sooner.", "medium", "worse"),
            ),
            change_when=(
                "Memory alarms fire on a node while a copy runs: raise it.",
                "Builds wait for room though nodes have plenty free: lower it, never under 200%.",
            ),
            recommended=Recommendation(
                220, "A copy was measured at 2.0 times the graph's memory at its peak; 220% adds a "
                     "margin.", compute=_rec_copy_room),
            risk="high",
            risk_note=("Under 200%, a copy can take a node past its memory limit, which can stop "
                       "every graph on that node."),
            symptoms=("Graph store memory alarms during a build", "Builds wait for room"),
            example=_ex_copy_room,
            evidence=(
                "residency.copy_room: needed = size x copyMarginPct / 100 under the master's start "
                "mark after what is held there, reserved in the aggregation write governor's ledger "
                "under the capacity lock until the copy lands or fails. Measured (docs/versioning/09 "
                "§2): during GRAPH.COPY FalkorDB rose by 2.0x the graph's memory at its peak (1,324 "
                "to 3,910 MB at 1M + 1M; 1,463 to 4,447 MB at 1M + 2M); a seed from Postgres by 1.0 "
                "to 1.1x."),
            aliases=("copy margin", "copy room", "room a copy needs", "GRAPHVER_PROJECTION_COPY_MARGIN_PCT"),
        ),
    ),
    Setting(
        key="builds.copyMaxBytes",
        category="builds",
        label="Largest graph copied",
        kind="bytes_or_unlimited",
        default=Default("unlimited", "GRAPHVER_PROJECTION_COPY_MAX_BYTES", "PROJECTION_COPY_MAX_BYTES"),
        scopes=_P,
        takes_effect=_ROOM_ASKED,
        section="room",
        range=(1, 16 * (1 << 40)),
        requires=_BUILDS_ON,
        uses=("builds.method", "builds.copyRoomPct"),
        legacy=Legacy(build_policy="copyMaxBytes", encode="zero_is_unlimited"),
        guidance=Guidance(
            summary="The largest graph a build may copy; a larger one is built from the database.",
            means=("A graph over this size is never copied: with Auto its builds come from the "
                   "database instead, which needs about half the memory but takes much longer; with "
                   "Copy only they wait. Copies of very large graphs take long too, and one that "
                   "outlasts the worker's wait on a write (75 seconds by default) fails that attempt."),
            effects=(
                Effect("update_speed", "Builds of large graphs land sooner, copied.",
                       "Builds of large graphs take much longer from the database.", "high",
                       "better"),
                Effect("memory", "Larger graphs are copied, at about twice their size.",
                       "Large graphs are built from the database, at about their own size.",
                       "medium", "worse"),
                Effect("availability", "A copy of a very large graph may outlast the worker's wait "
                                       "and fail.",
                       "Large graphs avoid long copies that may time out.", "medium", "worse"),
            ),
            change_when=(
                "Copies of your largest graphs fail on timeouts or crowd a node: set a limit just "
                "under their size.",
                "Builds of large graphs take too long from the database while nodes have room: "
                "raise the limit, or remove it.",
            ),
            recommended=Recommendation(
                "unlimited", "Room for a copy is already checked first (Free memory a copy needs); "
                             "set a limit when copies of your largest graphs time out.",
                compute=_rec_copy_max),
            risk="medium",
            risk_note="With Copy only, a graph over the limit is never copied, so its builds wait.",
            symptoms=("Copies time out on a large graph", "Builds of large graphs take hours"),
            example=_ex_copy_max,
            evidence=(
                "residency.copy_room refuses a graph larger than copyMaxBytes (too_large), and auto "
                "then seeds it (projection._build_queued). Measured (docs/versioning/09 §10, item "
                "6): under 200 readers, GRAPH.COPY of 1M nodes and 2M edges took 76 to 88 s, past "
                "the projector's 75 s socket (PROJECTION_FALKOR_WRITE_TIMEOUT_S 60 + "
                "PROJECTION_SOCKET_TIMEOUT_MARGIN_S 15); after 3 attempts the build was dropped and "
                "the change written in place. With 4 readers the same copy took about 19 s."),
            aliases=("copy limit", "copy max bytes", "GRAPHVER_PROJECTION_COPY_MAX_BYTES"),
        ),
    ),
    Setting(
        key="builds.noRoom",
        category="builds",
        label="With no room",
        kind="choice",
        default=Default("wait", "GRAPHVER_PROJECTION_NO_ROOM_POLICY", "PROJECTION_NO_ROOM_POLICY"),
        scopes=_P,
        takes_effect=("build_start", "The next time a waiting build asks for room, within a minute."),
        section="room",
        choices=(
            Choice(
                id="wait", title="Wait for room", short="Wait",
                promise=("Readers keep the current, whole version while the build waits; it asks "
                         "for room again every minute."),
                effects={"consistency": ("better", "Readers only ever see whole versions."),
                         "update_speed": ("worse", "The change shows only once there is room.")},
            ),
            Choice(
                id="in_place", title="Update in place", short="Update in place",
                promise=("The build is dropped and the change is written into the current copy, "
                         "paced: readers may see it partly applied."),
                effects={"consistency": ("worse", "Readers can see the change partly applied."),
                         "update_speed": ("better", "The change shows without waiting for room.")},
            ),
        ),
        requires=_BUILDS_ON,
        uses=("builds.noRoomAlertSecs",),
        legacy=Legacy(build_policy="noRoomPolicy"),
        guidance=Guidance(
            summary="What a build does when no node has room for it.",
            means=("Wait keeps readers on the current, whole version and asks again every minute, "
                   "so the new version shows late when room is short. Update in place gives the "
                   "build up and writes the change into the current copy, so it shows sooner but "
                   "can be seen half-written."),
            effects=(
                Effect("consistency", "Wait: readers only ever see whole versions.",
                       "Update in place: readers can see the change partly applied.", "high",
                       "better"),
                Effect("update_speed", "Update in place: the change shows without waiting for room.",
                       "Wait: the change shows only once there is room for a build.", "high",
                       "better"),
            ),
            change_when=(
                "New versions sometimes don't show for hours because nodes are full: choose Update "
                "in place, or add memory.",
                "Readers must only ever see whole versions: keep Wait.",
            ),
            recommended=Recommendation("wait", "Readers keep a whole version, and an alert says when "
                                               "a build is stuck (Alert after waiting)."),
            risk="medium",
            risk_note=("With Wait, a change can stay hidden from readers for as long as nodes lack "
                       "room."),
            symptoms=("A new version never shows up", "Builds wait for room", "People see half-updated data"),
            example=_ex_no_room,
            evidence=(
                "projection._build_queued: wait records why and retries after 60 s; in_place raises "
                "_BuildRefused and drop_candidate writes the window in place. A rebuild the projector "
                "started on its own never waits for room: it is made in place."),
            aliases=("no room policy", "waiting for room", "GRAPHVER_PROJECTION_NO_ROOM_POLICY"),
        ),
    ),
    Setting(
        key="builds.noRoomAlertSecs",
        category="builds",
        label="Alert after waiting",
        kind="seconds",
        default=Default(1800, "GRAPHVER_PROJECTION_NO_ROOM_ALERT_SECS", "PROJECTION_NO_ROOM_ALERT_SECS"),
        scopes=_P,
        takes_effect=("build_step", "The next time a waiting build asks for room, within a minute."),
        section="room",
        range=(300, 86_400),
        requires=_BUILDS_ON,
        uses=("builds.noRoom",),
        legacy=Legacy(build_policy="noRoomAlertSecs"),
        guidance=Guidance(
            summary="How long a build may wait for room before it raises an alert.",
            means=("A build still waiting for room this long after it was asked for raises an "
                   "alert: a warning in the worker's log and a count in its metrics, each minute it "
                   "goes on waiting. Point your monitoring at it."),
            effects=(
                Effect("update_speed", "A stuck build is noticed later, so a new version can stay "
                                       "hidden longer.",
                       "A stuck build is noticed sooner.", "low", "worse"),
            ),
            change_when=(
                "Builds wait a few minutes routinely and the alerts are noise: raise it.",
                "A stuck build went unnoticed for hours: lower it.",
            ),
            recommended=Recommendation(1800, "Half an hour: long enough for routine waits to clear, "
                                             "short enough to act on the same day."),
            risk="low",
            risk_note="Nothing changes for readers; only how soon someone hears of a stuck build.",
            symptoms=("No alert when a build is stuck", "Too many build alerts"),
            example=lambda values, facts: (
                f"A build still waiting for room "
                f"{_dur(_v(values, 'builds.noRoomAlertSecs'))} after it was asked for logs a "
                f"warning and counts in the build-waiting metric, each minute it waits."),
            evidence=(
                "projection._build_queued: past noRoomAlertSecs since the build was asked for "
                "(state.since), it increments graphver_build_waiting_total{reason=room} and logs a "
                "warning on every retry (60 s)."),
            aliases=("build alert", "waiting alert", "GRAPHVER_PROJECTION_NO_ROOM_ALERT_SECS"),
        ),
    ),
    Setting(
        key="builds.perWorker",
        category="builds",
        label="Builds per worker",
        kind="count",
        default=Default(2, "GRAPHVER_PROJECTION_CANDIDATE_CONCURRENCY", "PROJECTION_CANDIDATE_CONCURRENCY"),
        scopes=_P,
        takes_effect=("next_pass", "The worker's next round. A build already running carries on."),
        section="lifecycle",
        range=(1, 8),
        unit="builds",
        requires=_BUILDS_ON,
        caps=(Cap(deployment="GRAPHVER_PROJECTION_CONCURRENCY", enforced=True,
                  why="capped_by_deployment"),),
        legacy=Legacy(build_policy="buildConcurrency"),
        guidance=Guidance(
            summary="How many builds each worker runs at once.",
            means=("Each worker updates a number of graphs at once, set by your deployment; up to "
                   "this many of them may be builds. More builds wait their turn. It can't be more "
                   "than the graphs a worker updates at once."),
            effects=(
                Effect("memory", "More second copies may be built at once, each needing room.",
                       "Fewer second copies at once.", "high", "worse"),
                Effect("update_speed", "Several large changes are built at once.",
                       "Builds queue behind one another.", "medium", "better"),
                Effect("database_load", "More builds read the database at once.",
                       "Fewer builds read the database at once.", "medium", "worse"),
            ),
            change_when=(
                "Builds queue behind one another while nodes have room: raise it.",
                "Builds crowd the graph store's memory or the database: lower it.",
            ),
            recommended=Recommendation(
                2, "Two at once keep big changes moving without crowding memory; each build needs "
                   "room for a second copy.", compute=_rec_per_worker),
            risk="medium",
            risk_note="Each build may need room for a whole second copy of its graph.",
            symptoms=("Builds queue behind each other", "Graph store memory alarms during builds"),
            example=_ex_per_worker,
            evidence=(
                "projection._advance_candidate: a build takes a step only while fewer than "
                "buildConcurrency are running in that projector; build_policy.effective clamps it to "
                "max(1, GRAPHVER_PROJECTION_CONCURRENCY), 8 by default."),
            aliases=("build concurrency", "builds at once", "GRAPHVER_PROJECTION_CANDIDATE_CONCURRENCY"),
        ),
    ),
    Setting(
        key="builds.maxAttempts",
        category="builds",
        label="Attempts before giving up",
        kind="count",
        default=Default(3, "GRAPHVER_PROJECTION_CANDIDATE_MAX_ATTEMPTS", "PROJECTION_CANDIDATE_MAX_ATTEMPTS"),
        scopes=_P,
        takes_effect=("build_step", "The next attempt of each build: one that has already failed "
                                    "that often is dropped."),
        section="lifecycle",
        range=(1, 10),
        unit="attempts",
        requires=_BUILDS_ON,
        legacy=Legacy(build_policy="buildMaxAttempts"),
        guidance=Guidance(
            summary=("How many times a build is tried before it is given up and the change is "
                     "written in place."),
            means=("A build step that fails is tried again from a fresh start after a pause. After "
                   "this many failures the build is dropped, its copy removed, and the change "
                   "written into the current copy in place, so it still lands."),
            effects=(
                Effect("consistency", "More tries before falling back to writing in place, where "
                                      "readers can see the change partly applied.",
                       "Falls back to writing in place sooner.", "medium", "better"),
                Effect("update_speed", "A failing build takes longer to give up, so the change shows "
                                       "later.",
                       "A failing build gives up sooner, and the change lands in place.", "medium",
                       "worse"),
            ),
            change_when=(
                "Builds fail now and then on a busy graph store, then succeed: raise it a little.",
                "A failing build holds a change back too long: lower it.",
            ),
            recommended=Recommendation(3, "Enough for a passing hiccup; a build that fails three "
                                          "times is likely to keep failing."),
            risk="low",
            risk_note="Each attempt can take a whole copy's time and memory.",
            symptoms=("A failing build keeps retrying", "A build gave up too soon"),
            example=lambda values, facts: (
                f"A build that fails {_v(values, 'builds.maxAttempts')} "
                f"time{'s' if _v(values, 'builds.maxAttempts') != 1 else ''} is dropped, and the "
                f"change is written in place."),
            evidence=(
                "projection._advance_candidate: attempts >= buildMaxAttempts drops the build "
                "(drop_candidate); each failure backs off and starts again from a fresh copy, or "
                "seeds again. Measured (docs/versioning/09 §10, item 6): under 200 readers, three "
                "copies of 1M + 2M timed out at 75 s, and the build was dropped and the change "
                "written in place."),
            aliases=("build attempts", "retries", "GRAPHVER_PROJECTION_CANDIDATE_MAX_ATTEMPTS"),
        ),
    ),
    Setting(
        key="builds.switchMaxLagRows",
        category="builds",
        label="Changes left at the switch",
        kind="count",
        default=Default(20_000, "GRAPHVER_PROJECTION_CANDIDATE_FLIP_MAX_LAG_ROWS",
                        "PROJECTION_CANDIDATE_FLIP_MAX_LAG_ROWS"),
        scopes=_P,
        takes_effect=("next_switch", "The next build that checks whether it can switch."),
        section="lifecycle",
        range=(0, 1_000_000),
        unit="changes",
        requires=_BUILDS_ON,
        legacy=Legacy(build_policy="flipMaxLagRows"),
        guidance=Guidance(
            summary=("How far behind a build may still be when it switches; the changes left are "
                     "written in place right after."),
            means=("A build first catches up with the changes published while it was built. Once it "
                   "is this few changes behind, it switches anyway, and the changes left are written "
                   "into the new copy in place right after. So a graph that keeps changing still "
                   "switches, but readers can see those last changes land part by part."),
            effects=(
                Effect("consistency", "More changes are written in place after the switch, where "
                                      "readers can see them partly applied.",
                       "The build catches up further, so readers switch to a more complete version.",
                       "medium", "worse"),
                Effect("update_speed", "A busy graph switches sooner.",
                       "A graph that keeps changing may take longer to switch.", "medium", "better"),
            ),
            change_when=(
                "A build of a busy graph keeps catching up and never switches: raise it.",
                "Readers see changes trickle in right after each switch: lower it.",
            ),
            recommended=Recommendation(
                20_000, "The size of change the worker writes straight after a publish: small enough "
                        "to land within seconds."),
            risk="low",
            risk_note=("At 0, a build catches up fully before it switches, which may take long on a "
                       "graph that changes all the time."),
            symptoms=("A build never switches on a busy graph", "Changes trickle in right after a switch"),
            example=lambda values, facts: (
                f"A build switches once it is {_v(values, 'builds.switchMaxLagRows'):,} changes or "
                f"fewer behind; those are written in place right after."),
            evidence=(
                "projection._build_switch: a build switches when its lag (version rows from its seq "
                "to the head) is at most flipMaxLagRows, at the version it holds, then nudges the "
                "next pass, which writes the rest into the new key in place. It defaults to "
                "GRAPHVER_PROJECTION_INLINE_MAX_ROWS (20,000). build_policy's help text and config.py "
                "say the rest is applied inside the switch; the code writes it after."),
            aliases=("flip max lag", "catch up", "switch lag",
                     "GRAPHVER_PROJECTION_CANDIDATE_FLIP_MAX_LAG_ROWS"),
        ),
    ),
)

# ---------------------------------------------------------------------------------------------
# Memory & residency
# ---------------------------------------------------------------------------------------------

_RESIDENCY = (
    Setting(
        key="residency.class",
        category="residency",
        label="Residency class",
        kind="choice",
        default=Default("standard"),
        scopes=_PWG_SYSTEM,
        takes_effect=("capacity_pass", "The next memory check, within a minute: an Always graph not "
                                       "in memory is queued to load, and a Standard or Coldline "
                                       "graph may be unloaded once idle."),
        audience="business",
        question="Should this graph stay ready in memory when nobody is using it?",
        section="class",
        choices=(
            Choice(
                id="always", title="Always", short="Always in memory",
                promise="Never unloaded. If it isn't in memory, it loads as soon as there is room.",
                effects={"read_speed": ("better", "Every read is fast, at any hour."),
                         "memory": ("worse", "Holds its memory whether it is read or not."),
                         "cost": ("worse", "Memory for the graph at all times.")},
                good_for="Graphs people open first thing every day, or that must open fast at any hour.",
            ),
            Choice(
                id="standard", title="Standard", short="Unloaded when unused for a while",
                promise=("Unloaded after a long time unread, a week by default, or sooner when its "
                         "node runs short of memory. Loaded again on its next read."),
                effects={"read_speed": ("same", "Fast while in use; the first read after a quiet "
                                                "spell is slower."),
                         "memory": ("same", "Gives its memory back when nobody uses it.")},
                good_for="Most graphs.",
            ),
            Choice(
                id="coldline", title="Coldline", short="Loaded only when needed",
                promise=("Unloaded soon after use, an hour unread by default, and first when memory "
                         "runs short. Read from the database until something needs it loaded."),
                effects={"read_speed": ("worse", "Usually read from the database: slower."),
                         "memory": ("better", "Takes memory only while it is in use."),
                         "cost": ("better", "Less memory, so a smaller graph store."),
                         "database_load": ("worse", "Its reads go to the database until it loads.")},
                good_for="Archives and graphs opened now and then.",
            ),
        ),
        requires=_RESIDENCY_ON,
        uses=("residency.standardIdleSecs", "residency.coldlineIdleSecs", "residency.coldlineLoadAbove"),
        materialized="projection_state.residency",
        legacy=Legacy(residency_policy="defaultResidency", platform_column="gv_default_residency",
                      projection_state_column="residency"),
        guidance=Guidance(
            summary="Whether a graph stays in the graph store's memory when nobody reads it.",
            means=("With Graph residency on, the graph store keeps each graph by its class and each "
                   "node's memory. Always graphs are never unloaded. Standard graphs are unloaded "
                   "after a long time unread, or sooner when memory runs short, and load again on "
                   "their next read. Coldline graphs are unloaded soon after use and are usually read "
                   "from the database. A connected graph is never unloaded, whatever its class. "
                   "Unloading loses nothing: the database holds every version, and a graph that "
                   "isn't loaded is read from it, more slowly."),
            effects=(
                Effect("read_speed", "Always: every read is fast.",
                       "Coldline: most reads come from the slower database.", "high", "better"),
                Effect("memory", "Coldline: memory is used only while a graph is in use.",
                       "Always: memory is held whether the graph is read or not.", "high", "better"),
                Effect("database_load", "Always and Standard: reads stay off the database.",
                       "Coldline: reads go to the database until the graph is loaded.", "medium",
                       "better"),
                Effect("cost", "Coldline: less memory, so a smaller graph store.",
                       "Always: memory for the graph at all times.", "medium", "better"),
            ),
            change_when=(
                "A graph people open first thing every day is slow to open: make it Always.",
                "A rarely used graph holds memory other graphs need: make it Coldline.",
                "Most graphs: keep Standard.",
            ),
            recommended=Recommendation(
                "standard", "Graphs people use stay fast, and ones nobody reads give their memory "
                            "back. Keep Always for the few that must open fast at any hour."),
            risk="medium",
            risk_note=("Too many Always graphs can leave no room to load others, whose readers then "
                       "wait on the database."),
            symptoms=("A graph is slow to open after a quiet spell", "Graph store memory alarms",
                      "A rarely used graph takes memory others need"),
            example=_ex_class,
            evidence=(
                "residency_plan.plan: idle eviction by class (standard_idle_secs, coldline_idle_secs), "
                "pressure eviction Coldline first, then Standard by oldest read; never an Always graph, "
                "a key the platform did not mint, a leased graph, or one with a pass or a window in "
                "flight. residency.mark: a person's read asks for the load of a Standard or Always "
                "graph, and of a Coldline graph with more entities than coldlineCanvasLoadAbove. Each "
                "graph's class is projection_state.residency; today a new graph takes the policy's "
                "defaultResidency (docs/versioning/17 §10 to §12)."),
            aliases=("residency", "class", "Always", "Standard", "Coldline", "keep loaded",
                     "eviction class", "defaultResidency"),
        ),
    ),
    Setting(
        key="residency.autoUnload",
        category="residency",
        label="Unload graphs automatically",
        kind="bool",
        default=Default(True, "GRAPHVER_EVICTION_ENABLED", "EVICTION_ENABLED"),
        scopes=_P,
        takes_effect=("capacity_pass", "The next memory check, within a minute."),
        section="unloading",
        requires=_RESIDENCY_ON,
        uses=("residency.standardIdleSecs", "residency.coldlineIdleSecs", "residency.unloadStartPct",
              "residency.unloadStopPct"),
        legacy=Legacy(residency_policy="evictionEnabled", platform_column="gv_eviction_enabled"),
        guidance=Guidance(
            summary="Whether the graph store unloads graphs on its own.",
            means=("On, each memory check unloads graphs left unread past their class's idle time, "
                   "and graphs on a node past its start mark until it is back at the stop mark. Off, "
                   "nothing is unloaded, not even to make room for a load: graphs not in memory load "
                   "only where there is room."),
            effects=(
                Effect("memory", "Unused graphs give their memory back.",
                       "Every loaded graph keeps its memory.", "high", "better"),
                Effect("availability", "Nodes are kept under their memory marks.",
                       "A node can fill up, and graphs waiting to load go on waiting.", "high",
                       "better"),
                Effect("read_speed", "A graph unloaded after a quiet spell is slower on its next "
                                     "read.",
                       "Loaded graphs stay fast.", "medium", "worse"),
            ),
            change_when=(
                "Graphs unload in the middle of the working day and people notice: raise the idle "
                "times or use Always, rather than turning this off.",
                "You are looking into unloads and want them to stop for a while: turn it off.",
            ),
            recommended=Recommendation(True, "Memory is what the graph store runs short of; "
                                             "unloading unused graphs keeps room for the rest."),
            risk="medium",
            risk_note=("Off, a full node stays full: new and unloaded graphs wait to load, and their "
                       "readers stay on the database."),
            symptoms=("Graph store memory alarms", "Graphs unload unexpectedly", "Graphs wait to load"),
            example=_ex_auto_unload,
            evidence=(
                "residency_plan._plan_master: idle and pressure eviction only with eviction_enabled, "
                "and _make_room returns False without it. The capacity pass evicts nothing in the 90 "
                "s grace after Graph residency is turned on (residency_policy.GRACE_SECS). With no "
                "policy read yet, an unreadable policy turns eviction off (residency_policy.resolve)."),
            aliases=("eviction", "auto unload", "unload", "GRAPHVER_EVICTION_ENABLED"),
        ),
    ),
    Setting(
        key="residency.standardIdleSecs",
        category="residency",
        label="Unload a Standard graph after",
        kind="seconds",
        default=Default(604_800, "GRAPHVER_STANDARD_IDLE_SECS", "STANDARD_IDLE_SECS"),
        scopes=_P,
        takes_effect=("capacity_pass", "The next memory check: graphs already unread longer are "
                                       "unloaded then."),
        section="unloading",
        range=(3_600, 31_536_000),
        requires=_RESIDENCY_ON,
        uses=("residency.autoUnload",),
        visual="idle_timeline",
        legacy=Legacy(residency_policy="standardIdleSecs", platform_column="gv_standard_idle_secs"),
        guidance=Guidance(
            summary="How long a Standard graph may go unread before it is unloaded.",
            means=("A Standard graph nobody has read for this long is unloaded at the next memory "
                   "check. Its next read comes from the database, more slowly, and loads it again. "
                   "Every read starts the clock again."),
            effects=(
                Effect("memory", "Graphs hold memory longer after their last read.",
                       "Unread graphs give memory back sooner.", "high", "worse"),
                Effect("read_speed", "Fewer graphs are slow to open after a quiet spell.",
                       "More graphs are slow to open after a quiet spell.", "medium", "better"),
                Effect("database_load", "Fewer first reads go to the database.",
                       "More first reads go to the database.", "low", "better"),
            ),
            change_when=(
                "Graphs used weekly are slow every Monday: raise it past a week.",
                "Memory is short and many graphs sit unread: lower it.",
            ),
            recommended=Recommendation(604_800, "A week covers graphs used every working day, and "
                                                "through a weekend."),
            risk="low",
            risk_note="Shorter means more graphs are slow on their first read after a quiet spell.",
            symptoms=("A graph is slow to open after a weekend", "Graph store memory alarms"),
            example=lambda values, facts: (
                f"A Standard graph nobody reads for "
                f"{_dur(_v(values, 'residency.standardIdleSecs'))} is unloaded; its next read comes "
                f"from the database and loads it again."),
            evidence=(
                "residency_plan._plan_master: idle_standard once now - last_read > "
                "standard_idle_secs; each process writes last_read_at once a minute. Every graph's "
                "idle clock starts when residency is turned on (docs/versioning/17 §10)."),
            aliases=("standard idle", "idle time", "unload after", "GRAPHVER_STANDARD_IDLE_SECS"),
        ),
    ),
    Setting(
        key="residency.coldlineIdleSecs",
        category="residency",
        label="Unload a Coldline graph after",
        kind="seconds",
        default=Default(3_600, "GRAPHVER_COLDLINE_IDLE_SECS", "COLDLINE_IDLE_SECS"),
        scopes=_P,
        takes_effect=("capacity_pass", "The next memory check: graphs already unread longer are "
                                       "unloaded then."),
        section="unloading",
        range=(300, 604_800),
        requires=_RESIDENCY_ON,
        uses=("residency.autoUnload",),
        caps=(Cap(setting="residency.standardIdleSecs", enforced=True, why="capped_by_setting"),),
        rules=(Rule("<=", "residency.standardIdleSecs",
                    message="A Coldline graph can't be kept longer than a Standard one."),),
        legacy=Legacy(residency_policy="coldlineIdleSecs", platform_column="gv_coldline_idle_secs"),
        guidance=Guidance(
            summary="How long a Coldline graph may go unread before it is unloaded.",
            means=("A Coldline graph nobody has read for this long is unloaded at the next memory "
                   "check. It can't be longer than the Standard time. No graph read within this "
                   "time is unloaded to make room for a load."),
            effects=(
                Effect("memory", "Coldline graphs hold memory longer after use.",
                       "Coldline graphs give memory back sooner.", "medium", "worse"),
                Effect("read_speed", "A Coldline graph stays fast for longer after it is used.",
                       "A Coldline graph goes back to the database sooner.", "medium", "better"),
            ),
            change_when=(
                "Coldline graphs unload between two uses in the same session: raise it.",
                "Memory is short and Coldline graphs linger: lower it.",
            ),
            recommended=Recommendation(3_600, "An hour covers a working session; then the graph's "
                                              "memory goes back."),
            risk="low",
            risk_note=("Very short, a Coldline graph can unload between two uses an hour apart and "
                       "load again each time."),
            symptoms=("A Coldline graph is slow every time it is opened", "Graph store memory alarms"),
            example=lambda values, facts: (
                f"A Coldline graph nobody reads for {_dur(_v(values, 'residency.coldlineIdleSecs'))} "
                f"is unloaded, and no graph read within that time is unloaded to make room for a "
                f"load."),
            evidence=(
                "residency_plan: idle_coldline past coldline_idle_secs; _make_room never picks a "
                "graph read within it. residency_policy.effective clamps it to the Standard idle "
                "time, and the routes refuse a longer one."),
            aliases=("coldline idle", "GRAPHVER_COLDLINE_IDLE_SECS"),
        ),
    ),
    Setting(
        key="residency.unloadStartPct",
        category="residency",
        label="Start unloading at",
        kind="percent",
        default=Default(80, "GRAPHVER_MASTER_HIGH_WATER_PCT", "MASTER_HIGH_WATER_PCT"),
        scopes=_P,
        takes_effect=("capacity_pass", "The next memory check, and the next load or copy that asks "
                                       "for room."),
        section="unloading",
        range=(50, 95),
        requires=_RESIDENCY_ON,
        visual="memory_marks",
        legacy=Legacy(residency_policy="highWaterPct", platform_column="gv_high_water_pct"),
        guidance=Guidance(
            summary=("The share of a node's memory at which graphs start to be unloaded; loads and "
                     "copies must fit under it."),
            means=("When a node uses this share of its memory or more, the next memory check unloads "
                   "graphs there, Coldline first, then Standard by oldest read, until it is back at "
                   "the stop mark. Loads and copies start only if they fit under this mark, so a load "
                   "never pushes a node into unloading what it just loaded."),
            effects=(
                Effect("availability", "Less room for a sudden peak above the mark.",
                       "More room for peaks.", "high", "worse"),
                Effect("memory", "Nodes run fuller before anything is unloaded.",
                       "Nodes keep more memory free.", "high", "worse"),
                Effect("read_speed", "More graphs stay loaded.",
                       "Graphs unload sooner when memory fills.", "medium", "better"),
                Effect("cost", "More of each node's memory holds graphs.",
                       "Part of each node's memory stays free as headroom.", "medium", "better"),
            ),
            change_when=(
                "Nodes alarm on memory before anything is unloaded: lower it.",
                "Nodes have plenty of memory and graphs still unload: raise it a little.",
            ),
            recommended=Recommendation(80, "Leaves a fifth of each node's memory for peaks the "
                                           "estimates don't see.", compute=_rec_start),
            risk="high",
            risk_note=("Above 90%, a node has little room for peaks and can run out of memory, which "
                       "can stop every graph on it."),
            symptoms=("Graph store memory alarms", "Graphs unload while people use them",
                      "Loads wait for room"),
            example=_ex_start,
            evidence=(
                "residency_plan: pressure eviction once used x 100 >= maxmemory x high_water_pct; "
                "admit() fits a load when used + reserved + needed <= maxmemory x high_water_pct / "
                "100, and residency.copy_room checks a copy the same way. A master without "
                "maxmemory is never under pressure."),
            aliases=("high water", "start mark", "memory pressure", "GRAPHVER_MASTER_HIGH_WATER_PCT"),
        ),
    ),
    Setting(
        key="residency.unloadStopPct",
        category="residency",
        label="Stop unloading at",
        kind="percent",
        default=Default(70, "GRAPHVER_MASTER_LOW_WATER_PCT", "MASTER_LOW_WATER_PCT"),
        scopes=_P,
        takes_effect=("capacity_pass", "The next memory check."),
        section="unloading",
        range=(30, 90),
        requires=_RESIDENCY_ON,
        uses=("residency.unloadStartPct",),
        rules=(Rule("<=", "residency.unloadStartPct", margin=5,
                    message="The stop mark must be at least 5 points under the start mark."),),
        legacy=Legacy(residency_policy="lowWaterPct", platform_column="gv_low_water_pct"),
        guidance=Guidance(
            summary=("The share of a node's memory down to which graphs are unloaded once the start "
                     "mark is passed."),
            means=("Once a node passes its start mark, graphs are unloaded until it is at or under "
                   "this share. The gap between the two marks is what one round frees: a wider gap "
                   "unloads more at once, and less often."),
            effects=(
                Effect("read_speed", "Fewer graphs are unloaded each round.",
                       "More graphs are unloaded each round, and are slower to open next.", "medium",
                       "better"),
                Effect("availability", "Nodes hover near the start mark and unload again soon.",
                       "After unloading, a node has room for loads.", "medium", "worse"),
            ),
            change_when=(
                "Graphs keep unloading and loading again on a busy node: lower it to widen the gap.",
                "Too many graphs unload at once when memory fills: raise it.",
            ),
            recommended=Recommendation(70, "Ten points under the start mark: one round frees room "
                                           "for a load without unloading graphs people use.",
                                       compute=_rec_stop),
            risk="medium",
            risk_note="A narrow gap unloads a little, often; a very wide one unloads many graphs at once.",
            symptoms=("Graphs keep unloading and loading", "Many graphs unload at once"),
            example=lambda values, facts: (
                f"A node past {_v(values, 'residency.unloadStartPct')}% of its memory unloads graphs "
                f"until it is at {_v(values, 'residency.unloadStopPct')}% or less."),
            evidence=(
                "residency_plan._plan_master: to_free = used - maxmemory x low_water_pct / 100. "
                "residency_policy.effective keeps it at least 5 points under the start mark, and the "
                "routes refuse a narrower gap."),
            aliases=("low water", "stop mark", "GRAPHVER_MASTER_LOW_WATER_PCT"),
        ),
    ),
    Setting(
        key="residency.loadMarginPct",
        category="residency",
        label="Headroom a load needs",
        kind="percent",
        default=Default(130, "GRAPHVER_LOAD_MARGIN_PCT", "LOAD_MARGIN_PCT"),
        scopes=_P,
        takes_effect=("next_load", "The next load that asks for room, at the next memory check."),
        section="loading",
        range=(100, 300),
        requires=_RESIDENCY_ON,
        uses=("residency.unloadStartPct", "residency.bytesPerEntity"),
        legacy=Legacy(residency_policy="loadMarginPct", platform_column="gv_load_margin_pct"),
        guidance=Guidance(
            summary="The headroom a load asks for over the graph's size.",
            means=("A graph is loaded only when its node has the graph's size times this share free "
                   "under the start mark. The extra covers what the size estimate misses and what "
                   "the load itself uses while it runs."),
            effects=(
                Effect("memory", "Loads wait for more room, so nodes stay further from their limit.",
                       "Loads start with less room to spare.", "high", "better"),
                Effect("read_speed", "Graphs wait longer to load, read from the database meanwhile.",
                       "Graphs load sooner.", "medium", "worse"),
            ),
            change_when=(
                "A node ran short of memory right after loading a graph: raise it.",
                "Loads wait though nodes clearly have room: lower it a little.",
            ),
            recommended=Recommendation(130, "Thirty percent over the measured or estimated size "
                                            "covers the load's own working memory."),
            risk="medium",
            risk_note=("At 100%, a graph larger than its estimate can take its node past the start "
                       "mark as it loads."),
            symptoms=("Loads wait for room", "A node ran short of memory after a load"),
            example=lambda values, facts: (
                f"Loading a graph of 1 GB asks for "
                f"{_size(_GB * int(_v(values, 'residency.loadMarginPct')) // 100)} free under its "
                f"node's start mark."),
            evidence=(
                "residency_plan.need: estimate x load_margin_pct / 100; admission counts it for "
                "every load and full projection in flight on the master (docs/versioning/17 §12)."),
            aliases=("load margin", "headroom", "GRAPHVER_LOAD_MARGIN_PCT"),
        ),
    ),
    Setting(
        key="residency.bytesPerEntity",
        category="residency",
        label="Memory per item, estimated",
        kind="bytes",
        default=Default(550, "GRAPHVER_BYTES_PER_ENTITY", "BYTES_PER_ENTITY"),
        scopes=_P,
        takes_effect=("capacity_pass", "The next memory check: the estimate of every graph not yet "
                                       "measured changes at once."),
        section="loading",
        range=(100, 10_000),
        requires=_RESIDENCY_ON,
        legacy=Legacy(residency_policy="bytesPerEntity", platform_column="gv_bytes_per_entity"),
        guidance=Guidance(
            summary="The memory one item is estimated to take, for a graph not measured yet.",
            means=("A graph is measured once it is in memory. Until then its size is estimated as "
                   "its items, nodes and relationships, times this. The estimate decides whether a "
                   "load fits, how much room an update under way may still take, and how large a "
                   "Coldline graph is."),
            effects=(
                Effect("memory", "Estimates are larger, so loads wait for more room.",
                       "Estimates are smaller, and a load can take more memory than planned.",
                       "medium", "better"),
                Effect("read_speed", "Graphs not measured yet may wait longer to load.",
                       "They load sooner.", "low", "worse"),
            ),
            change_when=(
                "Measured sizes run well above the estimates for your data: raise it toward what you "
                "see.",
                "Loads wait though measured graphs are much smaller than estimated: lower it.",
            ),
            recommended=Recommendation(550, "Measured: a graph of 1 million nodes and 1 million "
                                             "edges took 1.05 GB in the graph store, about 525 "
                                             "bytes an item."),
            risk="low",
            risk_note="Only graphs never measured use it; once a graph is in memory its real size is used.",
            symptoms=("Loads wait although there's room", "A node ran short of memory after a load"),
            example=lambda values, facts: (
                f"A graph of 1 million items not measured yet is estimated at "
                f"{_size(int(_v(values, 'residency.bytesPerEntity')) * 1_000_000)}."),
            evidence=(
                "residency_plan.Graph.bytes: the measured size_bytes, else entities x "
                "bytes_per_entity; a window in flight may add window_rows x bytes_per_entity. "
                "Measured (docs/versioning/09 §2): 1M + 1M took 1.05 GB (GRAPH.MEMORY USAGE)."),
            aliases=("bytes per entity", "size estimate", "GRAPHVER_BYTES_PER_ENTITY"),
        ),
    ),
    Setting(
        key="residency.coldlineLoadAbove",
        category="residency",
        label="Load a Coldline graph on opening above",
        kind="count",
        default=Default(500_000, "GRAPHVER_COLDLINE_CANVAS_LOAD_ABOVE", "COLDLINE_CANVAS_LOAD_ABOVE"),
        scopes=_P,
        takes_effect=("next_read", "The next read of a Coldline graph that isn't in memory."),
        section="loading",
        range=(0, 100_000_000),
        unit="items",
        requires=_RESIDENCY_ON,
        uses=("residency.bytesPerEntity",),
        legacy=Legacy(residency_policy="coldlineCanvasLoadAbove",
                      platform_column="gv_coldline_canvas_load_above"),
        guidance=Guidance(
            summary="How large a Coldline graph must be for opening it on a canvas to load it.",
            means=("Opening a Coldline graph that isn't in memory loads it only when the graph has "
                   "more items than this; a smaller one is just read from the database. Work only "
                   "the graph store can do, such as a deep search, loads any Coldline graph."),
            effects=(
                Effect("memory", "Fewer Coldline graphs load when they are opened.",
                       "More Coldline graphs load when they are opened.", "medium", "better"),
                Effect("read_speed", "Larger Coldline graphs are read from the slower database.",
                       "More Coldline graphs load and get fast.", "medium", "worse"),
                Effect("database_load", "More reads of Coldline graphs go to the database.",
                       "Fewer reads of Coldline graphs go to the database.", "low", "worse"),
            ),
            change_when=(
                "Opening a mid-sized Coldline graph stays slow: lower it.",
                "Opening Coldline graphs fills memory: raise it.",
            ),
            recommended=Recommendation(500_000, "Smaller Coldline graphs are read from the database "
                                                "rather than loaded for one look."),
            risk="low",
            risk_note="At 0, every Coldline graph a canvas opens is loaded, which undoes what Coldline saves.",
            symptoms=("A Coldline graph is slow to open", "Opening Coldline graphs fills memory"),
            example=lambda values, facts: (
                f"Opening a Coldline graph of more than "
                f"{_v(values, 'residency.coldlineLoadAbove'):,} items on a canvas loads it; a "
                f"smaller one is read from the database."),
            evidence=(
                "residency.mark: a person's read of a Coldline graph out of FalkorDB asks for its "
                "load only when its entities (counted per head, else size_bytes / bytes_per_entity) "
                "exceed coldlineCanvasLoadAbove; deep search, node degrees and native queries ask "
                "for any graph's load, answering 503 graph_loading meanwhile."),
            aliases=("coldline canvas load", "load on read", "GRAPHVER_COLDLINE_CANVAS_LOAD_ABOVE"),
        ),
    ),
    Setting(
        key="residency.capacityIntervalSecs",
        category="residency",
        label="Check memory every",
        kind="seconds",
        default=Default(60, "GRAPHVER_CAPACITY_SECS", "CAPACITY_SECS"),
        scopes=_P,
        takes_effect=("capacity_pass", "After the memory check under way: the wait before the next "
                                       "one uses the new interval."),
        section="loop",
        range=(15, 600),
        requires=_RESIDENCY_ON,
        legacy=Legacy(residency_policy="capacityIntervalSecs", platform_column="gv_capacity_interval_secs"),
        guidance=Guidance(
            summary="How often each node's memory is checked, to unload and load graphs.",
            means=("Each memory check reads every node's memory and every graph's last read, "
                   "unloads what is idle or over the marks, and starts the loads that fit. A graph "
                   "waiting to load is tried again at each check, and work that needs a graph still "
                   "loading asks people to retry after this long."),
            effects=(
                Effect("read_speed", "Graphs waiting to load wait longer between tries.",
                       "Waiting graphs load sooner.", "medium", "worse"),
                Effect("memory", "A node over its start mark is noticed later.",
                       "Memory pressure is acted on sooner.", "medium", "worse"),
                Effect("database_load", "Fewer checks, each reading every graph's state.",
                       "More frequent checks.", "low", "better"),
            ),
            change_when=(
                "Graphs take a minute or more to start loading after they're asked for: lower it.",
                "The checks themselves add noticeable load on a large platform: raise it.",
            ),
            recommended=Recommendation(60, "Once a minute keeps loads moving and memory in check at "
                                           "little cost."),
            risk="low",
            risk_note=("Very short checks read every graph's state often; very long ones leave memory "
                       "pressure and waiting loads unattended."),
            symptoms=("Graphs take a minute to start loading", "Memory pressure is noticed late"),
            example=lambda values, facts: (
                f"Every {_dur(_v(values, 'residency.capacityIntervalSecs')).removeprefix('1 ')}, "
                f"each node's memory is checked: idle graphs are unloaded and waiting ones loaded "
                f"where they fit."),
            evidence=(
                "worker._capacity_loop waits capacity_interval_secs between passes, read after each "
                "pass; residency.READING gives it as Retry-After with 503 graph_loading."),
            aliases=("capacity interval", "capacity loop", "memory check", "GRAPHVER_CAPACITY_SECS"),
        ),
    ),
)

# ---------------------------------------------------------------------------------------------
# Database reads
# ---------------------------------------------------------------------------------------------

_DATABASE = (
    Setting(
        key="database.readTimeoutMs",
        category="database",
        label="Longest read",
        kind="ms",
        default=Default(15_000, "GRAPHVER_READ_STATEMENT_TIMEOUT_MS", "READ_STATEMENT_TIMEOUT_MS"),
        scopes=_P,
        takes_effect=("next_read", "The next read from the database."),
        section="limits",
        range=(1_000, 120_000),
        legacy=Legacy(build_policy="pgStatementTimeoutMs"),
        guidance=Guidance(
            summary="The longest one read of a graph from the database may run.",
            means=("When the graph store holds no version of a graph, or Always the latest is "
                   "catching up, reads come from the database, which puts the graph together for "
                   "each one. A read that runs longer than this is stopped and the reader is asked "
                   "to retry, so a slow read can't hold a connection others need."),
            effects=(
                Effect("availability", "Slow reads are allowed to finish.",
                       "Slow reads are stopped sooner and retried.", "medium", "better"),
                Effect("database_load", "A slow read can hold a database connection longer.",
                       "Connections are freed sooner.", "medium", "worse"),
            ),
            change_when=(
                "Large graphs read from the database fail and ask to try again: raise it.",
                "Slow reads pile up on the database: lower it.",
            ),
            recommended=Recommendation(15_000, "Fifteen seconds lets large reads finish, and stops "
                                               "ones that would hold a connection for minutes."),
            risk="low",
            risk_note=("Very short, large graphs can't be read from the database at all; very long, "
                       "slow reads crowd it."),
            symptoms=("Reads fail and ask to try again while data loads",
                      "The database is overloaded during reads"),
            example=lambda values, facts: (
                f"While a graph is read from the database, a read running over "
                f"{_ms(_v(values, 'database.readTimeoutMs'))} is stopped and the reader asked to "
                f"retry."),
            evidence=(
                "db.bounded_read_sessions sets statement_timeout to pgStatementTimeoutMs on each "
                "session; a cancelled read answers 503 graph_read_busy, retryable, counted in "
                "graphver_pg_read_timeouts_total."),
            aliases=("statement timeout", "read timeout", "GRAPHVER_READ_STATEMENT_TIMEOUT_MS"),
        ),
    ),
    Setting(
        key="database.readsPerGraph",
        category="database",
        label="Reads at once per graph",
        kind="count",
        default=Default(4, "GRAPHVER_PG_READS_PER_GRAPH", "PG_READS_PER_GRAPH"),
        scopes=_P,
        takes_effect=("next_read", "The next read from the database."),
        section="limits",
        range=(1, 64),
        unit="reads",
        caps=(Cap(setting="database.readsPerProcess", enforced=True, why="capped_by_setting"),),
        rules=(Rule("<=", "database.readsPerProcess",
                    message="Reads at once per graph can't be more than per process."),),
        legacy=Legacy(build_policy="pgReadsPerGraph"),
        guidance=Guidance(
            summary="How many reads of one graph from the database each process runs at once.",
            means=("Each read of a graph from the database takes a place; past this many, more wait "
                   "briefly, then are asked to retry. It keeps one large graph from taking all the "
                   "database reads a process allows."),
            effects=(
                Effect("read_speed", "More readers of one graph are served at once from the database.",
                       "More readers of one graph wait or retry.", "medium", "better"),
                Effect("availability", "Fewer reads of a busy graph are asked to retry.",
                       "More reads of a busy graph are asked to retry.", "medium", "better"),
                Effect("database_load", "One graph can put more load on the database.",
                       "One graph's load on the database is held tighter.", "medium", "worse"),
            ),
            change_when=(
                "Readers of one large graph are asked to retry while it loads: raise it, within "
                "Reads at once per process.",
                "One graph's reads slow every other graph: lower it.",
            ),
            recommended=Recommendation(4, "Half of a process's database reads: one graph never "
                                          "takes them all.", compute=_rec_reads_graph),
            risk="low",
            risk_note="It is capped at Reads at once per process.",
            symptoms=("Reads are asked to retry while data loads",
                      "One graph's reads slow every other graph"),
            example=lambda values, facts: (
                f"Each process runs up to {_v(values, 'database.readsPerGraph')} reads of one graph "
                f"from the database at once, and {_v(values, 'database.readsPerProcess')} in all; "
                f"more wait briefly, then are asked to retry."),
            evidence=(
                "ProviderManager.pg_read_slot: a place among the process's reads (pgReadsPerProcess) "
                "and the graph's (pgReadsPerGraph); past them ProviderBusy, 429 with Retry-After, "
                "counted in graphver_pg_read_slots_shed_total. build_policy.effective clamps it to "
                "pgReadsPerProcess. Measured (docs/versioning/09 §2): with 200 readers, Always the "
                "latest shed 171 reads, each read on a retry."),
            aliases=("reads per graph", "read slots", "GRAPHVER_PG_READS_PER_GRAPH"),
        ),
    ),
    Setting(
        key="database.readsPerProcess",
        category="database",
        label="Reads at once per process",
        kind="count",
        default=Default(8, "GRAPHVER_PG_READS_PER_PROCESS", "PG_READS_PER_PROCESS"),
        scopes=_P,
        takes_effect=("next_read", "The next read from the database."),
        section="limits",
        range=(1, 64),
        unit="reads",
        legacy=Legacy(build_policy="pgReadsPerProcess"),
        guidance=Guidance(
            summary="How many reads from the database each process runs at once, across all graphs.",
            means=("Reads of graphs from the database take a connection each. This caps them in each "
                   "process, so they never take the whole connection pool, which writes and other "
                   "work need too."),
            effects=(
                Effect("database_load", "More reads run on the database at once.",
                       "Fewer reads run on the database at once.", "high", "worse"),
                Effect("read_speed", "More reads from the database are served at once.",
                       "More of them wait or retry.", "medium", "better"),
                Effect("availability", "Writes and other work can be left without a connection.",
                       "Connections stay free for writes and other work.", "medium", "worse"),
            ),
            change_when=(
                "Reads from the database are asked to retry while the database has capacity: raise "
                "it, keeping it under the connection pool.",
                "The database runs short of connections during big loads: lower it.",
            ),
            recommended=Recommendation(8, "Two under the default connection pool of 10, so writes "
                                          "always find a connection.", compute=_rec_reads_process),
            risk="medium",
            risk_note=("At or above the connection pool, reads can take every connection, and writes "
                       "then wait."),
            symptoms=("The database runs out of connections", "Reads are asked to retry while data loads"),
            example=lambda values, facts: (
                f"Each process runs up to {_v(values, 'database.readsPerProcess')} reads from the "
                f"database at once"
                + (f", of the {facts['poolSize']} connections it keeps."
                   if facts and facts.get("poolSize") else ", across all graphs.")),
            evidence=(
                "ProviderManager.pg_read_slot, per process; the store's pool is GRAPHVER_POOL_SIZE "
                "(10) plus GRAPHVER_POOL_MAX_OVERFLOW (5) a process. Measured (docs/versioning/09 "
                "§2): the first run at 200 readers, before the route cache, ran Postgres out of "
                "connections."),
            aliases=("reads per process", "connection pool", "GRAPHVER_PG_READS_PER_PROCESS"),
        ),
    ),
)

# ---------------------------------------------------------------------------------------------
# Drafts & history
# ---------------------------------------------------------------------------------------------

_DRAFTS = (
    Setting(
        key="drafts.keepClosedDays",
        category="drafts",
        label="Keep closed drafts' changes for",
        kind="days_or_forever",
        default=Default(30, "GRAPHVER_DRAFT_RETENTION_DAYS", "DRAFT_RETENTION_DAYS"),
        scopes=_PW,
        takes_effect=("hourly_sweep", "The next sweep, within the hour: closed drafts past the new "
                                      "time have their changes removed then."),
        audience="business",
        question="How long should finished drafts keep their changes?",
        section="lifecycle",
        range=(1, 3_650),
        limitable=("range", "lock"),
        uses=("drafts.idleCloseDays",),
        unreadable="skip",
        visual="retention_timeline",
        legacy=Legacy(platform_column="gv_draft_retention_days", encode="zero_is_forever"),
        guidance=Guidance(
            summary="How long a merged or abandoned draft keeps its changes before they are removed.",
            means=("A closed draft's changes take space in the database. After this long they are "
                   "removed, and the draft's record stays: its name, owner, commits and review. A "
                   "merged draft's changes are in the published graph, so nothing published is "
                   "lost. Forever keeps them."),
            effects=(
                Effect("availability", "Closed drafts' changes can be looked at for longer.",
                       "Old closed drafts' changes can no longer be looked at.", "medium", "better"),
                Effect("cost", "Closed drafts' changes take database space for longer.",
                       "Database space is freed sooner.", "medium", "worse"),
            ),
            change_when=(
                "The database keeps growing with old drafts: shorten it.",
                "People need to look at closed drafts' changes months later: lengthen it, or keep "
                "them forever.",
            ),
            recommended=Recommendation(30, "A month to look back at a closed draft; after that its "
                                           "changes rarely matter, and a merged one's are in the "
                                           "published graph."),
            risk="medium",
            risk_note=("Shortening it removes the changes of drafts closed longer ago at the next "
                       "sweep, and that can't be undone."),
            symptoms=("The database keeps growing", "Old drafts' changes are gone"),
            example=lambda values, facts: (
                "Closed drafts keep their changes for good."
                if _v(values, "drafts.keepClosedDays") == "forever" else
                f"A draft merged or abandoned more than "
                f"{_days(_v(values, 'drafts.keepClosedDays'))} ago has its changes removed at the "
                f"next hourly sweep; its record stays."),
            evidence=(
                "service.prune_closed_drafts, in the worker's sweep (GRAPHVER_DRAFT_SWEEP_SECS, "
                "hourly): drafts closed longer ago than the window, kept while a live review, a "
                "pending or running job, or a deleted or frozen graph may still need them; removed in "
                "windows for at most 5 minutes a sweep (DRAFT_PRUNE_PASS_SECS). A read of a pruned "
                "draft's changes is 410 draft_pruned. When the value can't be read, the sweep removes "
                "nothing (draft_retention.retention_days)."),
            aliases=("draft retention", "prune drafts", "GRAPHVER_DRAFT_RETENTION_DAYS"),
        ),
    ),
    Setting(
        key="drafts.idleCloseDays",
        category="drafts",
        label="Close idle drafts after",
        kind="days_or_forever",
        default=Default(30, "GRAPHVER_DRAFT_TTL_DAYS", "DRAFT_TTL_DAYS"),
        scopes=_PW,
        takes_effect=("hourly_sweep", "The next sweep, within the hour: open drafts idle longer than "
                                      "the new time are closed then."),
        audience="business",
        question="When should drafts nobody works on be closed?",
        section="lifecycle",
        range=(1, 3_650),
        limitable=("range", "lock"),
        unreadable="skip",
        guidance=Guidance(
            summary="How long a draft may go unsaved before it is closed.",
            means=("A draft nobody has saved to, published or changed for this long is closed, as if "
                   "abandoned. A draft with an open review or edits not yet saved is kept, and so is "
                   "one on a frozen or deleted graph. Forever never closes idle drafts. A closed "
                   "draft's changes then follow Keep closed drafts' changes for."),
            effects=(
                Effect("availability", "People away for a while find their drafts still open.",
                       "A draft left for a while may be closed before its owner returns.", "medium",
                       "better"),
                Effect("cost", "Forgotten drafts stay open longer, holding their changes.",
                       "Forgotten drafts close sooner.", "low", "worse"),
            ),
            change_when=(
                "People lose drafts while they are away: lengthen it.",
                "Abandoned drafts pile up: shorten it.",
            ),
            recommended=Recommendation(30, "A month covers holidays; a draft untouched for longer is "
                                           "rarely picked up again."),
            risk="low",
            risk_note="Closing is automatic: nobody is asked first.",
            symptoms=("My draft was closed while I was away", "Abandoned drafts pile up"),
            example=lambda values, facts: (
                "Drafts are never closed for being idle."
                if _v(values, "drafts.idleCloseDays") == "forever" else
                f"A draft nobody saves to for {_days(_v(values, 'drafts.idleCloseDays'))} is closed, "
                f"unless it has an open review or edits not yet saved."),
            evidence=(
                "service.sweep_idle_drafts, in the worker's hourly sweep: open drafts whose "
                "updated_at is older than the TTL, with no live PR, no staged changes, on a live "
                "graph not unfrozen within the TTL, become abandoned. 0 today would close every idle "
                "draft at the next sweep, so the app offers forever instead."),
            aliases=("draft ttl", "idle drafts", "auto abandon", "GRAPHVER_DRAFT_TTL_DAYS"),
        ),
    ),
    Setting(
        key="drafts.defaultVisibility",
        category="drafts",
        label="New drafts start",
        kind="choice",
        default=Default("public"),
        scopes=_PWG,
        takes_effect=("next_draft", "The next draft created. Existing drafts keep their level."),
        audience="business",
        question="Who should see a new draft by default?",
        section="levels",
        choices=(
            Choice(id="public", title="Public", short="Everyone who can read the data",
                   promise=("Everyone who can read the data source sees the draft, and everyone who "
                            "can change it may edit it."),
                   effects={"availability": ("better", "Colleagues can find and review work in "
                                                       "progress.")}),
            Choice(id="private", title="Private", short="Owner, members and reviewers",
                   promise=("Only its owner, the members they add and the reviewers of its review see "
                            "the draft."),
                   effects={"availability": ("worse", "Only the people the owner adds see it.")}),
        ),
        limitable=("allowed", "lock"),
        uses=("drafts.levels",),
        freshness="strict",
        legacy=Legacy(workspace_column="draft_default_visibility",
                      data_source_column="draft_default_visibility"),
        guidance=Guidance(
            summary="The level a new draft starts at when its creator doesn't choose one.",
            means=("Public drafts are seen by everyone who can read the data, and edited by everyone "
                   "who can change it. Private drafts are seen only by their owner, their members "
                   "and their reviewers. When only one level is allowed, new drafts start at that "
                   "level, whatever this says."),
            effects=(
                Effect("availability", "Public: colleagues can find and review work in progress.",
                       "Private: only the owner and the people they add see it.", "medium", "better"),
            ),
            change_when=(
                "Work in progress must not be seen widely until it is ready: choose Private.",
                "Teams review each other's drafts as they go: keep Public.",
            ),
            recommended=Recommendation("public", "Colleagues see what is changing and can help review "
                                                 "it; anyone can still choose Private for a draft."),
            risk="low",
            risk_note="Existing drafts keep their level.",
            symptoms=("New drafts are visible to everyone", "Colleagues can't see my draft"),
            example=lambda values, facts: (
                "A new draft starts private: only its owner, its members and its reviewers see it."
                if _v(values, "drafts.defaultVisibility") == "private" else
                "A new draft starts public: everyone who can read the data source sees it."),
            evidence=(
                "drafts_policy.resolve: the data source's value, else the workspace's, else public; "
                "a levels value other than any forces it (derived). Read when a draft is created, "
                "never cached (docs/versioning/03 §3.15)."),
            aliases=("draft visibility", "private drafts", "public drafts"),
        ),
    ),
    Setting(
        key="drafts.levels",
        category="drafts",
        label="Draft levels allowed",
        kind="choice",
        default=Default("any"),
        scopes=_PWG,
        takes_effect=("next_draft", "The next draft created or moved to another level. Existing "
                                    "drafts keep theirs."),
        audience="business",
        question="Which kinds of drafts may people make?",
        section="levels",
        choices=(
            Choice(id="any", title="Public or private", short="Either",
                   promise="People choose the level of each draft.",
                   effects={"availability": ("same", "Each draft is as open as its owner chooses.")}),
            Choice(id="public_only", title="Public only", short="Public only",
                   promise="Every draft is public: everyone who can read the data sees it.",
                   effects={"availability": ("better", "Every draft can be seen and reviewed.")}),
            Choice(id="private_only", title="Private only", short="Private only",
                   promise="Every draft is private: only its owner, members and reviewers see it.",
                   effects={"availability": ("worse", "Drafts are seen only by the people their "
                                                      "owners add.")}),
        ),
        limitable=("allowed", "lock"),
        freshness="strict",
        legacy=Legacy(workspace_column="draft_levels", data_source_column="draft_levels"),
        guidance=Guidance(
            summary="Which levels a draft may have: public, private, or either.",
            means=("With one level allowed, every new draft takes it, and no draft can be moved to "
                   "the other. Drafts made before keep the level they have."),
            effects=(
                Effect("availability", "Public only: every draft can be seen and reviewed by "
                                       "colleagues.",
                       "Private only: drafts are seen only by the people their owners add.",
                       "medium", "better"),
            ),
            change_when=(
                "A rule says changes must be visible while they are made: choose Public only.",
                "Drafts may hold sensitive data until they are published: choose Private only.",
            ),
            recommended=Recommendation("any", "People pick the level that suits each draft; allow "
                                              "one level only where a rule requires it."),
            risk="low",
            risk_note="Existing drafts keep their level; only new drafts and level changes are refused.",
            symptoms=("People can't make private drafts", "People can't make public drafts"),
            example=lambda values, facts: {
                "public_only": "Every new draft is public, and no draft can be made private.",
                "private_only": "Every new draft is private, and no draft can be made public.",
            }.get(_v(values, "drafts.levels"), "People choose public or private for each draft."),
            evidence=(
                "drafts_policy.EffectiveDraftsPolicy.allows; a level ruled out is 409 "
                "private_drafts_disabled or public_drafts_disabled. Read when a draft is created or "
                "changes level, never cached (docs/versioning/03 §3.15)."),
            aliases=("draft levels", "private only", "public only"),
        ),
    ),
    Setting(
        key="drafts.selfApproval",
        category="drafts",
        label="People may approve their own reviews",
        kind="bool",
        default=Default(True),
        scopes=_PWG,
        takes_effect=("next_review_action", "The next approval."),
        audience="business",
        question="May people approve their own changes?",
        section="reviews",
        limitable=("lock",),
        freshness="strict",
        legacy=Legacy(workspace_column="review_self_approval", data_source_column="review_self_approval"),
        guidance=Guidance(
            summary="Whether the person who opened a review may approve it.",
            means=("Off, someone other than the person who opened a review must approve it. The "
                   "draft's owner, when someone else opened the review, may approve it either way."),
            effects=(
                Effect("consistency", "Changes can be approved by the person who made them.",
                       "Every change is checked by a second person.", "medium", "worse"),
                Effect("update_speed", "Changes are approved without waiting for a colleague.",
                       "Approvals wait for a second person.", "medium", "better"),
            ),
            change_when=(
                "A rule says a second person must check every change: turn it off.",
                "Small teams approve their own small fixes: keep it on.",
            ),
            recommended=Recommendation(True, "Nobody is blocked waiting for a reviewer; turn it off "
                                             "where a second person must check every change."),
            risk="low",
            risk_note="Off, a team of one can't get a review approved.",
            symptoms=("People approve their own changes", "A review can't be approved by its author"),
            example=lambda values, facts: (
                "Whoever opens a review may approve it." if _v(values, "drafts.selfApproval") else
                "Someone other than whoever opened a review must approve it."),
            evidence=(
                "service.approve_pr raises SelfReview (403 self_review) when self_approval is off and "
                "the approver opened the PR; the draft's owner approves either way."),
            aliases=("self approval", "four eyes", "self review"),
        ),
    ),
    Setting(
        key="drafts.selfMerge",
        category="drafts",
        label="People may merge their own reviews",
        kind="bool",
        default=Default(True),
        scopes=_PWG,
        takes_effect=("next_review_action", "The next merge or publish."),
        audience="business",
        question="May people publish their own changes without someone else merging them?",
        section="reviews",
        limitable=("lock",),
        freshness="strict",
        legacy=Legacy(workspace_column="review_self_merge", data_source_column="review_self_merge"),
        guidance=Guidance(
            summary="Whether the person who opened a review may merge it, and publish drafts directly.",
            means=("Off, someone other than the person who opened a review merges it, and no draft "
                   "is published directly: every change goes through a review that someone else "
                   "merges."),
            effects=(
                Effect("consistency", "People can publish their own changes.",
                       "Every change is merged by a second person.", "high", "worse"),
                Effect("update_speed", "Changes are published without waiting for a colleague.",
                       "Every change waits for a second person to merge it.", "medium", "better"),
            ),
            change_when=(
                "A rule says nobody publishes their own changes: turn it off.",
                "Before turning it off, make sure every team has a second person who may merge.",
            ),
            recommended=Recommendation(True, "People publish their own changes once they are ready; "
                                             "turn it off where publishing must be someone else's "
                                             "call."),
            risk="medium",
            risk_note=("Off, direct publishing is refused for everyone, so a change lands only "
                       "through a review someone else merges."),
            symptoms=("People publish without review", "Publishing says a review is required"),
            example=lambda values, facts: (
                "Whoever opens a review may merge it, and people may publish drafts directly."
                if _v(values, "drafts.selfMerge") else
                "Someone other than whoever opened a review merges it, and drafts can't be "
                "published directly."),
            evidence=(
                "service.publish raises ReviewRequired (409 review_required) when self_merge is off; "
                "merge_mr and merge_pr raise SelfMerge (403 self_merge) for the opener."),
            aliases=("self merge", "direct publish", "review required"),
        ),
    ),
    Setting(
        key="forks.maxPerGraph",
        category="drafts",
        label="Forks per graph",
        kind="count",
        default=Default(10, "GRAPHVER_MAX_FORKS_PER_GRAPH", "MAX_FORKS_PER_GRAPH"),
        scopes=_PWG,
        takes_effect=("next_fork", "The next fork. Existing forks are kept, even past the new number."),
        audience="business",
        question="How many forks may one graph have?",
        section="forks",
        range=(0, 1_000),
        unit="forks",
        limitable=("range", "lock"),
        guidance=Guidance(
            summary="How many live forks one graph may have.",
            means=("A fork is a separate copy of a graph to work in, which reads through the "
                   "original. Forks take no copy of their own in the graph store, but the processes "
                   "that read one hold its changes in memory, and its rows are kept in the database. "
                   "One fork past this number is refused; forks in the trash don't count. 0 turns "
                   "forking off."),
            effects=(
                Effect("memory", "More forks' changes are held in memory by the processes that read "
                                 "them.",
                       "Fewer.", "low", "worse"),
                Effect("cost", "More forks' rows in the database.", "Fewer.", "low", "worse"),
            ),
            change_when=(
                "Teams need more forks of one graph at once: raise it.",
                "Forks pile up unused: lower it.",
            ),
            recommended=Recommendation(10, "Room for several teams to work on one graph at once; "
                                           "more usually means forks nobody uses."),
            risk="low",
            risk_note="Lowering it never removes forks; it only refuses new ones.",
            symptoms=("Forking fails with a limit", "Forks pile up"),
            example=lambda values, facts: (
                f"Each graph may have {_v(values, 'forks.maxPerGraph')} live forks; one more is "
                f"refused. Forks in the trash don't count."),
            evidence=(
                "service._fork_slot and fork_preflight: live_forks >= MAX_FORKS_PER_GRAPH raises "
                "ForkLimit (409 fork_limit). A fork has no FalkorDB key of its own, so this bounds "
                "the readers' patch sets and the forks' rows (docs/versioning/17 §6)."),
            aliases=("fork limit", "forks per graph", "GRAPHVER_MAX_FORKS_PER_GRAPH"),
        ),
    ),
    Setting(
        key="trash.restoreDays",
        category="drafts",
        label="Restore deleted data sources for",
        kind="days",
        default=Default(30, "GRAPHVER_PURGE_GRACE_DAYS", "PURGE_GRACE_DAYS"),
        scopes=_PW,
        takes_effect=("reaper_pass", "The next trash check, within 15 minutes: data sources deleted "
                                     "longer ago than the new window are removed for good then."),
        audience="business",
        question="How long can a deleted data source be brought back?",
        section="trash",
        range=(1, 3_650),
        limitable=("range", "lock"),
        unreadable="skip",
        guidance=Guidance(
            summary=("How long a deleted data source stays in the trash, restorable, before it is "
                     "removed for good."),
            means=("Deleting a data source moves it, with its graph and history, to the trash, where "
                   "it can be restored in one step. After this many days it is removed for good. "
                   "Forks in the trash follow the same window."),
            effects=(
                Effect("availability", "A mistaken delete can be undone for longer.",
                       "Less time to undo a mistaken delete.", "high", "better"),
                Effect("cost", "Deleted data takes database space for longer.",
                       "Space comes back sooner.", "medium", "worse"),
            ),
            change_when=(
                "Deleted data must go sooner, for a retention rule or for space: shorten it.",
                "Deletes are found to be mistakes weeks later: lengthen it.",
            ),
            recommended=Recommendation(30, "A month to notice and undo a mistaken delete."),
            risk="high",
            risk_note=("Shortening it removes, at the next check, every data source deleted longer "
                       "ago than the new window, and that can't be undone."),
            symptoms=("A deleted data source can't be restored", "Deleted data still takes space"),
            example=lambda values, facts: (
                f"A deleted data source can be restored for {_days(_v(values, 'trash.restoreDays'))}; "
                f"then it and its history are removed for good."),
            evidence=(
                "purge_worker.Reaper.run_once, every GRAPHVER_REAP_POLL_SECS (900 s): tombstones older "
                "than PURGE_GRACE_DAYS have their purge queued; the tombstone's age is the schedule. "
                "A fork list's purge_after uses the same window."),
            aliases=("trash", "undo window", "purge grace", "restore", "GRAPHVER_PURGE_GRACE_DAYS"),
        ),
    ),
)

# ---------------------------------------------------------------------------------------------
# Imports
# ---------------------------------------------------------------------------------------------

_IMPORTS = (
    Setting(
        key="imports.identifier",
        category="imports",
        label="Match rows by",
        kind="identifier",
        default=Default("entity_id", "GRAPHVER_IMPORT_IDENTIFIER", "IMPORT_IDENTIFIER"),
        scopes=_PWG,
        takes_effect=_NEXT_IMPORT,
        audience="business",
        question="How should imports find the items that already exist?",
        section="matching",
        limitable=("lock",),
        uses=("imports.maxMatchingProperties",),
        legacy=Legacy(data_source_column="import_identifier"),
        guidance=Guidance(
            summary="What an import's rows find existing items by, when the import doesn't say.",
            means=("Entity ID finds an item by its id, then its URN, its identifier property, a "
                   "field its type is matched by, or a unique qualified name. URN finds it by its id "
                   "or URN only. A property finds it by its id or that property's value; a property "
                   "then URN falls back to the URN for rows without the value. A row that finds "
                   "nothing makes a new item, so the wrong choice makes duplicates, and a replace "
                   "import deletes what it didn't find."),
            effects=(
                Effect("consistency", "An identifier every row carries, such as the URN or your "
                                      "source system's id, matches rows to the same items every "
                                      "time.",
                       "An identifier the rows don't carry matches nothing, so each import makes new "
                       "items.", "high", "better"),
                Effect("database_load", "Entity ID and URN need no index.",
                       "A property needs an index of its values, built by the first import that "
                       "uses it.", "low", "better"),
            ),
            change_when=(
                "Imports make duplicates instead of updating items: match by the identifier your "
                "files carry, such as the URN or a property from your source system.",
                "Your source system has its own ids: match by that property.",
            ),
            recommended=Recommendation("entity_id", "It finds items by everything the platform "
                                                    "knows them by: their id, URN, identifier "
                                                    "property and the fields their type is matched "
                                                    "by."),
            risk="high",
            risk_note=("An identifier the files don't carry matches nothing: an update makes "
                       "duplicates, and a replace would delete the graph and make it again. The "
                       "replace guard stops most such imports."),
            symptoms=("Imports create duplicates instead of updating", "Imports deleted too much",
                      "Imports match the wrong items"),
            example=_ex_identifier,
            evidence=(
                "import_export/identifier.py: entity_id, urn, prop.<name> or prop.<name>,urn; "
                "import_settings.resolve: the data source's, else the platform's "
                "(GRAPHVER_IMPORT_IDENTIFIER), kept on the job. A fork can't match by a property "
                "yet, so its default property is entity_id there (docs/versioning/08 §3b)."),
            aliases=("identifier", "match by", "alternate key", "external id",
                     "GRAPHVER_IMPORT_IDENTIFIER"),
        ),
    ),
    Setting(
        key="imports.replaceGuard",
        category="imports",
        label="Replace guard",
        kind="bool",
        default=Default(True, "IMPORT_REPLACE_GUARD", "IMPORT_REPLACE_GUARD"),
        scopes=_PWG,
        takes_effect=_NEXT_IMPORT,
        audience="business",
        question="Should a replace import that would wipe most of a graph be stopped?",
        section="guard",
        limitable=("lock",),
        uses=("imports.guardMinLive", "imports.guardDeleteShare", "imports.guardCreateShare"),
        guidance=Guidance(
            summary="Whether a replace import that would delete most of a graph and make it again is stopped first.",
            means=("A replace import deletes whatever its file leaves out. A file whose rows name "
                   "items by a different identifier matches nothing, so it would delete everything "
                   "and make it all again, losing every item's history. On, such an import is "
                   "stopped before it deletes anything, and its rows stay on the draft for review. "
                   "Someone who means it can import again with Replace anyway."),
            effects=(
                Effect("consistency", "A mistaken replace is stopped before it deletes anything.",
                       "A mistaken replace can delete a graph's items and their history.", "high",
                       "better"),
                Effect("update_speed", "A real large replace needs one more step: Replace anyway.",
                       "Every replace goes straight through.", "low", "worse"),
            ),
            change_when=(
                "Keep it on. Turn it off only for a data source whose replaces really do make most "
                "of the graph again each time.",
                "Real replaces are stopped often: change the limits rather than turning it off.",
            ),
            recommended=Recommendation(True, "It stops only a replace that deletes most of a graph "
                                             "and makes it again, which is almost always the wrong "
                                             "identifier."),
            risk="high",
            risk_note=("Off, one file with the wrong identifier can delete a whole graph's items and "
                       "history."),
            symptoms=("Imports deleted too much", "A replace import is refused"),
            example=_ex_guard,
            evidence=(
                "import_worker.replace_verdict: state off when IMPORT_REPLACE_GUARD is off; else "
                "blocked past the limits unless the import is sent with allowMassDelete "
                "(mass_delete_blocked). Measured against the main the draft reads "
                "(docs/versioning/08 §6)."),
            aliases=("replace guard", "mass delete", "allowMassDelete", "IMPORT_REPLACE_GUARD"),
        ),
    ),
    Setting(
        key="imports.guardMinLive",
        category="imports",
        label="Guard graphs of at least",
        kind="count",
        default=Default(1_000, "IMPORT_REPLACE_GUARD_MIN_LIVE", "IMPORT_REPLACE_GUARD_MIN_LIVE"),
        scopes=_PWG,
        takes_effect=_NEXT_IMPORT,
        audience="business",
        question="From what size should graphs be protected from a mistaken replace?",
        section="guard",
        range=(0, 100_000_000),
        unit="items",
        limitable=("range", "lock"),
        legacy=Legacy(data_source_column="import_replace_min_live"),
        guidance=Guidance(
            summary="The smallest graph, or part of one, the replace guard and the early stop protect.",
            means=("The replace guard checks a replace only when what it replaces holds at least this "
                   "many items, and the early stop only when the graph does. Smaller ones are "
                   "replaced without either check."),
            effects=(
                Effect("consistency", "More small graphs are replaced without a check.",
                       "Smaller graphs are protected too.", "medium", "worse"),
                Effect("update_speed", "Fewer small replaces are stopped.",
                       "More small replaces may need Replace anyway.", "low", "better"),
            ),
            change_when=(
                "A small graph was wiped by a mistaken replace: lower it.",
                "Small replaces that really do make most items again are stopped: raise it.",
            ),
            recommended=Recommendation(1_000, "Under a thousand items, a mistaken replace is quick "
                                              "to spot and to redo."),
            risk="medium",
            risk_note="High values leave mid-sized graphs unprotected.",
            symptoms=("Small graphs aren't protected by the replace guard",
                      "Small replace imports are refused"),
            example=lambda values, facts: (
                f"The replace guard checks replaces of {_v(values, 'imports.guardMinLive'):,} items "
                f"or more; smaller ones go straight through."),
            evidence=(
                "import_worker.replace_verdict (live >= minLive) and _fail_fast (main's live count >= "
                "minLive), each from the job's limits: the data source's, else the platform's."),
            aliases=("min live", "guard minimum", "IMPORT_REPLACE_GUARD_MIN_LIVE"),
        ),
    ),
    Setting(
        key="imports.guardDeleteShare",
        category="imports",
        label="Stop a replace that deletes",
        kind="ratio",
        default=Default(0.5, "IMPORT_REPLACE_GUARD_DELETE_FRACTION", "IMPORT_REPLACE_GUARD_DELETE_FRACTION"),
        scopes=_PWG,
        takes_effect=_NEXT_IMPORT,
        audience="business",
        question="How much may a replace import delete before it's stopped?",
        section="guard",
        range=(0, 1),
        unit="share",
        limitable=("range", "lock"),
        requires=_GUARD_ON,
        uses=("imports.guardMinLive", "imports.guardCreateShare"),
        visual="guard_meter",
        legacy=Legacy(data_source_column="import_replace_delete_fraction"),
        guidance=Guidance(
            summary="The share of what it replaces a replace must delete, with the create share, to be stopped.",
            means=("A replace is stopped when it would delete at least this share of what it replaces "
                   "and also make at least the create share as many new items. A real cleanup "
                   "deletes a lot but makes little; a file with the wrong identifier does both."),
            effects=(
                Effect("consistency", "Only replaces that delete more are stopped.",
                       "Replaces that delete less are stopped too.", "high", "worse"),
                Effect("update_speed", "Fewer real replaces need Replace anyway.",
                       "More real replaces need Replace anyway.", "low", "better"),
            ),
            change_when=(
                "A mistaken replace that deleted less than half the graph got through: lower it.",
                "Large real cleanups are stopped: raise it.",
            ),
            recommended=Recommendation(0.5, "Half the graph deleted, and as much made again, is what "
                                            "a wrong identifier looks like."),
            risk="medium",
            risk_note="Near 1, a mistaken replace that deletes a little less than everything goes through.",
            symptoms=("Imports deleted too much", "A real cleanup import is refused"),
            example=lambda values, facts: (
                f"A replace that would delete {_share(_v(values, 'imports.guardDeleteShare'))} or "
                f"more of what it replaces, and make "
                f"{_share(_v(values, 'imports.guardCreateShare'))} as many again, is stopped."),
            evidence=(
                "import_worker.replace_verdict: past when live >= minLive, deletes >= deleteFraction "
                "x live and creates >= createFraction x live; refused rows that matched nothing count "
                "as creates (docs/versioning/08 §6)."),
            aliases=("delete fraction", "delete share", "IMPORT_REPLACE_GUARD_DELETE_FRACTION"),
        ),
    ),
    Setting(
        key="imports.guardCreateShare",
        category="imports",
        label="And makes again",
        kind="ratio",
        default=Default(0.5, "IMPORT_REPLACE_GUARD_CREATE_FRACTION", "IMPORT_REPLACE_GUARD_CREATE_FRACTION"),
        scopes=_PWG,
        takes_effect=_NEXT_IMPORT,
        audience="business",
        question="How much must a replace also make again to be stopped?",
        section="guard",
        range=(0, 1),
        unit="share",
        limitable=("range", "lock"),
        requires=_GUARD_ON,
        uses=("imports.guardMinLive", "imports.guardDeleteShare"),
        legacy=Legacy(data_source_column="import_replace_create_fraction"),
        guidance=Guidance(
            summary="The share of what it replaces a replace must make again, with the delete share, to be stopped.",
            means=("With the delete share, this tells a mistake from a cleanup: a file with the wrong "
                   "identifier makes about as many new items as it deletes, while a real cleanup "
                   "makes few. Rows refused for matching nothing count as made."),
            effects=(
                Effect("consistency", "Only replaces that make more again are stopped.",
                       "Replaces that make fewer again are stopped too.", "high", "worse"),
                Effect("update_speed", "Fewer real restructures need Replace anyway.",
                       "More real restructures need Replace anyway.", "low", "better"),
            ),
            change_when=(
                "A mistaken replace that made fewer new items got through: lower it.",
                "Real replaces that restructure a graph are stopped: raise it.",
            ),
            recommended=Recommendation(0.5, "A replace that deletes half and makes as many again is "
                                            "almost always the wrong identifier, not a cleanup."),
            risk="medium",
            risk_note="Near 1, a mistaken replace that makes a little less than everything again goes through.",
            symptoms=("Imports deleted too much", "A replace that restructures a graph is refused"),
            example=lambda values, facts: (
                f"A replace is stopped when it would make "
                f"{_share(_v(values, 'imports.guardCreateShare'))} or more of what it replaces again "
                f"as new items, while deleting {_share(_v(values, 'imports.guardDeleteShare'))}."),
            evidence=(
                "import_worker.replace_verdict, as for the delete share: creates >= createFraction x "
                "live, counting refused rows that matched nothing (_refused_unmatched)."),
            aliases=("create fraction", "create share", "IMPORT_REPLACE_GUARD_CREATE_FRACTION"),
        ),
    ),
    Setting(
        key="imports.minMatchShare",
        category="imports",
        label="Stop early below a match share of",
        kind="ratio",
        default=Default(0.05, "IMPORT_REPLACE_MIN_MATCH_FRACTION", "IMPORT_REPLACE_MIN_MATCH_FRACTION"),
        scopes=_PWG,
        takes_effect=_NEXT_IMPORT,
        audience="business",
        question="Should a replace that matches almost nothing stop early?",
        section="guard",
        range=(0, 1),
        unit="share",
        limitable=("range", "lock"),
        uses=("imports.guardMinLive",),
        legacy=Legacy(data_source_column="import_replace_min_match_fraction"),
        guidance=Guidance(
            summary="The share of its first rows a replace must match to existing items to go on.",
            means=("After its first batch of rows, a replace of a whole graph whose rows found "
                   "existing items for fewer than this share stops there, naming the identifier it "
                   "matched by, rather than read the rest of the file first. It applies whether or "
                   "not the replace guard is on. 0 turns the early stop off."),
            effects=(
                Effect("consistency", "More replaces that match poorly stop early.",
                       "Fewer stop early; the replace guard still checks at the end.", "medium",
                       "better"),
                Effect("update_speed", "A file with the wrong identifier fails within its first "
                                       "batch, not after the whole file.",
                       "A file with the wrong identifier is read to the end before it is refused.",
                       "medium", "better"),
            ),
            change_when=(
                "Large replaces with the wrong identifier run for an hour before they are refused: "
                "raise it.",
                "Replaces of mostly new data stop early though they are right: lower it, or set 0.",
            ),
            recommended=Recommendation(0.05, "A file that matches fewer than 1 in 20 of its first rows "
                                             "almost certainly uses the wrong identifier."),
            risk="low",
            risk_note="Too high stops replaces that bring many new items and few existing ones.",
            symptoms=("A replace import stopped after its first rows",
                      "An import with the wrong identifier ran for hours before it was refused"),
            example=lambda values, facts: (
                "Off: a replace reads its whole file before the replace guard decides."
                if float(_v(values, "imports.minMatchShare")) == 0 else
                f"A replace of a whole graph whose first batch of rows matches fewer than "
                f"{_share(_v(values, 'imports.minMatchShare'))} of them to existing items stops "
                f"there."),
            evidence=(
                "import_worker._fail_fast: after a replace's first node window, matched < "
                "minMatchFraction x decided, in a graph of at least minLive live entities, raises "
                "IdentifierMatchedNothing; not for a view's scope or with allowMassDelete, and not "
                "gated on IMPORT_REPLACE_GUARD (import_worker.py, docs/versioning/08 §6)."),
            aliases=("min match fraction", "early stop", "identifier matched nothing",
                     "IMPORT_REPLACE_MIN_MATCH_FRACTION"),
        ),
    ),
    Setting(
        key="imports.maxRefusedRows",
        category="imports",
        label="Refused rows allowed",
        kind="refusal_budget",
        default=Default("0", "IMPORT_MAX_REFUSED_ROWS", "IMPORT_MAX_REFUSED_ROWS"),
        scopes=_PWG,
        takes_effect=_NEXT_IMPORT,
        audience="business",
        question="How many bad rows may an import skip before it stops?",
        section="refusals",
        limitable=("lock",),
        legacy=Legacy(encode="minus_one_is_unlimited"),
        guidance=Guidance(
            summary="How many of a file's rows an import may refuse before it holds.",
            means=("An import refuses rows it can't use, and says why for each. Past this many, a "
                   "replace deletes nothing and fails, and an import set to publish itself leaves its "
                   "draft for review instead. Set none (0), a number, a share of the file's rows "
                   "such as 0.5%, or unlimited. An import can set its own."),
            effects=(
                Effect("consistency", "Imports go on with more rows missing.",
                       "Imports with refused rows stop for someone to look.", "high", "worse"),
                Effect("update_speed", "Imports with a few bad rows still land.",
                       "A single bad row holds an import.", "medium", "better"),
            ),
            change_when=(
                "Large files routinely carry a few bad rows you accept: allow a small number or share.",
                "Imports were published with rows missing: set 0.",
            ),
            recommended=Recommendation("0", "Nothing lands with rows missing unless someone decides "
                                            "it should, on the import itself."),
            risk="medium",
            risk_note=("Allowed, a replace keeps the items refused rows name but publishes without "
                       "those rows."),
            symptoms=("Imports stop on a few bad rows", "Imports publish with rows missing"),
            example=_ex_refused,
            evidence=(
                "import_worker.refused_budget and within_budget: 0, a count, a share ('0.5%') or -1; "
                "an invalid platform value holds on any refused row. Kept on jobs.import_settings "
                "(docs/versioning/08 §3b)."),
            aliases=("refused rows", "bad rows", "maxRefusedRows", "IMPORT_MAX_REFUSED_ROWS"),
        ),
    ),
    Setting(
        key="imports.maxMatchingProperties",
        category="imports",
        label="Matching properties per graph",
        kind="count",
        default=Default(10, "GRAPHVER_MAX_MATCHING_PROPERTIES", "MAX_MATCHING_PROPERTIES"),
        scopes=_P,
        takes_effect=("next_import", "The next import that matches by a property not indexed yet. "
                                     "Properties already indexed are kept."),
        audience="business",
        question="How many properties may imports match items by?",
        section="matching",
        range=(0, 100),
        unit="properties",
        guidance=Guidance(
            summary="How many properties one graph's imports may match items by.",
            means=("Matching by a property keeps an index of its values in the database: built by the "
                   "first import that names it, reading every item once, then kept up to date by "
                   "each import that uses it. One property past this number is refused. 0 allows no "
                   "new property."),
            effects=(
                Effect("database_load", "More indexes to build and keep up to date.",
                       "Fewer indexes to build and keep up to date.", "medium", "worse"),
                Effect("cost", "More database space for indexes.", "Less database space for indexes.",
                       "low", "worse"),
            ),
            change_when=(
                "A data source needs to match by more of its source systems' ids: raise it.",
                "Index builds weigh on the database: lower it.",
            ),
            recommended=Recommendation(10, "Enough for the ids several source systems carry, without "
                                           "an index for every property."),
            risk="low",
            risk_note="Lowering it never removes an index; it only refuses new properties.",
            symptoms=("Imports can't match by another property",
                      "Imports by a new property are slow to start"),
            example=lambda values, facts: (
                f"Each graph's imports may match items by up to "
                f"{_v(values, 'imports.maxMatchingProperties')} properties, each kept in an index."),
            evidence=(
                "import_export/keys.ensure: a property not indexed yet is refused "
                "(too_many_matching_properties) when the graph already has MAX_MATCHING_PROPERTIES "
                "others; the index is built from main's live nodes a page at a time, minutes at a "
                "million nodes (docs/versioning/08 §3b)."),
            aliases=("matching properties", "alternate keys", "external ids",
                     "GRAPHVER_MAX_MATCHING_PROPERTIES"),
        ),
    ),
)

SETTINGS: Tuple[Setting, ...] = _READS + _UPDATES + _BUILDS + _RESIDENCY + _DATABASE + _DRAFTS + _IMPORTS
BY_KEY = {s.key: s for s in SETTINGS}

# ---------------------------------------------------------------------------------------------
# Categories
# ---------------------------------------------------------------------------------------------

CATEGORIES: Tuple[Category, ...] = (
    Category(
        id="reads", label="Reads & consistency", icon="eye", order=1, audience=("business",),
        summary="What people see while new data loads, and how far behind a fast view may be.",
        sections=(("while_loading", "While new data loads"),),
        posture=_posture_reads,
    ),
    Category(
        id="updates", label="Updates & loading", icon="activity", order=2,
        summary="How new data is written into the graph store without slowing reads.",
        sections=(("pacing", "Pacing writes around reads"), ("switch", "After a switch or a move")),
        posture=_posture_updates,
    ),
    Category(
        id="builds", label="New-version builds", icon="layers", order=3,
        master_switch="candidateKeysEnabled",
        summary="Building a graph's next version in a second copy while readers keep the current one.",
        sections=(("when", "When to build"), ("room", "Room for a build"),
                  ("lifecycle", "Running builds")),
        posture=_posture_builds,
    ),
    Category(
        id="residency", label="Memory & residency", icon="memory-stick", order=4,
        audience=("operator", "business"), master_switch="residencyEnabled",
        summary="Which graphs the graph store keeps in memory, and when it unloads and loads them.",
        sections=(("class", "Which graphs stay in memory"), ("unloading", "Unloading"),
                  ("loading", "Loading"), ("loop", "Memory checks")),
        posture=_posture_residency,
    ),
    Category(
        id="database", label="Database reads", icon="database", order=5,
        summary="Limits on reads from the database while the graph store has no version of a graph.",
        sections=(("limits", "Reads from the database"),),
        posture=_posture_database,
    ),
    Category(
        id="drafts", label="Drafts & history", icon="git-branch", order=6, audience=("business",),
        summary=("How long drafts and deleted data last, who sees drafts, and who approves and "
                 "merges reviews."),
        sections=(("lifecycle", "How long drafts last"), ("levels", "Who sees drafts"),
                  ("reviews", "Reviews"), ("forks", "Forks"), ("trash", "Deleted data sources")),
        posture=_posture_drafts,
    ),
    Category(
        id="imports", label="Imports", icon="upload", order=7, audience=("business",),
        summary="How imports find existing items, and the guards that stop a mistaken import.",
        sections=(("matching", "Finding existing items"), ("guard", "Stopping a mistaken replace"),
                  ("refusals", "Refused rows")),
        posture=_posture_imports,
    ),
)

# ---------------------------------------------------------------------------------------------
# Words the app uses, defined once
# ---------------------------------------------------------------------------------------------

GLOSSARY: Tuple[Term, ...] = (
    Term("Graph store", "Where each graph's latest version is held in memory, so reads are fast.",
         "FalkorDB. Each versioned graph's published main is projected into a key there; Postgres "
         "stays the source of truth."),
    Term("Database", "Where every version of every graph is kept for good. It is the source of "
                     "truth, so nothing is lost when a graph is unloaded.",
         "Postgres: the graphver schema, on GRAPHVER_DB_URL or the management database."),
    Term("Copy", "A graph's latest version in the graph store, which readers read.",
         "A FalkorDB key (projection_state.falkor_graph_name)."),
    Term("Platform copy", "A copy the platform made and manages: it can be unloaded, loaded, moved "
                          "and built beside.",
         "owns_falkor_graph is true: a key the platform minted."),
    Term("Connected graph", "A graph read from a copy its owner keeps in their own graph store. The "
                            "platform never unloads it, copies it or builds beside it.",
         "A customer's own FalkorDB key with version control enabled (owns_falkor_graph false), "
         "until it is adopted onto a platform key."),
    Term("Version", "One published state of a graph. Each publish, merge or import makes a new one.",
         "A commit on main (commit_seq)."),
    Term("Updating", "Writing a new version into a graph's copy.",
         "A projection pass: the projector writes a window of version rows and advances the "
         "watermark (projected_commit_seq)."),
    Term("Loading", "Bringing a graph that isn't in memory back into the graph store.",
         "Rehydration: a full seed of a fresh key from Postgres, admitted by the capacity loop "
         "(status rehydrating)."),
    Term("Unloading", "Removing a graph's copy from the graph store to free memory. Nothing is "
                      "lost: until it is loaded again, it is read from the database.",
         "Eviction (CacheManager.evict): the key is dropped and the graph marked evicted, with why."),
    Term("New-version build", "Building a graph's next version in a second copy while readers keep "
                              "the current one, then switching.",
         "A candidate key (projection_state.candidate_*), made by GRAPH.COPY or seeded from "
         "Postgres, caught up, checked, then switched to (docs/versioning/04 §5)."),
    Term("Switch", "The moment readers move from the current copy to a newly built one, all at once.",
         "switch_to_candidate: one transaction repins the graph to the build's key; the old key "
         "joins retired_keys."),
    Term("Read mode", "What readers see while a new version of a graph loads: Always the latest, "
                      "Keep serving, update in place, or Keep serving, switch when ready.",
         "build_policy.read_mode_of, applied by service.serving_seq with the mode's lag cap."),
    Term("Residency class", "Whether a graph stays in memory when nobody reads it: Always, Standard "
                            "or Coldline.",
         "projection_state.residency."),
    Term("Always", "A residency class: never unloaded.", "residency 'always'; the evictor refuses it."),
    Term("Standard", "A residency class: unloaded after a long time unread, or sooner when memory "
                     "runs short, and loaded again on its next read.", "residency 'standard'."),
    Term("Coldline", "A residency class: unloaded soon after use, and usually read from the database.",
         "residency 'coldline'."),
    Term("Node", "One server of the graph store, with its own memory.",
         "A FalkorDB cluster master, or a standalone or Sentinel-managed instance."),
    Term("Start mark", "The share of a node's memory at which graphs start to be unloaded; loads "
                       "and copies must fit under it.", "high_water_pct of maxmemory."),
    Term("Stop mark", "The share of a node's memory down to which graphs are unloaded.",
         "low_water_pct of maxmemory."),
    Term("Memory check", "The regular check, every minute by default, of each node's memory, which "
                         "unloads and loads graphs.",
         "residency.CapacityLoop.run_once: one leader across workers, under a Postgres advisory "
         "lock."),
    Term("Worker", "A background process that updates graphs and runs builds, imports and sweeps.",
         "The versioning worker (python -m backend.app.services.versioning), by lanes: projection, "
         "transfer and bootstrap."),
    Term("Lineage summaries", "Counts of lineage between containers, kept ready so large views open "
                              "fast.",
         ":AGGREGATED rollup edges, built by the aggregation job and moved by the projector."),
    Term("Draft", "A set of changes to a graph that isn't published yet.", "A branch of kind draft."),
    Term("Review", "A request to merge a draft, which reviewers approve.", "A merge request."),
    Term("Fork", "A separate copy of a graph to work in, which reads through the original.",
         "A graph with fork_parent_graph_id and no FalkorDB key of its own (docs/versioning/17)."),
    Term("Trash", "Where a deleted data source waits, restorable, before it is removed for good.",
         "A tombstone (deleted_at); the reaper queues its purge after PURGE_GRACE_DAYS."),
    Term("Replace import", "An import that makes the graph, or a view's part of it, match the file: "
                           "what the file leaves out is deleted.", "reconcileMode=replace."),
    Term("Identifier", "What an import's rows find existing items by.",
         "identifier: entity_id, urn, prop.<name> or prop.<name>,urn."),
    Term("Matching property", "A property imports can find items by, kept in an index of its values.",
         "graphver.entity_keys and key_index (import_export/keys.py)."),
    Term("Default", "The value in force where no level chose one: the deployment's environment "
                    "variable if it is set and valid, else the built-in value.",
         "settings_types.Default(code, env, attr)."),
    Term("Platform", "A value for the whole platform, chosen by a system administrator.",
         "scope platform, scope_id ''."),
    Term("Workspace", "A value for every graph in one workspace, chosen by its administrators where "
                      "they may.", "scope workspace, scope_id the workspace id."),
    Term("Graph", "A value for one data source's graph. A fork follows the graph it was forked from.",
         "scope graph, scope_id the data source id."),
    Term("Limit", "What a system administrator lets workspace administrators choose: the allowed "
                  "choices, a range, or a lock.", "setting_values.limits on the platform row."),
    Term("Exception", "A value a system administrator set outside the limits. It stays in force, "
                      "marked as an exception, so tightening a limit never changes a graph without "
                      "anyone noticing.", "Resolver status exception."),
)

# ---------------------------------------------------------------------------------------------
# Why a value in force differs from the one chosen
# ---------------------------------------------------------------------------------------------

#: A ``fix`` of None is filled in by the resolver where it can be: the feature switch or the setting
#: the unmet requirement or the cap names.
WHY: Tuple[Why, ...] = (
    Why("switch_off", "A feature switch this setting needs is off, so it has no effect until the "
                      "switch is on."),
    Why("builds_off", "Keep serving, switch when ready needs New-version builds, which is off, so "
                      "this graph updates in place until it is on.",
        {"feature": "candidateKeysEnabled", "to": True}),
    Why("connected_graph", "This is a connected graph: its copy belongs to its owner, so it is never "
                           "copied or built beside, and it updates in place. Adopting it onto a "
                           "platform copy changes that."),
    Why("not_used_by_mode", "Not used: the read mode in force is Always the latest, which never "
                            "serves an older version.",
        {"setting": "reads.mode", "to": "in_place"}),
    Why("capped_by_deployment", "Your deployment caps this value, so the cap is in force."),
    Why("capped_by_setting", "Another setting caps this value, so the lower one is in force."),
    Why("locked_by_platform", "A system administrator locked this setting for the whole platform, so "
                              "the platform's value is in force."),
    Why("outside_limits_exception", "This value is outside the limits set for workspaces. A system "
                                    "administrator chose it, so it stays in force as an exception."),
    Why("invalid_env", "The deployment's environment value isn't valid, so the built-in default is "
                       "in force."),
    Why("env_out_of_range", "The deployment's environment value is outside this setting's range, so "
                            "the nearest allowed value is in force."),
    Why("follows_root", "A fork follows the graph it was forked from: change this on that graph."),
    Why("derived_from_levels", "Only one draft level is allowed, so new drafts start at that level.",
        {"setting": "drafts.levels", "to": "any"}),
    Why("guard_off", "The replace guard is off, so this limit isn't checked.",
        {"setting": "imports.replaceGuard", "to": True}),
)

# ---------------------------------------------------------------------------------------------
# Set by your deployment: env-only sizing, shown read-only beside the settings it bounds
# ---------------------------------------------------------------------------------------------

DEPLOYMENT: Tuple[DeploymentFact, ...] = (
    DeploymentFact("GRAPHVER_ROUTE_CACHE_SECS", "Where reads go, kept for", "reads",
                   "How long a process may go on sending a graph's reads where it last looked, to "
                   "its copy or to the database, before looking again. A write tells every process "
                   "at once, so this only bounds a change that couldn't be announced.",
                   "ROUTE_CACHE_SECS"),
    DeploymentFact("GRAPHVER_PROJECTION_CONCURRENCY", "Graphs each worker updates at once", "updates",
                   "How many graphs each worker updates at once. Builds count among them, so it also "
                   "caps Builds per worker.", "PROJECTION_CONCURRENCY"),
    DeploymentFact("GRAPHVER_PROJECTION_POLL_SECS", "Look for work every", "updates",
                   "How often a worker looks for graphs to update, besides the nudge each publish "
                   "sends it.", "PROJECTION_POLL_SECS"),
    DeploymentFact("GRAPHVER_PROJECTION_BATCH_SIZE", "Most changes in one write", "updates",
                   "The most changes one write sends; the write target makes writes smaller still.",
                   "PROJECTION_BATCH_SIZE"),
    DeploymentFact("GRAPHVER_PROJECTION_PASS_MAX_SECS", "Longest turn of one graph", "updates",
                   "A large update stops at a page boundary after this long and carries on in its "
                   "next turn, so other graphs get theirs.", "PROJECTION_PASS_MAX_SECS"),
    DeploymentFact("GRAPHVER_PROJECTION_INLINE_MAX_ROWS", "Written straight after a publish, up to",
                   "updates",
                   "A change up to this size is written into the graph store straight after its "
                   "publish; a larger one by the worker. It is also the default of Changes left at "
                   "the switch.", "PROJECTION_INLINE_MAX_ROWS"),
    DeploymentFact("PROJECTION_FALKOR_WRITE_TIMEOUT_S", "Longest wait on one write", "builds",
                   "How long the worker waits on one write to the graph store. A copy waits this "
                   "plus 15 seconds, 75 by default, and one that takes longer fails that attempt."),
    DeploymentFact("GRAPHVER_TRACE_LEASE_TTL_SECS", "A read holds its graph for", "residency",
                   "How long a person's read keeps its graph from being unloaded.",
                   "TRACE_LEASE_TTL_SECS"),
    DeploymentFact("GRAPHVER_POOL_SIZE", "Database connections per process", "database",
                   "Connections each process keeps for versioned graphs. Reads at once per process "
                   "should stay under it.", "POOL_SIZE"),
    DeploymentFact("GRAPHVER_POOL_MAX_OVERFLOW", "Extra connections at a peak", "database",
                   "Connections a process may open past its pool at a peak.", "POOL_MAX_OVERFLOW"),
    DeploymentFact("GRAPHVER_ROUTE_POOL_SIZE", "Connections for finding where reads go", "database",
                   "A small pool of its own that finds where each read goes, so heavy reads can't "
                   "stop that.", "ROUTE_POOL_SIZE"),
    DeploymentFact("GRAPHVER_DRAFT_SWEEP_SECS", "Draft sweep every", "drafts",
                   "How often the worker closes idle drafts and removes closed drafts' changes.",
                   "DRAFT_SWEEP_SECS"),
    DeploymentFact("GRAPHVER_REAP_POLL_SECS", "Trash check every", "drafts",
                   "How often the trash is checked for data sources past their restore window.",
                   "REAP_POLL_SECS"),
    DeploymentFact("GRAPHVER_FORK_REWIND_MAX", "Most changes a fork reads through", "drafts",
                   "Changes a fork and the graph it came from may have made since they parted "
                   "before the fork's reads go to the database.", "FORK_REWIND_MAX"),
    DeploymentFact("IMPORT_COMMIT_WINDOW", "Rows per import step", "imports",
                   "Rows an import saves to its draft at a time; the early stop decides after the "
                   "first such step.", "IMPORT_COMMIT_WINDOW"),
    DeploymentFact("GRAPHVER_TRANSFER_SLOTS", "Jobs per worker", "imports",
                   "Import, export and publish jobs each worker runs at once.", "TRANSFER_SLOTS"),
    DeploymentFact("IMPORT_STAGING_GC_DAYS", "Staged rows kept for", "imports",
                   "Days a finished import's staged rows are kept, to resume or re-run it.",
                   "STAGING_GC_DAYS"),
)

# ---------------------------------------------------------------------------------------------
# Retired: still in the code or the schema, acted on by nothing; removed in a later release
# ---------------------------------------------------------------------------------------------

RETIRED: Tuple[Retired, ...] = (
    Retired("falkorMaxResident", "A graph store provider's count of graphs to keep loaded. Nothing "
                                 "acts on it: Graph residency unloads by each node's memory instead."),
    Retired("GRAPHVER_FALKOR_MAX_RESIDENT", "The deployment's default for that count. Nothing acts on "
                                            "it: the worker no longer runs count-based unloading."),
    Retired("GRAPHVER_FALKOR_BUDGETS", "That count for each provider. Nothing acts on it, for the same "
                                       "reason."),
    Retired("GRAPHVER_EVICT_SECS", "How often count-based unloading ran. It no longer runs, so "
                                   "nothing reads this."),
    Retired("audit_tier", "Each graph's audit tier (GRAPHVER_DEFAULT_AUDIT_TIER). It is stored, but "
                          "nothing reads it: every graph keeps the same history whatever it says."),
)

# ---------------------------------------------------------------------------------------------
# Profiles: one-click starting points. Each value is one its setting's guidance gives for the
# outcome the profile promises; Balanced puts back the built-in value of every setting the others
# change.
# ---------------------------------------------------------------------------------------------

_ALL_SCOPES = ("platform", "workspace", "graph")

_TUNED: Tuple[Profile, ...] = (
    Profile(
        id="fastest-reads",
        title="Fastest reads",
        promise=("Reads stay on the graph store at full speed while new data loads, and writes give "
                 "way to them."),
        audience="business",
        when=("Views of a large graph slow down for a while after each big import.",
              "Fast canvases matter more than seeing a large change all at once."),
        values={"reads.mode": "in_place", "reads.maxVersionsBehind": "unlimited",
                "updates.statementTargetMs": 250, "updates.pacingRatio": 0.5},
        scopes=_ALL_SCOPES,
        caution=("While a large change is written, readers can see part of it before the rest, and "
                 "large updates take longer to land."),
    ),
    Profile(
        id="always-exact",
        title="Always exact",
        promise=("Readers always see the newest published version, whole, read from the database "
                 "until the graph store has it."),
        audience="business",
        when=("The newest data must show the moment it is published, even if views are slower "
              "meanwhile.",
              "Reports and checks must read exactly the version just published."),
        values={"reads.mode": "latest"},
        scopes=_ALL_SCOPES,
        caution=("While a graph updates, its reads come from the database: slower on a large graph, "
                 "without lineage summaries meanwhile, and asked to retry under heavy load."),
    ),
    Profile(
        id="least-memory",
        title="Least memory",
        promise=("Graphs give their memory back half an hour after their last read, and a build "
                 "needs about its graph's size rather than twice it."),
        audience="operator",
        when=("The graph store is short of memory, or its memory costs too much.",
              "Most graphs are opened now and then rather than all day."),
        values={"builds.forRebuilds": False, "builds.method": "reseed", "builds.perWorker": 1,
                "residency.class": "coldline", "residency.standardIdleSecs": 86_400,
                "residency.coldlineIdleSecs": 1_800, "residency.coldlineLoadAbove": 2_000_000},
        scopes=_ALL_SCOPES,
        caution=("Graphs nobody read in the last half hour are read from the database, which is "
                 "slower, and builds take much longer; the memory values need Graph residency on, "
                 "and the build values New-version builds."),
    ),
    Profile(
        id="big-import-tonight",
        title="Big import tonight",
        promise=("Writes to the graph store go faster while few people read, so a large import lands "
                 "sooner, and a build with no room is written in place rather than wait."),
        audience="operator",
        when=("A large import or replace runs tonight, while few people read.",
              "The new version must be in place by morning, even where a build finds no room."),
        values={"updates.statementTargetMs": 1_000, "updates.pacingRatio": 0.1,
                "builds.noRoom": "in_place"},
        scopes=("platform",),
        caution=("Reads wait longer behind writes, and a change whose build finds no room can be "
                 "seen part-way, until you apply Balanced again; the build value needs New-version "
                 "builds."),
    ),
)

_TUNED_KEYS = {key for profile in _TUNED for key in profile.values}

PROFILES: Tuple[Profile, ...] = (
    Profile(
        id="balanced",
        title="Balanced",
        promise=("The built-in values: readers see the newest version as soon as it is published, "
                 "and writes to the graph store leave reads their turn."),
        audience="business",
        when=("You are starting out, or aren't sure which trade suits you.",
              "You tried another profile and want the built-in values back."),
        values={s.key: s.default.code for s in SETTINGS if s.key in _TUNED_KEYS},
        scopes=_ALL_SCOPES,
        caution=("The settings it covers go back to their built-in values here, including any you "
                 "tuned for your platform."),
    ),
    *_TUNED,
)

# ---------------------------------------------------------------------------------------------
# Signals: what actually happened. The ids are fixed (the counters bump them by id); each symptom
# is one of its settings' symptoms, so "Something's wrong?" can show how often it happened.
# ``warn_at`` is a count in 24 hours. A build or a load that has to wait asks for room again about
# once a minute, and each ask that waits counts: 30 is about half an hour of waiting, as long as
# Alert after waiting allows by default.
# ---------------------------------------------------------------------------------------------

SIGNALS: Tuple[Signal, ...] = (
    Signal("builds.waited_for_room", "Builds waited for room", "Builds wait for room",
           ("builds.method", "builds.copyRoomPct", "builds.copyMaxBytes", "builds.noRoom",
            "residency.unloadStartPct"), warn_at=30),
    Signal("builds.copy_timed_out", "Copies timed out", "Copies time out on a large graph",
           ("builds.method", "builds.copyMaxBytes"), warn_at=3),
    Signal("builds.dropped", "Builds dropped after their last attempt", "A build gave up too soon",
           ("builds.maxAttempts", "builds.method", "builds.copyMaxBytes"), warn_at=1),
    Signal("reads.asked_to_retry", "Reads asked to retry: too many at once on the database",
           "Reads are asked to retry while data loads",
           ("database.readsPerGraph", "database.readsPerProcess", "reads.mode"), warn_at=50),
    Signal("reads.from_database_while_behind",
           "Reads served from the database while the graph store caught up",
           "Reads are slow while data loads", ("reads.mode", "reads.maxVersionsBehind")),
    Signal("residency.unloaded_under_pressure", "Graphs unloaded because memory ran short",
           "Graphs unload unexpectedly",
           ("residency.autoUnload", "residency.unloadStartPct", "residency.unloadStopPct",
            "residency.class"), warn_at=10),
    Signal("residency.load_waited_for_room", "Loads waited for room", "Loads wait for room",
           ("residency.loadMarginPct", "residency.unloadStartPct", "residency.bytesPerEntity",
            "residency.autoUnload"), warn_at=30),
    Signal("imports.replace_refused_by_guard", "Replaces stopped by the replace guard",
           "A replace import is refused",
           ("imports.replaceGuard", "imports.guardMinLive", "imports.guardDeleteShare",
            "imports.guardCreateShare", "imports.identifier"), warn_at=1),
    Signal("imports.replace_stopped_low_match",
           "Replaces stopped early because too few rows matched",
           "A replace import stopped after its first rows",
           ("imports.minMatchShare", "imports.identifier", "imports.guardMinLive"), warn_at=1),
    Signal("drafts.idle_closed", "Idle drafts closed", "My draft was closed while I was away",
           ("drafts.idleCloseDays",)),
    Signal("drafts.changes_removed", "Closed drafts' changes removed", "Old drafts' changes are gone",
           ("drafts.keepClosedDays",)),
)


def schema_json(values: Optional[Mapping[str, Any]] = None,
                facts: Optional[Mapping[str, Any]] = None) -> dict:
    """The registry as one JSON document (``settings_types.schema``), its examples and posture
    sentences rendered with ``values`` (else the code defaults) and its recommendations with
    ``facts``."""
    return schema(domain=DOMAIN, categories=CATEGORIES, settings=SETTINGS, glossary=GLOSSARY,
                  why=WHY, deployment=DEPLOYMENT, retired=RETIRED, profiles=PROFILES,
                  signals=SIGNALS, values=values, facts=facts)
