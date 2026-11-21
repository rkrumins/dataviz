"""BM25 over chunks, in memory — the lexical half of hybrid retrieval.

Small corpora only (the docs are a few thousand sections). It always works,
needs no model and no database, and is what retrieval falls back to when the
vector store or the embedding model is unavailable.
"""
from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from typing import Iterable

_STOP = frozenset(
    "a an and are as at be by can do does for from has have how i if in into is it its me my "
    "of on or our so that the their them then there these this to was we what when where which "
    "who why will with you your".split()
)
_WORD = re.compile(r"[a-z0-9]+")


def stem(word: str) -> str:
    for suffix in ("ingly", "ing", "edly", "ed", "ies", "es", "s"):
        if len(word) > len(suffix) + 2 and word.endswith(suffix):
            return word[: -len(suffix)] + ("y" if suffix == "ies" else "")
    return word


def tokenize(text: str) -> list[str]:
    return [stem(w) for w in _WORD.findall((text or "").lower()) if w not in _STOP and len(w) > 1]


class Bm25Index:
    def __init__(self, k1: float = 1.4, b: float = 0.75) -> None:
        self.k1, self.b = k1, b
        self._docs: list = []
        self._tf: list[Counter] = []
        self._len: list[int] = []
        self._df: Counter = Counter()
        self._postings: dict[str, list[int]] = defaultdict(list)
        self._avg = 1.0

    def build(self, items: Iterable, text_of) -> "Bm25Index":
        for item in items:
            tokens = tokenize(text_of(item))
            tf = Counter(tokens)
            index = len(self._docs)
            self._docs.append(item)
            self._tf.append(tf)
            self._len.append(len(tokens))
            for term in tf:
                self._df[term] += 1
                self._postings[term].append(index)
        self._avg = (sum(self._len) / len(self._len)) if self._len else 1.0
        return self

    def __len__(self) -> int:
        return len(self._docs)

    def search(self, query: str, limit: int = 10) -> list[tuple[object, float]]:
        terms = set(tokenize(query))
        if not terms or not self._docs:
            return []
        n = len(self._docs)
        scores: dict[int, float] = defaultdict(float)
        for term in terms:
            df = self._df.get(term)
            if not df:
                continue
            idf = math.log(1 + (n - df + 0.5) / (df + 0.5))
            for index in self._postings[term]:
                tf = self._tf[index][term]
                denom = tf + self.k1 * (1 - self.b + self.b * self._len[index] / self._avg)
                scores[index] += idf * tf * (self.k1 + 1) / denom
        best = sorted(scores.items(), key=lambda kv: -kv[1])[:limit]
        return [(self._docs[i], s) for i, s in best]
