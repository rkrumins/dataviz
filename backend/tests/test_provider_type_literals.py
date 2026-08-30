"""Lint test — fails CI if a provider-identity dispatch antipattern is
reintroduced into ``backend/app``, ``backend/common`` or
``backend/insights_service``.

PR 2 (the provider catalog) removed every live ``provider_type == "..."``
dispatch chain, every ``isinstance(provider, SomeConcreteProvider)`` check,
and the old string-keyed ``PROVIDER_CAPABILITIES`` dict from this tree,
replacing them with ``backend.common.providers.catalog`` (a registration
point per provider type) and ``capability_for(...).supports(...)``
(feature flags on the catalog descriptor). Grepping today finds the old
shapes only in docstrings/comments *describing* what was removed (e.g.
``catalog/neo4j.py``'s ``_build`` docstring, which says it *replaces*
``manager.py``'s former ``elif provider_type == "neo4j":`` branch).

Nothing else stops the pattern coming back. The next person who needs a
provider-specific branch will reach for ``if provider_type == "falkordb"``
because it is the obvious thing to write, with no surviving example of the
catalog to copy from instead. This test is what tells them one exists.

Deliberately a source-text grep, not an import-and-introspect test, so it
runs without spinning up the full conftest stack (which currently needs
auth-service deps not installed in every CI lane) — same reasoning, and
the same docstring/comment-stripping approach, as
``test_falkordb_no_unlabeled_unwind_match.py``.

Docstrings and full-line comments are stripped before matching, since
every current hit in the tree is prose describing the removed pattern,
not the pattern itself. The stripped span is replaced by a matching
number of newlines rather than deleted outright, so reported line numbers
still point at the real, original line.
"""
from __future__ import annotations

import re
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parent.parent

# Only these three: everywhere a provider could plausibly be dispatched on
# by hardcoded identity. ``backend/insights_service`` is not under
# ``backend/app`` but calls into the same ``ProviderManager`` /
# ``GraphDataProvider`` machinery (see its own ``discovery.py`` docstring:
# "instantiates a provider via the static
# ``ProviderManager._create_provider_instance`` helper") and, as verified
# below, is exactly where one of the three still-live exemptions lives.
_SCAN_ROOTS = ("app", "common", "insights_service")

# Directories that may contain provider-identity text that isn't
# production dispatch (fixtures, one-off scripts, generated migration
# code) -- none currently exist under the scan roots, but excluded by
# name wherever they might appear, matching the plan's own scan spec.
_EXCLUDED_DIR_PARTS = {"tests", "scripts", "alembic", "__pycache__"}


def _iter_scanned_files():
    for root_name in _SCAN_ROOTS:
        root = _BACKEND_DIR / root_name
        for path in sorted(root.rglob("*.py")):
            rel_parts = path.relative_to(_BACKEND_DIR).parts
            if any(part in _EXCLUDED_DIR_PARTS for part in rel_parts):
                continue
            yield path


def _blank_span(match: "re.Match[str]") -> str:
    """Replace a matched span with newlines only, so stripping a
    docstring/comment can't shift the line numbers of the code after it.
    """
    return "\n" * match.group(0).count("\n")


def _strip_docs_and_comments(src: str) -> str:
    src = re.sub(r'"""(?:.|\n)*?"""', _blank_span, src)
    src = re.sub(r"'''(?:.|\n)*?'''", _blank_span, src)
    # Full-line comments only (leading whitespace then '#' to end of
    # line): a trailing ``code  # comment`` is left alone, same tradeoff
    # test_falkordb_no_unlabeled_unwind_match.py makes, for the same
    # reason -- '#' can appear inside a string literal, so a per-line
    # trailing-comment stripper is more likely to corrupt real code than
    # to earn its keep. No hit in this file relies on it either way.
    src = re.sub(r"(?m)^[ \t]*#.*$", "", src)
    return src


def _scan(pattern: "re.Pattern[str]", allowed: dict) -> list:
    """Return violation strings for every match of ``pattern`` outside
    the ``allowed`` map (``{relative posix path: reason}``).
    """
    violations = []
    for path in _iter_scanned_files():
        rel = path.relative_to(_BACKEND_DIR).as_posix()
        src = _strip_docs_and_comments(path.read_text(encoding="utf-8"))
        for m in pattern.finditer(src):
            if rel in allowed:
                continue
            line_no = src.count("\n", 0, m.start()) + 1
            violations.append(f"  {rel}:{line_no}: {m.group(0)!r}")
    return violations


# ---------------------------------------------------------------------------
# Check 1 — ``provider_type`` compared to a hardcoded string, directly or
# via a ``.lower()`` normalization. Two regexes because both shapes are
# live in the tree today: a bare ``row.provider_type != "falkordb"`` and a
# normalized ``(p.provider_type or "").lower() == "falkordb"``. The second
# form would evade a regex that requires ``provider_type`` immediately
# adjacent to the operator, so it gets its own pattern keyed on the known
# provider ids instead of on the ``provider_type`` token.
# ---------------------------------------------------------------------------

_DIRECT_COMPARISON_RE = re.compile(r"provider_type\s*(?:==|!=)\s*[\"']")
_NORMALIZED_COMPARISON_RE = re.compile(
    r"\.lower\(\)\s*(?:==|!=)\s*[\"'](?:falkordb|neo4j|spanner|datahub|mock)[\"']"
)

