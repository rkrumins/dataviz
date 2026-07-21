#!/usr/bin/env python3
"""One-time repair: collapse case-variant duplicate type ids in stored ontology-definition
documents to ONE canonical key each.

Background: the ontology's canonical contract allows exactly one declared id per case-fold
(``TO`` xor ``To`` xor ``to``), with physical graph spellings folding onto it at read/commit time.
Older data — a pre-guard save, the historical UPPER_SNAKE-ing bug, or an import that bypassed
normalization — can still hold two keys differing only by case. The write-path guard now rejects
such payloads and the Schema page folds them on save (so an edited ontology self-heals), but an
ontology nobody touches stays corrupted and keeps its duplicated rows / dead classification.

This script finds those ontologies and, per case-fold group, keeps one canonical key, unions the
containment/lineage classification, records the folded spellings in the description ("also seen
as: …"), and rewrites the containment/lineage lists and entity hierarchy references onto the
survivor — identical to the frontend save-time fold (see backend.app.ontology.repair).

Usage:
  # Dry-run every ontology (read-only; prints the merges it would make):
  python backend/scripts/repair_ontology_case_variants.py

  # Dry-run a single ontology:
  python backend/scripts/repair_ontology_case_variants.py --ontology-id <id>

  # Apply the repairs:
  python backend/scripts/repair_ontology_case_variants.py --apply
"""
import argparse
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from sqlalchemy import select

from backend.app.db.engine import get_async_session
from backend.app.db.models import OntologyORM
from backend.app.ontology.repair import canonicalize_case_variants


async def main() -> None:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--apply", action="store_true", help="persist repairs (default: dry-run)")
    p.add_argument("--ontology-id", help="repair only this ontology")
    args = p.parse_args()

    async with get_async_session() as session:
        q = select(OntologyORM)
        if args.ontology_id:
            q = q.where(OntologyORM.id == args.ontology_id)
        rows = (await session.execute(q)).scalars().all()

        changed = 0
        for orm in rows:
            if getattr(orm, "is_system", False):
                continue  # platform-owned; not ours to rewrite
            result = canonicalize_case_variants(
                json.loads(orm.entity_type_definitions or "{}"),
                json.loads(orm.relationship_type_definitions or "{}"),
                json.loads(orm.containment_edge_types or "[]"),
                json.loads(orm.lineage_edge_types or "[]"),
            )
            if not result.changed:
                continue
            changed += 1
            print(f"ontology {orm.id} ({orm.name!r}):")
            for canonical, folded in result.merged_relationships.items():
                print(f"    rel   {folded} -> {canonical}")
            for canonical, folded in result.merged_entities.items():
                print(f"    node  {folded} -> {canonical}")
            if args.apply:
                orm.entity_type_definitions = json.dumps(result.entity_type_definitions)
                orm.relationship_type_definitions = json.dumps(result.relationship_type_definitions)
                orm.containment_edge_types = json.dumps(result.containment_edge_types)
                orm.lineage_edge_types = json.dumps(result.lineage_edge_types)

        if args.apply and changed:
            await session.commit()

        verb = "Repaired" if args.apply else "Would repair (dry-run; pass --apply)"
        print(f"\n{verb}: {changed} ontolog{'y' if changed == 1 else 'ies'}")


if __name__ == "__main__":
    asyncio.run(main())
