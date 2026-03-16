"""
Migration: create feature_flags table (single-row config for admin feature flags).

Run once against the target database:
    python backend/scripts/migrate_feature_flags.py

Idempotent: skips if the table already exists.
"""
import sqlite3
import sys
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent.parent / "nexus_core.db"


def main() -> None:
    if not DB_PATH.exists():
        print(f"[migrate_feature_flags] Database not found at {DB_PATH}. Skipping.")
        return

    conn = sqlite3.connect(str(DB_PATH))
    cur = conn.cursor()

    cur.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='feature_flags'"
    )
    if cur.fetchone():
        print("[migrate_feature_flags] Table 'feature_flags' already exists. Nothing to do.")
        conn.close()
        return

    cur.execute("""
        CREATE TABLE feature_flags (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            config TEXT NOT NULL DEFAULT '{}',
            updated_at TEXT NOT NULL
        )
    """)
    conn.commit()
    print("[migrate_feature_flags] Created 'feature_flags' table.")
    conn.close()


if __name__ == "__main__":
    main()
    sys.exit(0)