# Re-derived by direct verification against this tree (2026-08-30), not
# transcribed from the plan's §2.6 table: of the six sites §2.6 named as
# deliberately kept, only these two still match either regex above.
# `system_status/probes.py` (service-key dict labels, not comparisons),
# and the four `scripts/*` sites, are outside `_SCAN_ROOTS` entirely or
# no longer match anything -- they need no entry.
_PROVIDER_TYPE_COMPARISON_ALLOWED = {
    "app/providers/falkor_graph_registry.py": (
        "filters a DB row by its stored type before ever constructing a "
        "provider, then refuses (ProviderConfigurationError) if the row "
        "isn't falkordb -- a data-integrity check on a query result, not "
        "a dispatch to type-specific behavior."
    ),
    "app/api/v1/endpoints/redis_config.py": (
        "same shape as the entry above: filters DB-loaded provider rows "
        "to build an admin-UI list of falkordb-backed providers that "
        "carry their own separate Redis instance. Never constructs a "
        "provider or branches into provider-specific behavior."
    ),
    "insights_service/discovery.py": (
        "NOT the same shape as the two entries above -- this one gates "
        "whether FalkorDB-specific registry-drift reconciliation runs "
        "(_detect_registry_drift), because other providers' "
        "list_graphs() isn't exhaustive and the same reconciliation "
        "would misread their real assets as permanently 'missing'. That "
        "is genuine provider-identity behavior dispatch, the same shape "
        "versioning.py used to have before it moved to "
        "capability_for(...).supports(BLANK_MODELS) -- the honest fix "
        "here is the same move, e.g. a ProviderFeature this reconciler "
        "checks instead. Kept as-is because backend/insights_service "
        "was in no T-C/T-E/T-F/T-G file list for this PR, and this task "
        "(T-H) is test-only; worth a follow-up task, not a T-H fix."
    ),
}


def test_no_provider_type_string_literal_dispatch():
    """``provider_type`` must never be compared to a hardcoded provider
    name. Use ``backend.common.providers.catalog`` (construction) or
    ``capability_for(provider_type).supports(ProviderFeature.X)``
    (behavior gating) instead.
    """
    violations = _scan(_DIRECT_COMPARISON_RE, _PROVIDER_TYPE_COMPARISON_ALLOWED)
    violations += _scan(_NORMALIZED_COMPARISON_RE, _PROVIDER_TYPE_COMPARISON_ALLOWED)
    assert not violations, (
        "provider_type compared to a hardcoded string literal outside the "
        "allow-list in this file. Route through the catalog / "
        "capability_for(...) instead. Offending location(s):\n"
        + "\n".join(violations)
    )


# ---------------------------------------------------------------------------
# Check 2 — isinstance() against a concrete provider implementation. The
# ABC (GraphDataProvider) is intentionally not in this list: isinstance
# against the interface is normal conformance checking, not the
# name-based dispatch this guards against. If that ever needs excluding
# too, add it here the same way, with the same kind of reason -- it does
# not appear anywhere in the scanned tree today.
# ---------------------------------------------------------------------------

_ISINSTANCE_CONCRETE_PROVIDER_RE = re.compile(
    r"isinstance\([^)]*\b(?:FalkorDBProvider|Neo4jProvider|SpannerProvider|DataHubGraphQLProvider)\b"
)

_ISINSTANCE_ALLOWED: dict = {}  # no live exemption found; re-add here if one is ever justified


def test_no_isinstance_concrete_provider_dispatch():
    """``isinstance(provider, FalkorDBProvider)`` (or any other concrete
    provider class) must never appear as a case-analysis dispatch. Use
    ``supports_feature(provider, ProviderFeature.X)`` instead -- it
    recognizes any provider with the capability, not just the one that
    happened to be first.
    """
    violations = _scan(_ISINSTANCE_CONCRETE_PROVIDER_RE, _ISINSTANCE_ALLOWED)
    assert not violations, (
        "isinstance() dispatch against a concrete provider class outside "
        "the allow-list in this file. Use "
        "supports_feature(provider, ProviderFeature.X) instead. "
        "Offending location(s):\n" + "\n".join(violations)
    )


# ---------------------------------------------------------------------------
# Check 3 — the deleted string-keyed capability dict
# (``PROVIDER_CAPABILITIES = {"falkordb": ProviderCapability(...), ...}``).
# T-E deleted it in favor of ``ProviderDescriptor.capabilities`` on each
# catalog entry; test_provider_capability.py separately pins that the
# name itself is gone. This regex guards the shape, in case it comes back
# under a different name.
# ---------------------------------------------------------------------------

_CAPABILITY_DICT_LITERAL_RE = re.compile(
    r"[\"'](?:falkordb|neo4j|spanner|datahub)[\"']\s*:\s*ProviderCapability"
)

_CAPABILITY_DICT_ALLOWED: dict = {}  # no live exemption found


def test_no_provider_capability_dict_literal():
    """A provider-name-keyed ``ProviderCapability`` dict literal must not
    reappear -- capabilities live on the catalog descriptor now.
    """
    violations = _scan(_CAPABILITY_DICT_LITERAL_RE, _CAPABILITY_DICT_ALLOWED)
    assert not violations, (
        "A string-keyed ProviderCapability dict literal reappeared "
        "(PROVIDER_CAPABILITIES was deleted in T-E; capabilities belong "
        "on the catalog descriptor). Offending location(s):\n"
        + "\n".join(violations)
    )
