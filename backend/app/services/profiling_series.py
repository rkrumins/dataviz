"""Turning observations into series a chart can draw.

Pure functions over rows the repository already fetched — no session, no IO —
so the shaping rules that decide what a reader sees can be tested without a
database, and so the API layer stays about HTTP.

**Series-major, not point-major.** The previous shape was one point per
instant with the per-type maps embedded inside it, which forced every consumer
to pivot before it could draw anything, and made ``metric`` and ``breakdown``
entangled rather than orthogonal. A time series is a list of series; that is
what charts consume and what makes "entities, broken down by type" a
composition of two independent choices rather than a fourth endpoint.

**Carry-forward across sources.** At workspace, provider and platform scope a
bucket's total is a sum over sources, and sources are not observed in lockstep
— one polls every 60s, another was last seen an hour ago. Summing only the
sources that reported IN a bucket makes the total dip every time one of them
was quiet, which reads as data loss and is the exact signal this feature
exists to make trustworthy. So a source contributes its last known value until
it reports again.
"""
from __future__ import annotations

import json
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from backend.common.derived_artifacts import (
    derived_edge_total,
    is_derived_edge_type,
    strip_derived_counts,
)

#: Series drawn before the tail is folded away. Above this a categorical
#: palette runs out of distinguishable slots — a seventh hue is not a new
#: colour to a reader with a colour-vision deficiency, it is one of the six
#: already on screen. The remainder becomes "Other" rather than a colour
#: nobody can name.
DEFAULT_TOP = 8

OTHER_KEY = "__other__"

#: ``aggregated`` is the materialised rollup — the platform's own overlay,
#: reported ALONGSIDE the relationship types rather than among them. It is a
#: ``breakdown="none"`` measure only: the overlay IS one edge type, so
#: decomposing it by edge type is a tautology (see ``_BREAKDOWN_METRIC``).
METRICS = ("total", "nodes", "edges", "aggregated")
BREAKDOWNS = ("none", "entity_type", "edge_type")

_BREAKDOWN_FIELD = {
    "entity_type": "entity_type_counts",
    "edge_type": "edge_type_counts",
}
#: Which measure a breakdown decomposes. Choosing "entities, broken down by
#: relationship type" is not a question with an answer, so the breakdown
#: implies the metric rather than multiplying with it.
_BREAKDOWN_METRIC = {"entity_type": "nodes", "edge_type": "edges"}

#: What each measure is called on screen.
_METRIC_LABEL = {
    "nodes": "Entities",
    "edges": "Relationships",
    "aggregated": "Aggregated",
}


def _loads(raw: Any) -> Dict[str, int]:
    if isinstance(raw, dict):
        return {str(k): int(v or 0) for k, v in raw.items()}
    try:
        parsed = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    out: Dict[str, int] = {}
    for k, v in parsed.items():
        try:
            out[str(k)] = int(v or 0)
        except (TypeError, ValueError):
            continue
    return out


def _counts(
    obs: Any, field: str, *, include_derived_edges: bool = False,
) -> Dict[str, int]:
    """One snapshot's type counts, with the platform's own artifacts removed.

    Parsing stays in ``_loads``; the exclusion is policy and lives here.

    Derived NODE labels are always removed, and that is not negotiable:
    ``_AggMeta`` is MERGEd per aggregation run and wiped by projection seeds
    and purges, so it toggles 1 -> 0 -> 1 and showed up as a type that
    repeatedly disappeared. Nobody asked to see the platform's bookkeeping
    nodes and nothing is lost by hiding them.

    Derived EDGE types are different, and ``include_derived_edges`` is why
    they get their own switch — the ``derived_artifacts`` docstring already
    warns that the two lists are excluded in different places and that one
    must never be assumed to imply the other. The rollup is not bookkeeping:
    it is the lineage every view draws, it is a large share of the graph, and
    hiding it made the breakdown disagree with the store — a chart totalling
    5.0M against a graph holding 5.6M, with nothing on screen to explain the
    gap. Showing it is now safe because the JUDGEMENT paths no longer share
    this one: findings measure ``source_delta_of`` and ``types_that_vanished``
    strips unconditionally, so a rebuild cannot raise an alarm about it
    whatever this returns.
    """
    counts = _loads(getattr(obs, field, None))
    if field == "edge_type_counts":
        return counts if include_derived_edges else strip_derived_counts(
            counts, edges=True,
        )
    return strip_derived_counts(counts)


