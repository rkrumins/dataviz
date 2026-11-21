"""Ranking: dense and lexical results, fused.

Reciprocal rank fusion (RRF, k = 60) combines rankings without having to make
their scores comparable: an item's fused score is Σ 1 / (k + rank) over the
rankings it appears in. Dense retrieval finds what is meant ("supplier
delays" → a section about late shipments); lexical finds what is said (an
exact setting name, an error code). Either alone is worse than both.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

RRF_K = 60


@dataclass
class Hit:
    id: str
    source_id: str
    title: str
    heading: str
    url: str
    text: str
    score: float = 0.0
    source: str = "product"
    trust: str = "product"
    metadata: dict = field(default_factory=dict)


def fuse(*rankings: Iterable[Hit], limit: int = 8, key=lambda h: h.id) -> list[Hit]:
    scores: dict[str, float] = {}
    best: dict[str, Hit] = {}
    for ranking in rankings:
        for rank, hit in enumerate(ranking):
            k = key(hit)
            scores[k] = scores.get(k, 0.0) + 1.0 / (RRF_K + rank + 1)
            best.setdefault(k, hit)
    ordered = sorted(scores, key=lambda k: -scores[k])[:limit]
    out = []
    for k in ordered:
        hit = best[k]
        hit.score = scores[k]
        out.append(hit)
    return out
