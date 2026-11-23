"""Every notification kind the server sends has its own look in the Inbox.

The bell (``frontend/src/components/inbox/InboxBell.tsx``) picks an icon and colour per kind
from ``KIND_VISUALS``; a kind missing there still arrives, but as a grey generic bell that
says nothing about what happened. That went unnoticed for several kinds, so this walks the
server's code for the kinds it sends and checks each one has an entry:

* a ``kind="namespace.event"`` argument to any call (``notify``, a ``dict(...)`` of common
  fields, a local helper), including both arms of ``"a" if x else "b"``;
* the keys of a module-level ``*_NEWS`` table — the drafts' and reviews' kinds are looked up
  from those by a helper that is called with the kind as a variable.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
INBOX_BELL = ROOT.parent / "frontend" / "src" / "components" / "inbox" / "InboxBell.tsx"
KIND = re.compile(r"[a-z_]+\.[a-z_.]+")


def _strings(node: ast.AST) -> list[str]:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value]
    if isinstance(node, ast.IfExp):
        return _strings(node.body) + _strings(node.orelse)
    return []


def _sent_kinds() -> dict[str, str]:
    found: dict[str, str] = {}
    for path in APP.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        where = str(path.relative_to(ROOT))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                for kw in node.keywords:
                    if kw.arg == "kind":
                        for s in _strings(kw.value):
                            if KIND.fullmatch(s):
                                found.setdefault(s, where)
        for node in tree.body:
            if (isinstance(node, ast.Assign) and isinstance(node.value, ast.Dict)
                    and any(isinstance(t, ast.Name) and t.id.endswith("_NEWS") for t in node.targets)):
                for key in node.value.keys:
                    for s in _strings(key) if key is not None else []:
                        found.setdefault(s, where)
    return found


def _visual_kinds() -> set[str]:
    src = INBOX_BELL.read_text(encoding="utf-8")
    start = src.index("const KIND_VISUALS")
    block = src[start:src.index("\n}\n", start)]
    return set(re.findall(r"^\s*'([a-z_.]+)'\s*:", block, re.M))


def test_the_scan_finds_the_kinds_it_should():
    # Guards the guard: if the walk stopped finding kinds, the check below would pass vacuously.
    sent = _sent_kinds()
    for kind in ("view.shared", "review.mention", "review.reply", "review.comment", "draft.returned",
                 "discussion.asked", "data_source.contact_added"):
        assert kind in sent, kind


def test_every_kind_sent_has_an_inbox_visual():
    visuals = _visual_kinds()
    missing = {k: where for k, where in _sent_kinds().items() if k not in visuals}
    assert not missing, (
        "These notification kinds have no entry in KIND_VISUALS (frontend/src/components/inbox/"
        f"InboxBell.tsx), so they show as a generic bell: {missing}"
    )
