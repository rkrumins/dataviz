"""Operator holds on automatic rebuilds — one resolver, consulted by every gate.

A *hold* is an operator saying "do not rebuild this automatically". It comes
in two kinds and at three scopes:

* **paused** — timed. Lapses on its own (``paused_until``, an ISO instant).
* **stopped** — indefinite. Holds until someone explicitly resumes.

* **source** — ``data_source_state.paused_until`` (paused) and
  ``data_source_state.reconcile_enabled = False`` (stopped; the existing
  "Automation off" toggle IS the indefinite stop, and the pause validator
  says so out loud).
* **provider** / **fleet** — ``aggregation.automation_holds`` rows, keyed
  ``(scope, scope_id)``, each carrying the same two nullable columns.

**Most restrictive wins.** Any hold anywhere in fleet → provider → source
holds the source; there is no per-source escape from a wider hold. The
resolver therefore only has to decide *which* hold to REPORT, and it reports
the widest — sending an operator to a source-level control when the fleet is
stopped points them at a switch that will not release it.

Why this module exists, and why it is the ONLY place the rule lives: before
it, ``paused_until`` was read in exactly one behavioural place (the reconcile
sweeper's act decision) while seven other paths could queue a job — and the
stale-marker reconciler, which retries every marked source every 60 seconds,
was not one of the gated ones. A source paused while a marker was set was
rebuilt within a minute, every minute. ``reconcile_enabled`` had the identical
single read and the identical hole, so "Automation off" was a lie in exactly
the way "Paused" was.

Two discriminators, and the distinction matters:

* ``origin`` tells automation apart from a person. The internal automation
  origins (:data:`AUTOMATION_ORIGINS`) can only be set by internal callers —
  the HTTP request models restrict ``origin`` to ``script|connector|api`` —
  and every automation caller already passes one because the audit trail
  depends on it. ``trigger_source`` CANNOT do this job: ``signal_source_changed``
  defaults it to ``"api"`` and neither scheduler caller overrides it, so
  ``api`` covers the live hole *and* a person clicking Rebuild *and* the
  versioning projector.
* A hold stops AUTOMATION, never a person (who is warned and proceeds), and
  never a job already running (it blocks the next one).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Mapping, Optional, Tuple

#: ``signal_source_changed`` origins that mean "automation asked", and are
#: therefore subject to a hold. Everything else — ``script``, ``connector``,
#: ``api`` — is an external system or a person, who may proceed.
AUTOMATION_ORIGINS: frozenset = frozenset({"drift", "reconcile", "reconcile-sweep"})

#: ``trigger()`` sources that mean "automation asked". ``manual`` is a person;
#: ``onboarding`` is provisioning (no automation history to hold);
#: ``post_purge`` is the purge's own re-aggregate — the purge already deleted
#: the cells, so holding it strands the source with no rollups AND no
#: automation to heal it; ``api`` is exempt HERE because its automation subset
#: is caught upstream by the origin check in ``signal_source_changed``.
HELD_TRIGGER_SOURCES: frozenset = frozenset({"reconcile", "drift", "schedule"})

#: Key of the fleet row in a scope-holds mapping.
FLEET_KEY: Tuple[str, str] = ("fleet", "")


@dataclass(frozen=True)
class Hold:
    """The one hold that is reported for a source (the widest in force)."""
    scope: str                      # 'fleet' | 'provider' | 'source'
    kind: str                       # 'stopped' | 'paused'
    until: Optional[str] = None     # ISO instant; kind == 'paused' only
    scope_id: Optional[str] = None  # provider_id when scope == 'provider'

    @property
    def detail(self) -> str:
        """Compact ``scope:kind`` form for audit rows and log lines."""
        return f"{self.scope}:{self.kind}"


class HeldError(Exception):
    """An automation trigger was refused because a hold is in force.

    Raised only from ``trigger()`` for automation trigger sources; the
    reconcile sweeper is its sole live caller and counts it as a skip, never
    as an error. It never reaches HTTP — a person's request is not held, it
    proceeds with a warning.
    """

    def __init__(self, hold: Hold) -> None:
        self.hold = hold
        super().__init__(f"automatic rebuilds are held ({hold.detail})")


def pause_active(paused_until: Optional[str]) -> bool:
    """True while a timed pause is still in force.

    An unparseable stamp is treated as EXPIRED: a corrupt value must not pause
    a source forever. (The write side rejects such values; this is the read
    side's defence.) Naive stamps are compared as UTC, matching how they are
    normalised on write.
    """
    if not paused_until:
        return False
    try:
        until = datetime.fromisoformat(paused_until)
    except (TypeError, ValueError):
        return False
    if until.tzinfo is None:
        until = until.replace(tzinfo=timezone.utc)
    return until > datetime.now(timezone.utc)


def _scope_row_hold(row: Any, scope: str, scope_id: str) -> Optional[Hold]:
    """A fleet/provider row → its hold. ``stopped`` outranks ``paused`` within
    a scope: it does not expire and is the more deliberate act."""
    if row is None:
        return None
    if getattr(row, "stopped_at", None):
        return Hold(scope=scope, kind="stopped", scope_id=scope_id or None)
    paused_until = getattr(row, "paused_until", None)
    if pause_active(paused_until):
        return Hold(scope=scope, kind="paused", until=paused_until,
                    scope_id=scope_id or None)
    return None


def resolve_scope_hold(
    scope_holds: Optional[Mapping[Tuple[str, str], Any]],
    provider_id: Optional[str],
) -> Optional[Hold]:
    """The widest fleet/provider hold in force, or ``None``.

    ``scope_holds`` maps ``(scope, scope_id)`` to a row exposing
    ``paused_until`` / ``stopped_at`` (an ORM row, or any object with those
    attributes). An absent or empty mapping means no scope-level hold —
    the fail-open direction the freshness read path uses everywhere.
    """
    if not scope_holds:
        return None
    hold = _scope_row_hold(scope_holds.get(FLEET_KEY), "fleet", "")
    if hold is not None:
        return hold
    if provider_id:
        return _scope_row_hold(
            scope_holds.get(("provider", provider_id)), "provider", provider_id,
        )
    return None


def resolve_source_hold(
    paused_until: Optional[str],
    reconcile_enabled: Optional[bool],
) -> Optional[Hold]:
    """The source's own hold, or ``None``. ``reconcile_enabled`` is the
    RESOLVED value (per-source override → global → env), not the raw
    override: an unset override inherits, and an inherited ``False`` is a
    real stop."""
    if reconcile_enabled is False:
        return Hold(scope="source", kind="stopped")
    if pause_active(paused_until):
        return Hold(scope="source", kind="paused", until=paused_until)
    return None


def resolve_hold(
    *,
    scope_holds: Optional[Mapping[Tuple[str, str], Any]],
    provider_id: Optional[str],
    source_paused_until: Optional[str] = None,
    source_reconcile_enabled: Optional[bool] = None,
) -> Optional[Hold]:
    """Most-restrictive-wins across fleet → provider → source.

    Order: fleet stopped, fleet paused, provider stopped, provider paused,
    source stopped, source paused, else ``None``. Every branch holds the
    source equally — the order only decides which scope is reported.
    """
    return (
        resolve_scope_hold(scope_holds, provider_id)
        or resolve_source_hold(source_paused_until, source_reconcile_enabled)
    )


#: Hold → the reconcile sweeper's skip vocabulary. Source-scope holds keep
#: their historical names (``disabled`` / ``paused``) so tallies, docs and
#: tests read as before; wider scopes get their own so an operator can see
#: which control is holding a source back.
def skip_for(hold: Hold) -> str:
    if hold.scope == "source":
        return "disabled" if hold.kind == "stopped" else "paused"
    return f"{hold.scope}_held"
