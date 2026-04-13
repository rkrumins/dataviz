"""
Backfill ``created_by`` on the ``views`` table.

Older views were created before the API recorded the authenticated user's
ID, so their ``created_by`` column is NULL (or the legacy sentinel
``"anonymous"``). This leaves them orphaned from the Explorer's "My Views"
filter and from the privacy scope of ``list_popular_views``.

This script assigns every orphaned row to a single user ID that you pass
as an argument. The typical call is to assign orphan views to the single
admin user in a small deployment:

    python backend/scripts/backfill_view_creators.py --user-id usr_admin123

A dry run (no writes) is available:

    python backend/scripts/backfill_view_creators.py --user-id usr_admin123 --dry-run

The script is idempotent — subsequent runs only touch rows that are still
NULL or "anonymous", so it's safe to run repeatedly as long as you pass
the same --user-id.
"""
import argparse
import sqlite3
import sys
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent.parent / "nexus_core.db"

# Any historical sentinel that should be overwritten with a real user id.
# NULL is handled separately in the WHERE clause.
LEGACY_SENTINELS = ("anonymous",)


def _count_orphans(cur: sqlite3.Cursor) -> tuple[int, int]:
    """Return (null_count, sentinel_count) for diagnostic output."""
    cur.execute("SELECT COUNT(*) FROM views WHERE created_by IS NULL")
    null_count = cur.fetchone()[0]
    placeholders = ",".join("?" * len(LEGACY_SENTINELS))
    cur.execute(
        f"SELECT COUNT(*) FROM views WHERE created_by IN ({placeholders})",
        LEGACY_SENTINELS,
    )
    sentinel_count = cur.fetchone()[0]
    return null_count, sentinel_count


def _user_exists(cur: sqlite3.Cursor, user_id: str) -> bool:
    cur.execute("SELECT 1 FROM users WHERE id = ? LIMIT 1", (user_id,))
    return cur.fetchone() is not None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Backfill views.created_by for orphaned rows."
    )
    parser.add_argument(
        "--user-id",
        required=True,
        help="User ID to assign as the creator of orphaned views.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would change without writing to the database.",
    )
    parser.add_argument(
        "--db-path",
        default=str(DB_PATH),
        help=f"Path to the SQLite database (default: {DB_PATH}).",
    )
    parser.add_argument(
        "--skip-user-check",
        action="store_true",
        help="Do not verify that --user-id exists in the users table. "
             "Useful when the users table lives elsewhere.",
    )
    args = parser.parse_args()

    db_path = Path(args.db_path)
    if not db_path.exists():
        print(f"[backfill] Database not found at {db_path}.", file=sys.stderr)
        return 1

    conn = sqlite3.connect(str(db_path))
    try:
        cur = conn.cursor()

        if not args.skip_user_check and not _user_exists(cur, args.user_id):
            print(
                f"[backfill] User '{args.user_id}' not found in the users "
                f"table. Re-run with --skip-user-check if this is intentional.",
                file=sys.stderr,
            )
            return 2

        null_count, sentinel_count = _count_orphans(cur)
        total = null_count + sentinel_count
        print(
            f"[backfill] Found {total} orphan view(s): "
            f"{null_count} NULL, {sentinel_count} sentinel "
            f"({', '.join(LEGACY_SENTINELS)})."
        )

        if total == 0:
            print("[backfill] Nothing to do.")
            return 0

        if args.dry_run:
            print(
                f"[backfill] Dry run: would set created_by = '{args.user_id}' "
                f"on {total} row(s)."
            )
            return 0

        placeholders = ",".join("?" * len(LEGACY_SENTINELS))
        cur.execute(
            f"""
            UPDATE views
               SET created_by = ?
             WHERE created_by IS NULL
                OR created_by IN ({placeholders})
            """,
            (args.user_id, *LEGACY_SENTINELS),
        )
        conn.commit()
        print(
            f"[backfill] Updated {cur.rowcount} row(s) "
            f"with created_by = '{args.user_id}'."
        )
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
