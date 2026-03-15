"""
Phase 6 migration: create the ontology_source_mappings table.

Idempotent: skips if the table already exists.
"""
import sqlite3
import sys
from pathlib import Path

DB_PATH = Path(__file__).parent.parent.parent / "nexus_core.db"


def main() -> None:
    if not DB_PATH.exists():
        print(f"[migrate_phase6] Database not found at {DB_PATH}. Skipping.")
        return

    conn = sqlite3.connect(str(DB_PATH))
    cur = conn.cursor()

    cur.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='ontology_source_mappings'"
    )
    if cur.fetchone():
        print("[migrate_phase6] Table 'ontology_source_mappings' already exists. Nothing to do.")
        conn.close()
        return

    cur.execute("""
        CREATE TABLE ontology_source_mappings (
            id TEXT PRIMARY KEY,
            data_source_id TEXT NOT NULL,
            ontology_id TEXT,
            entity_type_mappings TEXT NOT NULL DEFAULT '{}',
            relationship_type_mappings TEXT NOT NULL DEFAULT '{}',
            last_seen_schema_hash TEXT,
            last_seen_at TEXT,
            has_drift INTEGER NOT NULL DEFAULT 0,
            drift_details TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_osm_data_source ON ontology_source_mappings (data_source_id)"
    )
    conn.commit()
    print("[migrate_phase6] Created 'ontology_source_mappings' table.")
    conn.close()


if __name__ == "__main__":
    main()
    sys.exit(0)