def _overlay_value(obs) -> int:
    """How many of this snapshot's relationships are the platform's OWN
    materialised rollup.

    The exact complement of :func:`_counts` on the edge field: that one
    removes the derived types, this one IS them. Same list, opposite halves.

    Stripping was only ever half an answer. The overlay must not rank among a
    customer's relationship types, and it must not read as a data-quality
    anomaly when a rebuild wipes and rewrites it — but its VOLUME is a real
    operational number, and "did the overlay drop, and has it come back" is
    the question people open this page to ask.
    """
    return derived_edge_total(_loads(getattr(obs, "edge_type_counts", None)))


def _metric_value(obs, metric: str) -> int:
    if metric == "nodes":
        return int(obs.node_count or 0)
    if metric == "edges":
        return int(obs.edge_count or 0)
    if metric == "aggregated":
        return _overlay_value(obs)
    return int(obs.node_count or 0) + int(obs.edge_count or 0)


def _metric_extremes(obs, metric: str) -> Tuple[Optional[int], Optional[int]]:
    if metric == "nodes":
        return obs.node_min, obs.node_max
    if metric == "edges":
        return obs.edge_min, obs.edge_max
    if metric == "aggregated":
        # The rollup tiers keep ``edge_min``/``edge_max`` for the TOTAL only —
        # there are no per-type extremes anywhere. Returning the total's would
        # draw a band that does not contain its own line. Unknown extremes are
        # already handled: the caller drops min/max from the point.
        return None, None
    if obs.node_min is None or obs.edge_min is None:
        return None, None
    return obs.node_min + obs.edge_min, (obs.node_max or 0) + (obs.edge_max or 0)


def buckets_of(observations: Sequence) -> List[str]:
    return sorted({o.bucket for o in observations})


def _carry_forward(
    observations: Sequence, buckets: Sequence[str],
) -> Dict[str, Dict[str, Any]]:
    """``{bucket: {source_id: observation}}`` with gaps filled forward.

    A source that did not report in a bucket keeps the value it last reported.
    Before its FIRST observation it contributes nothing at all — carrying a
    value backwards would invent history for a source that did not yet exist,
    which is the opposite of the problem this solves.
    """
    by_bucket: Dict[str, Dict[str, Any]] = {b: {} for b in buckets}
    for o in observations:
        by_bucket.setdefault(o.bucket, {})[o.data_source_id] = o

    filled: Dict[str, Dict[str, Any]] = {}
    carry: Dict[str, Any] = {}
    for bucket in buckets:
        carry.update(by_bucket.get(bucket, {}))
        filled[bucket] = dict(carry)
    return filled


def _rank_types(
    filled: Dict[str, Dict[str, Any]], buckets: Sequence[str], field: str,
    top: int, *, include_derived_edges: bool = False,
) -> List[str]:
    """Types to draw, ranked by PEAK rather than by final value.

    A type that was large all month and is now zero is the most interesting
    line on the chart, and ranking by the last value drops it into "Other" —
    hiding precisely the disappearance a reader came to find.
    """
    peaks: Dict[str, int] = {}
    for bucket in buckets:
        totals: Dict[str, int] = {}
        for obs in filled.get(bucket, {}).values():
            for name, value in _counts(
                obs, field, include_derived_edges=include_derived_edges,
            ).items():
                totals[name] = totals.get(name, 0) + value
        for name, value in totals.items():
            if value > peaks.get(name, 0):
                peaks[name] = value
    ranked = sorted(peaks, key=lambda n: (-peaks[n], n))
    return ranked[:top]


