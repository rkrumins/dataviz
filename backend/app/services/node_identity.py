"""Node identity + display-name resolution — ONE chain, four scopes.

The platform keys every node on a canonical ``urn`` and renders it from
``displayName``. Onboarded third-party graphs key nodes by something else
(``id``, ``_id``, ``identifier``) and hold the human name under ``name`` /
``title`` / ``label``. Declaring that mapping used to be possible only per data
source, which meant an operator onboarding fifty graphs off one DataHub export
had to set the same value fifty times — and a platform-wide preference could not
be expressed at all.

This module is the single resolution chain, in the shape of
``aggregation.service.resolve_rebuild_interval``:

    data source → provider → workspace → platform default → code default

``None`` at a level means "unset, fall through". An empty string is normalized
to ``None`` at the repository boundary, so "clear this override" and "never set
it" are the same state — there is no way to express "explicitly inherit" versus
"explicitly default", and there does not need to be.

**Why provider outranks workspace.** They are not a containment chain: a data
source lives inside exactly one workspace but merely *references* a provider.
The provider describes what the graphs on that connection actually look like,
which is what an identity property IS; a workspace only expresses a team's
preference for sources it onboards. When both speak, the one describing the data
wins.

Every consumer resolves through here — the aggregation trigger that freezes the
value onto a job row, the read path that injects it into a provider, and the
API that reports it back with provenance — so the badge in the UI can never
disagree with what the workers actually ran.
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger(__name__)

#: The canonical property the platform keys nodes on. A source that already
#: conforms resolves to this and every mapping path short-circuits.
DEFAULT_IDENTITY_PROPERTY = "urn"

#: The source property a node's human name is read from when nothing is mapped.
#: Note this is NOT ``displayName``: ``displayName`` is the platform's canonical
#: TARGET, and ``name_property`` names the SOURCE it is filled from. The
#: historical default has always been ``name`` and changing it would silently
#: re-point every existing source.
DEFAULT_NAME_PROPERTY = "name"

#: Provenance labels, most specific first. Returned alongside the resolved value
#: so the UI can say "inherited from provider" instead of guessing.
SOURCE_DATA_SOURCE = "data_source"
SOURCE_PROVIDER = "provider"
SOURCE_WORKSPACE = "workspace"
SOURCE_GLOBAL = "global"
SOURCE_DEFAULT = "default"

#: How long the platform-settings row is cached in-process. Same rationale (and
#: same value) as the aggregation cadence cache: the resolver is on the trigger
#: and read paths, and neither should hammer a single-row table.
_SETTINGS_CACHE_TTL_S = 30.0
_GLOBAL_DEFAULTS_CACHE: dict = {"defaults": None, "at": 0.0}


@dataclass(frozen=True)
class PlatformNodeIdentityDefaults:
    """The platform-wide bottom of the chain. Both fields ``None`` = unset."""

    identity_property: Optional[str] = None
    name_property: Optional[str] = None


@dataclass(frozen=True)
class ResolvedNodeIdentity:
    """The effective mapping for ONE data source, with provenance.

    ``identity_property`` / ``name_property`` are always populated — the code
    defaults are the floor. The ``*_source`` fields say which level won, and are
    what the UI renders as "inherited from …".
    """

    identity_property: str = DEFAULT_IDENTITY_PROPERTY
    name_property: str = DEFAULT_NAME_PROPERTY
    identity_source: str = SOURCE_DEFAULT
    name_source: str = SOURCE_DEFAULT

    @property
    def is_default(self) -> bool:
        """True when the source conforms to the platform's own schema and no
        translation is needed anywhere — the cheap short-circuit every consumer
        checks before doing mapping work."""
        return (
            self.identity_property == DEFAULT_IDENTITY_PROPERTY
            and self.name_property == DEFAULT_NAME_PROPERTY
        )

    @property
    def identity_is_mapped(self) -> bool:
        """True when nodes are keyed by something other than ``urn``."""
        return self.identity_property != DEFAULT_IDENTITY_PROPERTY

    @property
    def name_is_mapped(self) -> bool:
        """True when the human name lives somewhere other than ``name``."""
        return self.name_property != DEFAULT_NAME_PROPERTY


def _clean(value: Any) -> Optional[str]:
    """Normalize one level's raw column value to ``str | None``.

    Blank / whitespace-only reads as unset so a cleared field falls through
    instead of resolving to the empty string and producing ``n.``.
    """
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _pick(levels) -> tuple[str, str]:
    """First non-None value across ``(value, source_label)`` pairs, else the
    code default carried as the LAST pair."""
    for value, source in levels:
        cleaned = _clean(value)
        if cleaned is not None:
            return cleaned, source
    # The caller always terminates the chain with a non-None default.
    raise ValueError("resolution chain has no default")


def resolve_node_identity(
    *,
    data_source: Any = None,
    provider: Any = None,
    workspace: Any = None,
    defaults: Optional[PlatformNodeIdentityDefaults] = None,
) -> ResolvedNodeIdentity:
    """Resolve the effective mapping. PURE — no I/O, no session.

    Accepts ORM rows, Pydantic models or plain objects: every level is read with
    ``getattr``, so a caller that only has some of the chain (a test, or the
    self-heal path that holds just the data source) can pass what it has and the
    rest falls through.

    The two properties resolve INDEPENDENTLY — a provider that maps only the
    identity does not also drag its display-name default over a workspace that
    explicitly set one. Mixed provenance is normal and expected.
    """
    defaults = defaults or PlatformNodeIdentityDefaults()

    identity_property, identity_source = _pick((
        (getattr(data_source, "identity_property", None), SOURCE_DATA_SOURCE),
        (getattr(provider, "identity_property", None), SOURCE_PROVIDER),
        (getattr(workspace, "identity_property", None), SOURCE_WORKSPACE),
        (defaults.identity_property, SOURCE_GLOBAL),
        (DEFAULT_IDENTITY_PROPERTY, SOURCE_DEFAULT),
    ))
    name_property, name_source = _pick((
        (getattr(data_source, "name_property", None), SOURCE_DATA_SOURCE),
        (getattr(provider, "name_property", None), SOURCE_PROVIDER),
        (getattr(workspace, "name_property", None), SOURCE_WORKSPACE),
        (defaults.name_property, SOURCE_GLOBAL),
        (DEFAULT_NAME_PROPERTY, SOURCE_DEFAULT),
    ))
    return ResolvedNodeIdentity(
        identity_property=identity_property,
        name_property=name_property,
        identity_source=identity_source,
        name_source=name_source,
    )


# ── provider back-compat ────────────────────────────────────────────────────

def provider_identity_from_extra_config(provider: Any) -> tuple[Optional[str], Optional[str]]:
    """The provider's mapping as expressed the OLD way, in
    ``extra_config.schemaMapping``.

    Before this module the only provider-level mapping was ``SchemaMapping``
    (``graph/adapters/schema_mapping.py``), read by the Neo4j and Spanner
    adapters. Those installs must keep working untouched, so a provider whose
    new columns are NULL still resolves through its stored ``schemaMapping``.
    The columns win when both are set; nothing is migrated or rewritten.

    One asymmetry is deliberate: ``SchemaMapping.display_name_field`` names the
    source property that maps ONTO ``displayName``, which is exactly what
    ``name_property`` means, so they map across directly. But its default is the
    literal ``"displayName"`` while ours is ``"name"`` — so a value equal to
    either default is treated as "not configured" and falls through rather than
    silently re-pointing a source that never asked for it.
    """
    raw = getattr(provider, "extra_config", None)
    if not raw:
        return None, None
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
        mapping = (parsed or {}).get("schemaMapping") or {}
        if isinstance(mapping, str):
            mapping = json.loads(mapping)
    except (json.JSONDecodeError, TypeError, AttributeError) as exc:
        logger.debug("provider schemaMapping unreadable (ignored): %s", exc)
        return None, None
    if not isinstance(mapping, dict):
        return None, None

    # Persisted keys are snake_case — ``SchemaMapping`` is a plain Pydantic
    # model with no aliases, and the provider wizard writes ``identity_field``.
    # The camelCase spellings are accepted too so a hand-edited config or a
    # future alias-enabled model does not read as "unset".
    identity = _clean(
        mapping.get("identity_field") or mapping.get("identityField")
    )
    if identity == DEFAULT_IDENTITY_PROPERTY:
        identity = None
    name = _clean(
        mapping.get("display_name_field") or mapping.get("displayNameField")
    )
    if name in ("displayName", DEFAULT_NAME_PROPERTY):
        name = None
    return identity, name


class _ProviderView:
    """A provider row with its legacy ``schemaMapping`` folded in, so
    :func:`resolve_node_identity` sees ONE provider level instead of having to
    know about the back-compat path."""

    __slots__ = ("identity_property", "name_property")

    def __init__(self, provider: Any):
        legacy_identity, legacy_name = provider_identity_from_extra_config(provider)
        self.identity_property = (
            _clean(getattr(provider, "identity_property", None)) or legacy_identity
        )
        self.name_property = (
            _clean(getattr(provider, "name_property", None)) or legacy_name
        )


# ── loading (the only I/O in this module) ───────────────────────────────────

def invalidate_global_defaults_cache() -> None:
    """Drop the cached platform row so the next read reflects a just-written
    value in THIS process. Cross-process staleness is bounded by the TTL."""
    _GLOBAL_DEFAULTS_CACHE["at"] = 0.0


async def read_global_defaults(session) -> PlatformNodeIdentityDefaults:
    """The persisted platform defaults, cached in-process for ≤ the TTL.

    NEVER raises: a missing table (a deployment mid-migration) or an unreadable
    row degrades to "unset", which resolves to the code defaults — the exact
    behaviour that predates this feature.
    """
    now = time.monotonic()
    cached = _GLOBAL_DEFAULTS_CACHE
    if cached["defaults"] is not None and (now - cached["at"]) < _SETTINGS_CACHE_TTL_S:
        return cached["defaults"]

    defaults = PlatformNodeIdentityDefaults()
    try:
        from backend.app.db.models import PlatformSettingsORM

        row = await session.get(PlatformSettingsORM, 1)
        if row is not None:
            defaults = PlatformNodeIdentityDefaults(
                identity_property=_clean(row.identity_property),
                name_property=_clean(row.name_property),
            )
    except Exception as exc:  # pragma: no cover - defensive, never fail a read
        logger.warning(
            "Platform node-identity defaults read failed (using code defaults): %s",
            exc,
        )
        return defaults
    cached["defaults"] = defaults
    cached["at"] = now
    return defaults


async def scopes_resolving_through(
    session, *, provider_id: str = None, workspace_id: str = None,
) -> list:
    """``[(workspace_id, data_source_id), …]`` for the sources a change at this
    scope actually reaches.

    Sources that override the property themselves are EXCLUDED — their resolved
    value did not move, so marking them stale would demand a re-aggregation that
    changes nothing. Pass neither argument to get every source (a platform
    default changed).

    Deliberately over-selects in one direction: a source is included when it
    overrides only ONE of the two properties, because the other one did move.
    """
    from sqlalchemy import or_, select

    from backend.app.db.models import WorkspaceDataSourceORM

    stmt = select(
        WorkspaceDataSourceORM.workspace_id, WorkspaceDataSourceORM.id,
    ).where(
        or_(
            WorkspaceDataSourceORM.identity_property.is_(None),
            WorkspaceDataSourceORM.name_property.is_(None),
        )
    )
    if provider_id:
        stmt = stmt.where(WorkspaceDataSourceORM.provider_id == provider_id)
    if workspace_id:
        stmt = stmt.where(WorkspaceDataSourceORM.workspace_id == workspace_id)
    return [(ws, ds) for (ws, ds) in (await session.execute(stmt)).all() if ws and ds]


async def invalidate_node_identity(session, scopes, reason: str) -> None:
    """Mark every data source in ``scopes`` as needing re-aggregation, and drop
    the caches that would otherwise serve the old mapping.

    A mapping change invalidates more than it looks like it should. The
    materialized ``:AGGREGATED`` edges were resolved under the OLD identity, the
    conformance stamp has written the old values onto the nodes, and the
    resolved-ontology cache is holding the old mapping on every pod. So:

    * the aggregation drift fingerprint gets a sentinel, which is what makes the
      UI report drift and prompt for a re-run;
    * the replay guard is cleared, so the next trigger cannot short-circuit onto
      the now-stale job;
    * the resolved-ontology generation is bumped (every pod re-resolves on its
      next read), the persisted schema facet is reset, and the hot aggregated-read
      generation is bumped.

    Deliberately does NOT trigger the re-aggregation. One edit at provider or
    platform scope can reach hundreds of sources, and quietly enqueueing that
    much work is not a decision this function gets to make — it makes the state
    visible and lets an operator choose.

    Best-effort throughout: cache plumbing must never fail the mutation that
    caused it. ``scopes`` is enumerated once and reused by every step.
    """
    if not scopes:
        return
    ds_ids = [ds for (_ws, ds) in scopes]

    try:
        from sqlalchemy import update as _sa_update

        from backend.app.services.aggregation.models import (
            AggregationDataSourceStateORM, AggregationJobORM,
        )
        await session.execute(
            _sa_update(AggregationJobORM)
            .where(AggregationJobORM.data_source_id.in_(ds_ids))
            .where(AggregationJobORM.ontology_fingerprint.isnot(None))
            .values(ontology_fingerprint=None)
        )
        await session.execute(
            _sa_update(AggregationDataSourceStateORM)
            .where(AggregationDataSourceStateORM.data_source_id.in_(ds_ids))
            .values(graph_fingerprint=f"stale:{reason}")
        )
        await session.commit()
    except Exception as exc:
        logger.warning(
            "node-identity aggregation invalidation skipped for %d source(s) (%s): %s",
            len(ds_ids), reason, exc,
        )

    try:
        from backend.app.db.repositories.stats_repo import invalidate_schema_facets
        await invalidate_schema_facets(session, ds_ids)
        await session.commit()
    except Exception as exc:
        logger.warning("node-identity schema-facet invalidation failed (%s): %s", reason, exc)

    try:
        from backend.app.services.resolved_ontology_cache import bump_scopes
        await bump_scopes(scopes)
    except Exception as exc:
        logger.warning("node-identity generation bump failed (%s): %s", reason, exc)

    try:
        from backend.app.services.graph_cache import bump_aggregated_generations
        await bump_aggregated_generations(scopes)
    except Exception as exc:
        logger.warning("node-identity graph-cache bump failed (%s): %s", reason, exc)


async def load_node_identity(session, data_source: Any) -> ResolvedNodeIdentity:
    """Resolve the mapping for ``data_source`` (an ORM row or its id).

    Reads each level by primary key, in sequence — deliberately NOT a join.
    ``workspaces`` and ``providers`` sit in different ownership domains and
    cross-domain joins are lint-gated (``scripts/check_cross_domain_joins.py``);
    three keyed gets against rows that are almost always already in the session
    identity map is also simply cheaper than the join would be.

    Best-effort per level: if the workspace or provider row can't be read, that
    level falls through rather than failing the caller. Resolution degrading to
    a broader default is always safer than a trigger or a read blowing up.
    """
    from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM, WorkspaceORM

    ds = data_source
    if isinstance(ds, str):
        ds = await session.get(WorkspaceDataSourceORM, ds)
    if ds is None:
        return ResolvedNodeIdentity()

    provider = None
    workspace = None
    try:
        if getattr(ds, "provider_id", None):
            row = await session.get(ProviderORM, ds.provider_id)
            provider = _ProviderView(row) if row is not None else None
        if getattr(ds, "workspace_id", None):
            workspace = await session.get(WorkspaceORM, ds.workspace_id)
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning(
            "node-identity scope read failed for ds=%s (falling through to the "
            "levels that did load): %s",
            getattr(ds, "id", ds), exc,
        )

    return resolve_node_identity(
        data_source=ds,
        provider=provider,
        workspace=workspace,
        defaults=await read_global_defaults(session),
    )
