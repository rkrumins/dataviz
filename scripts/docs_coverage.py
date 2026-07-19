#!/usr/bin/env python3
"""Documentation coverage map.

Cross-references the things the code exposes — feature flags, backend services,
and v1 endpoint groups — against the documentation corpus (docs/ + root docs),
and reports anything with no obvious mention. It makes "is it documented?" a
number instead of a vibe.

This is a *report*, not proof: a miss means "no literal mention found — check by
hand", not "definitely undocumented". Run with --strict to exit non-zero when a
category has gaps (for wiring into CI once the gaps are triaged).

    python3 scripts/docs_coverage.py            # print the report
    python3 scripts/docs_coverage.py --strict   # + exit 1 if any gaps
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def read_corpus() -> str:
    """All documentation text, lowercased, concatenated."""
    parts: list[str] = []
    for md in (ROOT / "docs").rglob("*.md"):
        parts.append(md.read_text(encoding="utf-8", errors="ignore"))
    for name in ("README.md", "QUICKSTART.md", "DEVELOPER_GUIDE.md", "SPEC.md",
                 "PLAN.md", "CHANGELOG.md"):
        p = ROOT / name
        if p.exists():
            parts.append(p.read_text(encoding="utf-8", errors="ignore"))
    return "\n".join(parts).lower()


def humanize(identifier: str) -> str:
    """assignment_engine / versioningEnabled -> 'assignment engine' / 'versioning enabled'."""
    s = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", identifier)      # camelCase
    s = s.replace("_", " ").replace("-", " ")
    return re.sub(r"\s+", " ", s).strip().lower()


def mentioned(identifier: str, corpus: str) -> bool:
    if identifier.lower() in corpus:
        return True
    human = humanize(identifier)
    return len(human) > 3 and human in corpus


def feature_flags() -> list[str]:
    src = (ROOT / "backend/app/config/feature_wiring.py").read_text(encoding="utf-8")
    block = src[src.index("FEATURE_WIRING"):]
    return sorted(set(re.findall(r'"(\w+)":\s*FeatureWiring', block)))


def services() -> list[str]:
    out: set[str] = set()
    sdir = ROOT / "backend/app/services"
    if sdir.exists():
        for p in sdir.iterdir():
            if p.name.startswith(("_", ".")):
                continue
            stem = p.stem if p.is_file() else p.name
            if p.is_file() and p.suffix != ".py":
                continue
            if stem in {"__init__", "base"}:
                continue
            out.add(stem)
    if (ROOT / "backend/insights_service").is_dir():
        out.add("insights")
    return sorted(out)


def endpoint_groups() -> list[str]:
    edir = ROOT / "backend/app/api/v1/endpoints"
    if not edir.exists():
        return []
    return sorted(
        p.stem for p in edir.glob("*.py")
        if p.stem not in {"__init__"}
    )


def report(title: str, items: list[str], corpus: str) -> list[str]:
    covered = [i for i in items if mentioned(i, corpus)]
    missing = [i for i in items if i not in covered]
    pct = (len(covered) / len(items) * 100) if items else 100.0
    print(f"\n## {title}: {len(covered)}/{len(items)} documented ({pct:.0f}%)")
    if missing:
        print("   no mention found for:")
        for m in missing:
            print(f"     - {m}")
    return missing


def main() -> int:
    corpus = read_corpus()
    print("Documentation coverage map")
    print("=" * 40)
    gaps: list[str] = []
    gaps += report("Feature flags", feature_flags(), corpus)
    gaps += report("Backend services", services(), corpus)
    gaps += report("v1 endpoint groups", endpoint_groups(), corpus)
    print("\n" + "=" * 40)
    print(f"Total items with no obvious doc mention: {len(gaps)}")
    if "--strict" in sys.argv and gaps:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
