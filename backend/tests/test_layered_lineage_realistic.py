"""The --realistic lineage mode: coherent, column-level, end-to-end flows.

Unlike the default random-fill (adjacent-layer random attr→attr, no complete
source→sink paths), realistic mode carries data CONCEPTS through every layer,
so a controllable fraction of source columns trace end-to-end with semantic
correspondence, and fan/density/table-level rollup are tunable.
"""
import json
import os
import sys
from collections import defaultdict, deque

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.scripts.generate_layered_lineage_model import LayeredLineageModelGenerator


def _layer_of(m):
    lo = {}
    for li, lid in enumerate(m["layers"]):
        stack = [lid]
        while stack:
            e = stack.pop()
            lo[e] = li
            stack.extend(m["entities"].get(e, {}).get("children", []))
    return lo


def _col_lineage(m):
    srcs = defaultdict(list)
    for t in m["transitions"].values():
        s, d = t["source"], t["target"]
        if s.startswith("ATR-") and d.startswith("ATR-"):
            srcs[s].append(d)
    return srcs


def test_realistic_backbone_traces_source_to_sink():
    L = 10
    m = LayeredLineageModelGenerator(num_layers=L, seed=1, realistic=True, e2e_fraction=0.5).generate()
    lo = _layer_of(m)
    srcs = _col_lineage(m)
    last = L - 1

    def reaches_last(n):
        seen = {n}
        q = deque([n])
        while q:
            x = q.popleft()
            if lo.get(x) == last:
                return True
            for c in srcs[x]:
                if c not in seen:
                    seen.add(c)
                    q.append(c)
        return False

    l0 = [a for a, li in lo.items() if li == 0 and a.startswith("ATR-")]
    e2e = sum(reaches_last(a) for a in l0)
    assert e2e > 0, "at least one source-layer column must trace end-to-end to the last layer"


def test_realistic_longest_path_spans_full_depth():
    L = 8
    m = LayeredLineageModelGenerator(num_layers=L, seed=3, realistic=True).generate()
    srcs = dict(_col_lineage(m))
    memo = {}

    def depth(n):
        if n not in memo:
            memo[n] = 1 + max((depth(c) for c in srcs.get(n, [])), default=-1)
        return memo[n]

    assert max((depth(n) for n in list(srcs)), default=0) >= L - 1


def test_realistic_carry_edges_are_semantic():
    m = LayeredLineageModelGenerator(num_layers=5, seed=1, realistic=True).generate()
    ents = m["entities"]

    def concept(aid):
        return ents.get(aid, {}).get("properties", {}).get("concept")

    carries = [t for t in m["transitions"].values()
               if concept(t["source"]) is not None and concept(t["source"]) == concept(t["target"])]
    assert carries, "carry edges must connect columns of the same concept (email→email)"


def test_realistic_lineage_is_column_level_by_default():
    m = LayeredLineageModelGenerator(num_layers=4, seed=1, realistic=True).generate()
    assert all(t["source"].startswith("ATR-") and t["target"].startswith("ATR-")
               for t in m["transitions"].values())


def test_realistic_fan_in_creates_joins():
    m = LayeredLineageModelGenerator(num_layers=4, seed=1, realistic=True, fan_in=(3, 3)).generate()
    fanin = defaultdict(int)
    for t in m["transitions"].values():
        fanin[t["target"]] += 1
    assert max(fanin.values()) >= 2, "fan_in>1 must produce columns with multiple inbound edges"


def test_realistic_table_lineage_opt_in():
    with_tl = LayeredLineageModelGenerator(num_layers=4, seed=1, realistic=True, table_lineage=True).generate()
    obj_edges = [t for t in with_tl["transitions"].values()
                 if t["source"].startswith("OBJ-") and t["target"].startswith("OBJ-")]
    assert obj_edges, "--table-lineage must emit object→object edges"

    without = LayeredLineageModelGenerator(num_layers=4, seed=1, realistic=True).generate()
    assert not any(t["source"].startswith("OBJ-") for t in without["transitions"].values())


def test_realistic_is_deterministic():
    a = LayeredLineageModelGenerator(num_layers=6, seed=9, realistic=True, fan_in=(1, 3), fan_out=(1, 2),
                                table_lineage=True).generate()
    b = LayeredLineageModelGenerator(num_layers=6, seed=9, realistic=True, fan_in=(1, 3), fan_out=(1, 2),
                                table_lineage=True).generate()
    assert json.dumps(a) == json.dumps(b)


def test_default_mode_has_no_concepts():
    m = LayeredLineageModelGenerator(num_layers=4, seed=1).generate()  # not realistic
    assert not any("concept" in e.get("properties", {}) for e in m["entities"].values())


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
