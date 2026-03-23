"""
Phase 5 migration: add evolution_policy column to ontologies table.

Run once against the target database:
    python backend/scripts/migrate_phase5.py

Idempotent: skips if the column already exists.
"""
import sqlite3
import sys
from pathlib import Path

DB_PATH = Path(__file__).parent.parent.parent / "nexus_core.db"


def main() -> None:
    if not DB_PATH.exists():
        print(f"[migrate_phase5] Database not found at {DB_PATH}. Skipping.")
        return

    conn = sqlite3.connect(str(DB_PATH))
    cur = conn.cursor()

    # Check if column already exists
    cur.execute("PRAGMA table_info(ontologies)")
    columns = {row[1] for row in cur.fetchall()}

    if "evolution_policy" in columns:
        print("[migrate_phase5] Column 'evolution_policy' already exists. Nothing to do.")
        conn.close()
        return

    cur.execute(
        "ALTER TABLE ontologies ADD COLUMN evolution_policy TEXT NOT NULL DEFAULT 'reject'"
    )
    conn.commit()
    print("[migrate_phase5] Added 'evolution_policy' column to ontologies table.")
    conn.close()


if __name__ == "__main__":
    main()
    sys.exit(0)