def build_series(
    observations: Sequence, *, metric: str = "total",
    breakdown: str = "none", top: int = DEFAULT_TOP,
    include_derived_edges: bool = False,
) -> Dict[str, Any]:
    """Series-major payload for one scope and window.

    Returns ``{"buckets": [...], "series": [...], "totals": {...}}`` where each
    series is ``{key, label, kind, points: [{t, v, min, max}]}``.
    """
    metric = metric if metric in METRICS else "total"
    breakdown = breakdown if breakdown in BREAKDOWNS else "none"
    buckets = buckets_of(observations)
    if not buckets:
        return {"buckets": [], "series": [], "totals": {}}

    filled = _carry_forward(observations, buckets)

    # The totals line is always computed, breakdown or not: a composition
    # chart still needs its own total to be readable, and the summary below
    # is derived from it rather than from a sum of the drawn bands (which
    # would silently exclude whatever landed in "Other").
    # Parsed ONCE per observation, not once per (bucket, source): carry-forward
    # repeats the same object across every bucket a source was silent for, so
    # the naive version turns the breakdown="none" path — which parses no JSON
    # at all today — into buckets x sources parses. The key is the one
    # ``_carry_forward`` itself assumes to be unique.
    overlay = {
        (getattr(o, "data_source_id", None), o.bucket): _overlay_value(o)
        for o in observations
    }

    totals: Dict[str, List[int]] = {
        "nodes": [], "edges": [], "total": [], "aggregated": [],
    }
    for bucket in buckets:
        observed = filled[bucket].values()
        nodes = sum(_metric_value(o, "nodes") for o in observed)
        edges = sum(_metric_value(o, "edges") for o in observed)
        totals["nodes"].append(nodes)
        totals["edges"].append(edges)
        totals["total"].append(nodes + edges)
        # Always, breakdown or not — this is what lets the Relationships tile
        # say "of which N aggregated" and the type ledger carry an overlay row
        # without a second request.
        totals["aggregated"].append(sum(
            overlay.get((getattr(o, "data_source_id", None), o.bucket), 0)
            for o in observed
        ))

    series: List[Dict[str, Any]] = []

    if breakdown == "none":
        wanted = ("nodes", "edges") if metric == "total" else (metric,)
        for name in wanted:
            points = []
            for i, bucket in enumerate(buckets):
                observed = list(filled[bucket].values())
                lo, hi = 0, 0
                known = True
                for o in observed:
                    o_lo, o_hi = _metric_extremes(o, name)
                    if o_lo is None or o_hi is None:
                        known = False
                        break
                    lo += o_lo
                    hi += o_hi
                point = {"t": bucket, "v": totals[name][i]}
                if known and observed:
                    point["min"], point["max"] = lo, hi
                points.append(point)
            series.append({
                "key": name,
                "label": _METRIC_LABEL.get(name, name),
                "kind": "metric",
                "points": points,
            })
        return {
            "buckets": buckets, "series": series, "totals": totals,
            # The RESOLVED measure, so the endpoint can echo what it actually
            # drew rather than the string it was handed.
            "metric": metric,
        }

    field = _BREAKDOWN_FIELD[breakdown]
    drawn = _rank_types(
        filled, buckets, field, top,
        include_derived_edges=include_derived_edges,
    )
    drawn_set = set(drawn)

    per_type: Dict[str, List[int]] = {k: [] for k in drawn}
    other: List[int] = []
    for bucket in buckets:
        summed: Dict[str, int] = {}
        for obs in filled[bucket].values():
            for name, value in _counts(
                obs, field, include_derived_edges=include_derived_edges,
            ).items():
                summed[name] = summed.get(name, 0) + value
        for key in drawn:
            per_type[key].append(summed.get(key, 0))
        other.append(sum(v for k, v in summed.items() if k not in drawn_set))

    for key in drawn:
        band: Dict[str, Any] = {
            "key": key, "label": key, "kind": "type",
            "points": [
                {"t": b, "v": per_type[key][i]} for i, b in enumerate(buckets)
            ],
        }
        # Say which band is OURS. It is drawn because the chart has to add up
        # to the graph, but a reader must be able to tell the platform's own
        # rollup from a type they ingested — and the ledger uses this to skip
        # the gone/new verdict, since a rebuild wiping and rewriting the
        # overlay is not a type disappearing from their data.
        if is_derived_edge_type(key):
            band["derived"] = True
        series.append(band)
    if any(other):
        series.append({
            "key": OTHER_KEY, "label": "Other", "kind": "type",
            "points": [{"t": b, "v": other[i]} for i, b in enumerate(buckets)],
        })

    return {
        "buckets": buckets,
        "series": series,
        "totals": totals,
        "metric": _BREAKDOWN_METRIC[breakdown],
    }


def types_that_vanished(
    observations: Sequence, *, breakdown: str,
) -> List[Dict[str, Any]]:
    """Types present at some point in the window that end it at zero.

    Reported separately from the series because a band falling to the axis is
    easy to miss on a stacked chart with eight of them, and because on a large
    graph the loss is often too small a share of the total to register as
    movement at all.
    """
    field = _BREAKDOWN_FIELD.get(breakdown)
    if not field:
        return []
    buckets = buckets_of(observations)
    if not buckets:
        return []
    filled = _carry_forward(observations, buckets)

    peak: Dict[str, int] = {}
    last: Dict[str, int] = {}
    for bucket in buckets:
        summed: Dict[str, int] = {}
        for obs in filled[bucket].values():
            for name, value in _counts(obs, field).items():
                summed[name] = summed.get(name, 0) + value
        for name, value in summed.items():
            peak[name] = max(peak.get(name, 0), value)
        last = summed
    return [
        {"type": name, "peak": peak[name]}
        for name in sorted(peak)
        if peak[name] > 0 and not last.get(name)
    ]
