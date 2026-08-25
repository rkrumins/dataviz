"""Every setting this kind reads must be reachable from the admin UI.

The point of the kind is that onboarding an enterprise is a form rather
than a release. That only holds if the form actually covers the
settings — and it is one-way drift: a field added to the provider is
invisible until somebody remembers the form, and nothing fails when they
do not. The operator finds out by not being able to configure a gateway.

So this reaches across languages, because nothing else can see both the
dataclass and the form.

A field may be covered either as a typed input or by being named in the
settings type the form is written against. What it may not be is absent
from both while the provider reads it.
"""
from __future__ import annotations

import dataclasses
import re
from pathlib import Path

import pytest

from backend.auth_service.providers.backchannel import BackchannelSettings

_FORM = (
    Path(__file__).resolve().parent.parent.parent
    / "frontend" / "src" / "components" / "admin" / "sso" / "settings"
    / "BackchannelSettingsForm.tsx"
)

#: Not settings an operator types. ``provider_id`` and ``provider_slug``
#: come from the row itself; the mapping and linking policy have their
#: own dedicated editors elsewhere in the drawer.
_NOT_TYPED_BY_AN_OPERATOR = {
    "provider_id", "provider_slug",
    "claim_mapping_override", "linking_policy",
}


def _settings_fields() -> list[str]:
    return [
        f.name for f in dataclasses.fields(BackchannelSettings)
        if f.name not in _NOT_TYPED_BY_AN_OPERATOR
    ]


def test_the_extraction_finds_the_settings():
    """Guards the guard: an extraction that found nothing would make
    every assertion below pass by matching nothing."""
    fields = _settings_fields()
    assert len(fields) >= 20, f"only found {fields}"
    assert "gateway_url" in fields


@pytest.mark.parametrize("field", _settings_fields())
def test_every_setting_is_reachable_from_the_form(field):
    form = _FORM.read_text()
    assert field in form, (
        f"{field!r} is read by the provider but appears nowhere in "
        f"BackchannelSettingsForm.tsx — an operator cannot configure it, "
        f"and nothing else would have told them"
    )


@pytest.mark.parametrize("field", [
    # The ones an integration cannot be completed without. These have to
    # be real inputs, not merely present in a type declaration — a field
    # an operator cannot see is a field they cannot fill in.
    "authenticate_url", "token_source_key",
    "gateway_url", "gateway_body_field", "gateway_token_path",
    "exchange_url", "exchange_body_field", "exchange_claims_path",
])
def test_the_load_bearing_settings_have_real_inputs(field):
    form = _FORM.read_text()
    assert re.search(rf"set\(\s*'{field}'", form), (
        f"{field!r} has no input in the form — it is declared but never "
        f"editable"
    )


def test_both_gateway_callers_are_offered():
    """Server-side and browser-side. Which one works depends on whether
    their gateway challenges for Kerberos, which is a question about
    their deployment rather than ours — so it has to be a setting."""
    form = _FORM.read_text()
    assert "gateway_via_browser" in form


def test_the_unsigned_acknowledgement_is_in_the_form_not_only_the_json():
    """It is the single most consequential thing an operator can turn on
    here — it accepts identities that cannot be verified. Reachable only
    through the Advanced JSON editor would mean it could be set without
    ever reading what it does."""
    form = _FORM.read_text()
    assert re.search(r"set\(\s*'gateway_trust_unsigned'", form)
