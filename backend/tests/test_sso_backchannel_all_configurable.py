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

_PROVIDER_SRC = (
    Path(__file__).resolve().parent.parent
    / "auth_service" / "providers" / "backchannel.py"
)
_ROUTER_SRC = (
    Path(__file__).resolve().parent.parent
    / "auth_service" / "api" / "router.py"
)
_SERVICE_SRC = (
    Path(__file__).resolve().parent.parent / "auth_service" / "service.py"
)

#: Where a published setting has to be picked up. If it is named by the
#: server and read by none of these, it reaches the browser and dies.
_FRONTEND_CONSUMERS = [
    Path(__file__).resolve().parent.parent.parent
    / "frontend" / "src" / "services" / "authService.ts",
    Path(__file__).resolve().parent.parent.parent
    / "frontend" / "src" / "components" / "auth" / "LoginPage.tsx",
]

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
def test_every_setting_has_a_real_input_in_the_form(field):
    """An input an operator can actually change, not a mention.

    This asserted `field in form` at first, and that weakness had
    consequences: it passed for a setting whose only appearance in the
    form was a type declaration, and the setting turned out to be inert
    — configurable, saveable, publishable, and unable to do anything.
    A test that reads the file for a string proves the string is in the
    file and nothing else.

    ``set('name', ...)`` is the form's one way of writing a value back,
    so requiring it is the difference between "declared" and "editable".
    """
    form = _FORM.read_text()
    assert re.search(rf"set\(\s*'{field}'", form), (
        f"{field!r} is read by the provider but has no input in "
        f"BackchannelSettingsForm.tsx — an operator cannot change it, "
        f"and nothing else would have told them"
    )


def test_everything_published_to_the_browser_is_consumed_by_it():
    """The seam that broke, guarded precisely.

    A setting can be present in the dataclass, validated, saved, given a
    form field — and still do nothing, because the code that would act
    on it was never written. That happened here: an option choosing who
    calls the gateway was configurable end to end and inert, because the
    browser was never told about it and no browser code ever looked.

    A blunt "is this read anywhere" check does not catch that; the
    setting was mentioned all over the provider. What distinguishes a
    working browser-bound setting from an inert one is both halves of
    one contract: the server publishes it by name, and the browser reads
    that name. So both halves are asserted, and neither alone is enough.
    """
    router_src = _ROUTER_SRC.read_text()
    published = re.findall(
        r'"(\w+)":\s*"(\w+)"',
        router_src[
            router_src.index("_BACKCHANNEL_PUBLIC_FIELDS = {"):
            router_src.index("def _public_config(")
        ],
    )
    assert published, "the publish whitelist could not be read"

    frontend = "".join(
        f.read_text() for f in _FRONTEND_CONSUMERS if f.exists()
    )
    for setting, alias in published:
        assert alias in frontend, (
            f"{setting!r} is published to the browser as {alias!r}, and no "
            f"browser code reads it. It would save, publish, and do "
            f"nothing at all."
        )
