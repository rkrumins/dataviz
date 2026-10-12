"""An announcement CTA URL must not carry an executable scheme.

The global banner renders ``ctaUrl`` straight into an ``href`` shown to
every signed-in user. A ``javascript:`` CTA therefore turns "edit an
announcement" into stored XSS against the whole platform. Writing
announcements is admin-only, which bounds who can try it -- not what it
would do, and not the admin-to-everyone escalation it represents.

Rejected rather than sanitised: there is no safe reading of a
``javascript:`` CTA to recover, and a silent rewrite would hide the mistake
from the admin who made it.

The client repeats this rule in ``frontend/src/utils/safeHref.ts`` for rows
written before this validator existed. The two tables are deliberately
identical -- keep them that way.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.common.models.management import (
    AnnouncementCreateRequest,
    AnnouncementUpdateRequest,
)

_ACCEPTED = [
    "https://docs.example.com/release-notes",
    "http://intranet.corp/notice",
    "HTTPS://SHOUTY.EXAMPLE/x",
    "/settings/announcements",
    "/",
]

_REFUSED = [
    "javascript:alert(document.cookie)",
    "JaVaScRiPt:alert(1)",
    "  javascript:alert(1)  ",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "//evil.example/phish",          # protocol-relative: leaves the origin
    "/\\evil.example",               # browsers read "\" as "/" here
    "/\\/evil.example",
    "evil.example",
    "mailto:someone@example.com",
]


def _create(url):
    return AnnouncementCreateRequest(title="t", message="m", ctaUrl=url)


def _update(url):
    return AnnouncementUpdateRequest(ctaUrl=url)


@pytest.mark.parametrize("build", [_create, _update], ids=["create", "update"])
@pytest.mark.parametrize("url", _ACCEPTED)
def test_an_http_or_relative_cta_is_accepted(build, url):
    assert build(url).cta_url == url.strip()


@pytest.mark.parametrize("build", [_create, _update], ids=["create", "update"])
@pytest.mark.parametrize("url", _REFUSED)
def test_an_executable_or_off_origin_cta_is_refused(build, url):
    with pytest.raises(ValidationError) as err:
        build(url)
    assert "ctaUrl" in str(err.value)


@pytest.mark.parametrize("build", [_create, _update], ids=["create", "update"])
@pytest.mark.parametrize("url", [None, "", "   "])
def test_an_absent_cta_stays_absent(build, url):
    """Blank normalises to None rather than to an empty href."""
    assert build(url).cta_url is None


def test_the_update_model_is_covered_too():
    """Guards against the validator being added to create only -- the
    original gap was that nothing checked this field on either path, and
    an update-only bypass would be just as good for an attacker."""
    assert "cta_url" in AnnouncementUpdateRequest.model_fields
    with pytest.raises(ValidationError):
        AnnouncementUpdateRequest(ctaUrl="javascript:alert(1)")
