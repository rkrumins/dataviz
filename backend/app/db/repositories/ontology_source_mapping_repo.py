"""Repository for ``ontology_source_mappings`` — the per-source vocabulary
alignment profile (Task E).

One row per (data_source_id, ontology_id): the declared→observed spelling map the
engine derives from live introspection, plus the drift summary the DS panel reads.
Human-confirmed entries (``auto=false``) are PRESERVED across re-derivation —
explicit decisions win over auto-alignment and are never silently overwritten.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Dict, Mapping, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import OntologySourceMappingORM
from backend.app.ontology.source_alignment import SourceAlignment

logger = logging.getLogger(__name__)


def _loads(raw: Optional[str]) -> Dict[str, dict]:
    if not raw:
        return {}
    try:
        val = json.loads(raw)
        return val if isinstance(val, dict) else {}
    except (ValueError, TypeError):
        return {}


def _explicit_only(mappings: Mapping[str, dict]) -> Dict[str, dict]:
    """Entries a human confirmed (``auto`` false) — the overrides fed back into
    :func:`derive_alignment` so a re-derive keeps them."""
    return {k: v for k, v in mappings.items()
            if isinstance(v, dict) and v.get("auto") is False and v.get("observed")}


async def get_mapping(
    session: AsyncSession, data_source_id: str, ontology_id: Optional[str],
) -> Optional[OntologySourceMappingORM]:
    stmt = select(OntologySourceMappingORM).where(
        OntologySourceMappingORM.data_source_id == data_source_id,
        OntologySourceMappingORM.ontology_id == ontology_id,
    )
    return await session.scalar(stmt)


async def list_mappings_for_ontology(
    session: AsyncSession, ontology_id: Optional[str], data_source_ids: list[str],
) -> Dict[str, OntologySourceMappingORM]:
    """All alignment rows for one ontology across the given sources, keyed by
    data_source_id — one query instead of one ``get_mapping`` per source."""
    if not data_source_ids:
        return {}
    stmt = select(OntologySourceMappingORM).where(
        OntologySourceMappingORM.ontology_id == ontology_id,
        OntologySourceMappingORM.data_source_id.in_(data_source_ids),
    )
    rows = (await session.scalars(stmt)).all()
    return {r.data_source_id: r for r in rows}


async def load_explicit_mappings(
    session: AsyncSession, data_source_id: str, ontology_id: Optional[str],
) -> Tuple[Dict[str, dict], Dict[str, dict]]:
    """Return ``(relationship_explicit, entity_explicit)`` — the human-confirmed
    overrides for this source. Empty dicts when there's no row yet."""
    row = await get_mapping(session, data_source_id, ontology_id)
    if row is None:
        return {}, {}
    return (
        _explicit_only(_loads(row.relationship_type_mappings)),
        _explicit_only(_loads(row.entity_type_mappings)),
    )


def _merge_dimension(
    existing: Mapping[str, dict], entries: Mapping[str, "object"],
) -> Dict[str, dict]:
    """Fresh auto entries, but keep any human-confirmed (``auto=false``) entry as-is."""
    out: Dict[str, dict] = dict(_explicit_only(existing))
    for declared, entry in entries.items():
        if declared in out:
            continue  # explicit wins
        out[declared] = entry.to_json()  # type: ignore[attr-defined]
    return out


async def persist_alignment(
    session: AsyncSession,
    *,
    data_source_id: str,
    ontology_id: Optional[str],
    alignment: SourceAlignment,
) -> OntologySourceMappingORM:
    """Upsert the alignment profile. Idempotent on the observed schema hash: an
    unchanged source schema re-derives to the same auto mapping, so we skip the
    write. Explicit entries are preserved (see :func:`_merge_dimension`)."""
    row = await get_mapping(session, data_source_id, ontology_id)
    rel_map = _merge_dimension(
        _loads(row.relationship_type_mappings) if row else {}, alignment.relationship_entries)
    ent_map = _merge_dimension(
        _loads(row.entity_type_mappings) if row else {}, alignment.entity_entries)
    # drift reflects the MERGED (explicit + auto) state, not just auto-derivation.
    details = [d for d in alignment.drift_details()
               if d["declared"] in rel_map or d["declared"] in ent_map]
    has_drift = alignment.has_drift
    now = datetime.now(timezone.utc).isoformat()

    if row is None:
        row = OntologySourceMappingORM(
            data_source_id=data_source_id, ontology_id=ontology_id,
            relationship_type_mappings=json.dumps(rel_map),
            entity_type_mappings=json.dumps(ent_map),
            last_seen_schema_hash=alignment.schema_hash, last_seen_at=now,
            has_drift=has_drift, drift_details=json.dumps(details),
        )
        session.add(row)
        return row

    if row.last_seen_schema_hash == alignment.schema_hash:
        return row  # unchanged source schema — nothing new to record
    row.relationship_type_mappings = json.dumps(rel_map)
    row.entity_type_mappings = json.dumps(ent_map)
    row.last_seen_schema_hash = alignment.schema_hash
    row.last_seen_at = now
    row.has_drift = has_drift
    row.drift_details = json.dumps(details)
    return row


async def set_variant_decision(
    session: AsyncSession,
    *,
    data_source_id: str,
    ontology_id: Optional[str],
    declared: str,
    keep_merged: bool,
    dimension: str = "relationship",
) -> Optional[OntologySourceMappingORM]:
    """Record a user's Keep/Split decision for a same-source multi-variant type.

    ``keep_merged=True`` confirms the proposed merge (all observed spellings stay
    mapped to ``declared``); ``False`` splits it (only the exactly-matching spelling
    remains, the others become unaligned). Either way the entry flips to explicit
    (``auto=false``, ``needsConfirmation=false``) so it's never re-asked. Reversible:
    re-issuing with the other choice overwrites the decision.
    """
    row = await get_mapping(session, data_source_id, ontology_id)
    if row is None:
        return None
    col = "relationship_type_mappings" if dimension == "relationship" else "entity_type_mappings"
    mappings = _loads(getattr(row, col))
    entry = mappings.get(declared)
    if not entry:
        return row
    observed = list(entry.get("observed") or [])
    if not keep_merged:
        observed = [s for s in observed if s == declared]
    entry.update({"observed": observed, "auto": False, "needsConfirmation": False,
                  "kind": "case_variant" if observed and observed != [declared] else "identity"})
    mappings[declared] = entry
    setattr(row, col, json.dumps(mappings))
    # Recompute has_drift from remaining non-identity entries across both dimensions.
    rel = _loads(row.relationship_type_mappings)
    ent = _loads(row.entity_type_mappings)
    row.has_drift = any(v.get("kind") not in (None, "identity")
                        for v in list(rel.values()) + list(ent.values()))
    row.last_seen_at = datetime.now(timezone.utc).isoformat()
    return row
