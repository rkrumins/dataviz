"""Every refusal on the view, subset and membership routes has one shape:
``{"detail": {"reason": <code to branch on>, "message": <words to show>, ...}}``
(``api/v1/refusal.py``). Pinned over the routes' source, so a new refusal in
another shape — a bare string, a ``type`` instead of a ``reason`` — fails here."""
from __future__ import annotations

import ast
from pathlib import Path

from backend.app.api.v1.refusal import Refusal, refusal_responses, refused

_ENDPOINTS = Path(__file__).resolve().parents[1] / "app" / "api" / "v1" / "endpoints"
_MODULES = ["search_views.py", "view_membership.py", "graph_view_feed.py", "graph_members.py"]


def test_every_refusal_names_a_reason_and_words():
    for name in _MODULES:
        path = _ENDPOINTS / name
        for node in ast.walk(ast.parse(path.read_text())):
            if not (isinstance(node, ast.Call) and getattr(node.func, "id", None) == "HTTPException"):
                continue
            detail = next((k.value for k in node.keywords if k.arg == "detail"), None)
            assert isinstance(detail, ast.Dict), f"{name}:{node.lineno} refuses without a reason"
            keys = {k.value for k in detail.keys if isinstance(k, ast.Constant)}
            assert {"reason", "message"} <= keys, f"{name}:{node.lineno} lacks reason or message"


def test_a_refusal_carries_what_its_reason_needs():
    exc = refused(409, "changed", "Someone changed it.", definitionHash="h2")
    assert exc.status_code == 409
    assert exc.detail == {"reason": "changed", "message": "Someone changed it.", "definitionHash": "h2"}
    assert refused(429, "too_soon", "Wait.", headers={"Retry-After": "30"}).headers == {"Retry-After": "30"}


def test_its_openapi_answers_say_what_each_status_means():
    out = refusal_responses(304, 409, 429)
    assert set(out) == {304, 409, 429}
    assert "model" not in out[304] and out[409]["model"] is Refusal
    assert "Retry-After" in out[429]["headers"] and "changed" in out[409]["description"]
