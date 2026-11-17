"""What a change list row says before it is opened (``change_csv.field_summary``): counts, then the
first few fields — the named ones in reading order, then properties edited, added, removed —
values clipped. The same cases are checked against the frontend's rules (fieldSummary.parity)."""
import json
from pathlib import Path

import pytest

from backend.app.services.versioning.change_csv import field_summary

CASES = json.loads((Path(__file__).parent / "fixtures" / "field_summary_parity.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_the_summary_agrees_with_the_shared_cases(case):
    got = field_summary(case["before"], case["after"], case["kind"])
    want = case["expect"]
    assert {k: got[k] for k in ("changed", "added", "removed", "total")} == {
        k: want[k] for k in ("changed", "added", "removed", "total")}
    assert [t["label"] for t in got["top"]] == want["top"]


def test_values_are_clipped_and_say_so():
    got = field_summary({"description": "a" * 500, "tags": [str(i) for i in range(40)]},
                        {"description": "b" * 500, "tags": []}, "node")
    by = {t["label"]: t for t in got["top"]}
    assert len(by["Description"]["after"]) == 160 and by["Description"]["clipped"] is True
    assert len(by["Tags"]["before"]) == 12 and by["Tags"]["clipped"] is True


def test_an_unchanged_entity_says_nothing_changed():
    assert field_summary({"displayName": "a"}, {"displayName": "a"}, "node") == {
        "changed": 0, "added": 0, "removed": 0, "total": 0, "top": []}
