"""Every failure code the back-channel provider emits must be explainable.

The diagnostics tab exists so that an operator mid-incident does not have
to leave it to find an article. That only holds if the code on the row is
one the tab can both *parse* and *explain*, and neither is automatic:

* it dropped five of these codes before rendering, because its parser
  matched one colon-separated segment of letters and the codes carried
  two segments and digits;
* and it had no entry for any of them, so even the two it could parse
  rendered nothing.

Both halves are fixed. This test is what stops them drifting apart again,
and it has to reach across languages to do it — the vocabulary is defined
in Python and catalogued in TypeScript, so nothing else can see both.

A code that is emitted and not catalogued is not a broken build for its
own sake: it is a row that says `backchannel_token_absent` to somebody
who has never seen that string and has no way to find out what it means.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

_PROVIDER = (
    Path(__file__).resolve().parent.parent
    / "auth_service" / "providers" / "backchannel.py"
)
_REASON_HINT = (
    Path(__file__).resolve().parent.parent.parent
    / "frontend" / "src" / "components" / "admin" / "sso" / "tabs"
    / "diagnostics" / "ReasonHint.tsx"
)

#: The shape ``codesIn`` accepts. Kept here as a literal rather than
#: imported, so a change on either side has to be made deliberately on
#: both — which is the whole point of this file.
_CODE_SHAPE = re.compile(r"^[a-z][a-z0-9_]*(:[a-z0-9_]+)*$")


def _emitted_codes() -> set[str]:
    """Every ``code=`` stem in the provider, including class defaults.

    An f-string like ``f"backchannel_idp_rejected:{status}"`` yields its
    stem, which is exactly what the catalogue matches on as a prefix.
    """
    source = _PROVIDER.read_text()
    return set(re.findall(r'code\s*=\s*f?"([a-z][a-z0-9_]*)', source))


def test_the_provider_actually_emits_codes():
    """Guards the guard. If the extraction stopped finding anything,
    every assertion below would pass by matching nothing."""
    codes = _emitted_codes()
    assert len(codes) >= 6, f"only found {sorted(codes)}"
    assert "backchannel_no_session" in codes


@pytest.mark.parametrize("code", sorted(_emitted_codes()))
def test_every_code_survives_the_diagnostics_parser(code):
    """``codesIn`` filters the summary before anything is explained, so a
    code it cannot match is invisible however well catalogued it is."""
    assert _CODE_SHAPE.match(code), (
        f"{code!r} would be dropped by codesIn before rendering"
    )


@pytest.mark.parametrize("code", sorted(_emitted_codes()))
def test_every_code_is_catalogued_in_the_diagnostics_tab(code):
    """Either as a `REASONS` key or as a `PREFIXED` entry."""
    catalogue = _REASON_HINT.read_text()
    assert f"{code}:" in catalogue or f"    {code}: {{" in catalogue, (
        f"{code!r} has no entry in ReasonHint.tsx — a row carrying it "
        f"would render no explanation"
    )


@pytest.mark.parametrize("code", sorted(_emitted_codes()))
def test_no_code_can_carry_free_text(code):
    """The reason this vocabulary exists.

    The codes used to be built as ``f"backchannel_rejected:{exc}"``,
    which put an exception's message — quotes, a URL, whatever a library
    says this week — into an audit summary that is parsed and rendered.
    The message still goes to the log; it must never come back here.
    """
    for forbidden in (" ", "'", '"', "/", "\\", "="):
        assert forbidden not in code, (
            f"{code!r} contains {forbidden!r}, so it is free text rather "
            f"than a code"
        )
