"""The replace guard's verdict: a replace that would delete most of its scope AND make most of it
again — a file whose rows name their entities by another key — is refused before it deletes
anything, unless sent with allowMassDelete. Its limits are the operator's (``IMPORT_REPLACE_GUARD*``)
and the verdict says which are in force."""
import pytest

from backend.app.services.versioning import config
from backend.app.services.versioning.import_export.import_worker import replace_verdict


@pytest.mark.parametrize("live, deletes, creates, state", [
    (1000, 500, 500, "blocked"),        # both at the limit
    (1000, 499, 1000, "passed"),        # deletes under it: a scope that really shrank
    (1000, 1000, 499, "passed"),        # creates under it: a file that really dropped rows
    (999, 999, 999, "passed"),          # a scope too small to judge
    (0, 0, 40, "passed"),               # a first load
])
def test_a_replace_is_refused_only_when_it_would_delete_and_make_most_of_its_scope(
        live, deletes, creates, state):
    verdict = replace_verdict(live, deletes, creates, allowed=False)
    assert verdict["state"] == state, verdict
    assert (verdict["live"], verdict["deletes"], verdict["creates"]) == (live, deletes, creates)


def test_allow_mass_delete_overrides_it_and_says_so():
    assert replace_verdict(1000, 900, 900, allowed=True)["state"] == "overridden"
    assert replace_verdict(1000, 100, 100, allowed=True)["state"] == "passed"


def test_the_operators_limits_are_the_ones_in_force_and_the_verdict_names_them(monkeypatch):
    monkeypatch.setattr(config, "IMPORT_REPLACE_GUARD_MIN_LIVE", 10)
    monkeypatch.setattr(config, "IMPORT_REPLACE_GUARD_DELETE_FRACTION", 0.9)
    monkeypatch.setattr(config, "IMPORT_REPLACE_GUARD_CREATE_FRACTION", 0.1)
    verdict = replace_verdict(20, 18, 2, allowed=False)
    assert verdict["state"] == "blocked"
    assert verdict["limits"] == {"minLive": 10, "deleteFraction": 0.9, "createFraction": 0.1}
    assert verdict["sources"] == dict.fromkeys(("minLive", "deleteFraction", "createFraction"), "platform")
    monkeypatch.setattr(config, "IMPORT_REPLACE_GUARD", False)
    assert replace_verdict(20, 18, 2, allowed=False)["state"] == "off"
