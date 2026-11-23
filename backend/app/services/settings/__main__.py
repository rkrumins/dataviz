"""``python -m backend.app.services.settings legacy-diff [--adopt]``

Lists, one JSON object per line, each value where the old storage and the settings store disagree
(``services.settings.legacy.legacy_diff``): a value changed through an old endpoint while both were
in use. ``--adopt`` saves the old storage's values into the store, all or none.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any, Dict, List, Optional, Sequence


async def _legacy_diff(adopt: bool) -> List[Dict[str, Any]]:
    from backend.app.db.engine import close_db
    from backend.app.services.versioning.db import dispose_engine

    from .legacy import legacy_diff

    try:
        return await legacy_diff(adopt=adopt)
    finally:
        await close_db()
        await dispose_engine()


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m backend.app.services.settings")
    commands = parser.add_subparsers(dest="command", required=True)
    diff = commands.add_parser("legacy-diff",
                               help="values the old storage and the store disagree on")
    diff.add_argument("--adopt", action="store_true",
                      help="save the old storage's values into the store")
    args = parser.parse_args(argv)
    diffs = asyncio.run(_legacy_diff(args.adopt))
    for d in diffs:
        print(json.dumps(d, sort_keys=True, default=str))
    print(f"{len(diffs)} value(s) differ" + ("; adopted into the store" if args.adopt and diffs
                                              else ""), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
