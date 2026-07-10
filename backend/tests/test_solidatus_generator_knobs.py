"""Unit tests for the additive structural knobs on the Solidatus generator:
``--depth`` (deterministic hierarchy shape) and ``--orphans`` (uncontained
non-root nodes). The default path (no knobs) must stay byte-identical.
"""
import hashlib
import json
import os
import sys
from collections import Counter

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.scripts.generate_solidatus_model import SolidatusModelGenerator

# Hash of the UNMODIFIED generator's seed=7 output — proves the new knobs don't
# perturb the default random sequence. Update only on an intentional change.
BASELINE_SEED7_SHA256 = "0d5a165986f191ab2f8a2f9333fd15346eeed731ce89640c9499347dcb48486e"


def _prefixes(model):
    return Counter(eid.split("-", 1)[0] for eid in model["entities"])


def _contained_ids(model):
    return {kid for e in model["entities"].values() for kid in e.get("children", [])}


# ── Backward compatibility ───────────────────────────────────────────────────

def test_default_output_byte_identical():
    model = SolidatusModelGenerator(seed=7).generate()
    digest = hashlib.sha256(json.dumps(model, indent=2).encode()).hexdigest()
    assert digest == BASELINE_SEED7_SHA256
    assert len(model["entities"]) == 93
    assert len(model["transitions"]) == 43


def test_default_has_no_orphans():
    model = SolidatusModelGenerator(num_layers=3, seed=1).generate()
    uncontained = set(model["entities"]) - _contained_ids(model) - set(model["layers"])
    assert uncontained == set()


# ── --depth ──────────────────────────────────────────────────────────────────

def test_depth_2_is_flat_layer_to_attribute():
    model = SolidatusModelGenerator(num_layers=3, seed=1, depth=2).generate()
    prefixes = _prefixes(model)
    assert prefixes.get("OBJ", 0) == 0
    assert prefixes.get("GRP", 0) == 0
    for lid in model["layers"]:
        kids = model["entities"][lid].get("children", [])
        assert kids and all(k.startswith("ATR-") for k in kids)


def test_depth_3_is_layer_object_attribute():
    model = SolidatusModelGenerator(num_layers=3, seed=1, depth=3).generate()
    prefixes = _prefixes(model)
    assert prefixes.get("OBJ", 0) > 0
    assert prefixes.get("GRP", 0) == 0
    for lid in model["layers"]:
        for oid in model["entities"][lid]["children"]:
            assert oid.startswith("OBJ-")
            assert all(a.startswith("ATR-") for a in model["entities"][oid]["children"])


def test_depth_5_inserts_two_group_levels():
    model = SolidatusModelGenerator(num_layers=2, seed=1, depth=5).generate()
    lid = model["layers"][0]
    oid = model["entities"][lid]["children"][0]
    assert oid.startswith("OBJ-")
    g1 = model["entities"][oid]["children"][0]
    assert g1.startswith("GRP-")
    g2 = model["entities"][g1]["children"][0]
    assert g2.startswith("GRP-")
    assert all(a.startswith("ATR-") for a in model["entities"][g2]["children"])


# ── --orphans ────────────────────────────────────────────────────────────────

def test_orphans_are_uncontained_nonroot_attributes():
    model = SolidatusModelGenerator(num_layers=3, seed=1, orphans=4).generate()
    orphans = set(model["entities"]) - _contained_ids(model) - set(model["layers"])
    assert len(orphans) == 4
    assert all(o.startswith("ATR-") for o in orphans)


# ── determinism ──────────────────────────────────────────────────────────────

def test_depth_and_orphans_deterministic_under_seed():
    a = SolidatusModelGenerator(num_layers=3, seed=9, depth=5, orphans=3).generate()
    b = SolidatusModelGenerator(num_layers=3, seed=9, depth=5, orphans=3).generate()
    assert json.dumps(a) == json.dumps(b)


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
