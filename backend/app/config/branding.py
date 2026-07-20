"""Application branding — environment-driven defaults.

The branding singleton row in the management DB (``application_branding``)
is the runtime source of truth, but these env vars supply the **default**
values: the migration seeds the row from them, and the repository falls
back to them for any column that is missing or NULL. The net effect:

  * A bare deployment can rebrand entirely through env vars — no UI step.
  * The admin Settings page overrides those defaults live, and the DB
    value wins once set.

Every default mirrors the current product identity so behaviour is
unchanged out of the box. Operators override any subset:

    APP_BRAND_NAME="Acme Lineage"
    APP_BRAND_ACCENT_COLOR="#0ea5e9"

Logo/favicon are URL-only here (env config); binary upload is a
DB-only concern handled through the admin API.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


# Current product identity — the out-of-the-box defaults.
_DEFAULT_NAME = "Context Visualization Platform"
_DEFAULT_SHORT_NAME = "CVP"
_DEFAULT_DESCRIPTION = "Interactive Data Lineage Visualization"
_DEFAULT_ACCENT_COLOR = "#6366f1"
_DEFAULT_COPYRIGHT = "© 2026 Context Visualization Platform"
_DEFAULT_SUPPORT_EMAIL = ""
_DEFAULT_LOGIN_TAGLINE = "Sign in to continue"
_DEFAULT_LOGO_URL = ""
_DEFAULT_FAVICON_URL = "/nexus-icon.svg"


@dataclass(frozen=True)
class BrandingDefaults:
    """Env-resolved branding defaults. Field shape mirrors the
    ``BrandingSnapshot`` the repo emits so the fallback is a 1:1 map."""
    app_name: str
    short_name: str
    description: str
    logo_url: str
    favicon_url: str
    accent_color: str
    copyright_text: str
    support_email: str
    login_tagline: str


def _env(name: str, default: str) -> str:
    """Read an env var, treating empty/whitespace as 'unset' so an
    accidental ``APP_BRAND_NAME=`` doesn't blank the product name."""
    val = os.getenv(name)
    if val is None:
        return default
    val = val.strip()
    return val if val else default


def get_branding_defaults() -> BrandingDefaults:
    """Resolve branding defaults from the environment. Called by the
    repo (per-field fallback) and the migration seed."""
    return BrandingDefaults(
        app_name=_env("APP_BRAND_NAME", _DEFAULT_NAME),
        short_name=_env("APP_BRAND_SHORT_NAME", _DEFAULT_SHORT_NAME),
        description=_env("APP_BRAND_DESCRIPTION", _DEFAULT_DESCRIPTION),
        logo_url=_env("APP_BRAND_LOGO_URL", _DEFAULT_LOGO_URL),
        favicon_url=_env("APP_BRAND_FAVICON_URL", _DEFAULT_FAVICON_URL),
        accent_color=_env("APP_BRAND_ACCENT_COLOR", _DEFAULT_ACCENT_COLOR),
        copyright_text=_env("APP_BRAND_COPYRIGHT", _DEFAULT_COPYRIGHT),
        support_email=_env("APP_BRAND_SUPPORT_EMAIL", _DEFAULT_SUPPORT_EMAIL),
        login_tagline=_env("APP_BRAND_LOGIN_TAGLINE", _DEFAULT_LOGIN_TAGLINE),
    )
