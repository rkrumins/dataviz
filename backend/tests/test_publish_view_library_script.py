"""The library publish script against a stand-in server, through its real HTTP stack.

A urllib handler answers in place of the network, so the script's cookie jar, CSRF header and
error handling run as they would against the API: it signs in — or, given an API key, checks the
key and sends it instead — echoes the CSRF cookie on every write, dry-runs unless told to apply,
fans a data source out to every view the list returns, and exits non-zero when anything is
refused.
"""
from __future__ import annotations

import http.client
import io
import json
import urllib.parse
import urllib.request
import urllib.response
from pathlib import Path

import pytest

from backend.scripts import publish_view_library as script

BASE = "http://api.example.test"
PASSWORD = "s3cret-pa55word"
PACK = {
    "format": "synodic.view-library", "version": 1,
    "displayRules": [{"name": "PII", "color": "#ef4444",
                      "predicate": {"kind": "tag", "op": "hasAny", "values": ["PII"]}}],
    "savedQueries": [{"name": "Tables", "predicate": {"kind": "entityType", "values": ["table"]}}],
}
VIEWS = [{"id": "v1", "name": "Finance"}, {"id": "v2", "name": "Sales"}, {"id": "v3", "name": "Ops"}]
KEY = "nxpat_" + "a" * 38
PAUSED_KEY = "nxpat_" + "b" * 38
PAUSED_SERVICE_KEY = "nxsat_" + "b" * 38
FENCED_KEY = "nxpat_" + "d" * 38
#: What ``GET /api/v1/api-keys/self`` says of each key the stand-in knows: its kind and status.
KEYS = {KEY: ("personal", "active"), PAUSED_KEY: ("personal", "paused"),
        PAUSED_SERVICE_KEY: ("service", "paused"), FENCED_KEY: ("personal", "ip_not_allowed")}


def _answer(added: int = 2, refused: int = 0, **over) -> dict:
    items = [{"kind": "rule", "name": "PII", "action": "add", "warnings": []},
             {"kind": "query", "name": "Tables", "action": "add", "warnings": []}]
    return {"strategy": "merge", "dryRun": True, "items": items, "added": added,
            "skipped": 0, "refused": refused, "removed": 0, **over}


class FakeApi(urllib.request.HTTPHandler):
    """The API's sign-in, views list and library import, as far as the script uses them."""

    def __init__(self, *, csrf_cookie: str = "nx_csrf", answers: dict | None = None,
                 views: list | None = None) -> None:
        super().__init__()
        self.csrf_cookie = csrf_cookie
        self.answers = answers or {}
        self.views = VIEWS if views is None else views
        self.requests: list[dict] = []

    def http_open(self, req):
        url = urllib.parse.urlsplit(req.full_url)
        seen = {
            "method": req.get_method(), "path": url.path,
            "query": dict(urllib.parse.parse_qsl(url.query)),
            "headers": {k.lower(): v for k, v in req.header_items()},
            "body": json.loads(req.data) if req.data else None,
        }
        self.requests.append(seen)
        return self._reply(req, *self._route(seen))

    def _route(self, r: dict):
        if r["path"] == "/api/v1/auth/login":
            if r["body"] != {"email": "me@example.com", "password": PASSWORD}:
                return 401, {"detail": "Invalid email or password"}, []
            return 200, {"user": {"id": "u1"}}, [
                "nx_access=access-token; Path=/; HttpOnly",
                f"{self.csrf_cookie}=csrf-token; Path=/",
            ]
        key = r["headers"].get("authorization", "").removeprefix("Bearer ") or None
        if key is not None:
            if key not in KEYS:
                return 401, {"detail": {"error": "invalid_api_key",
                                        "message": "The API key is not valid."}}, []
            if r["path"] == "/api/v1/api-keys/self" and r["method"] == "GET":
                kind, status = KEYS[key]
                return 200, {"id": "key_1", "name": "ci publisher", "kind": kind, "status": status}, []
        elif "nx_access=access-token" not in r["headers"].get("cookie", ""):
            return 401, {"detail": "Not authenticated"}, []
        if r["path"] == "/api/v1/views/" and r["method"] == "GET":
            offset = int(r["query"].get("offset", 0))
            page = self.views[offset:offset + 2]   # two a page, whatever limit asks
            more = offset + 2 < len(self.views)
            return 200, {"items": page, "total": len(self.views), "hasMore": more,
                         "nextOffset": offset + 2 if more else None}, []
        if r["path"].endswith("/library/import") and r["method"] == "POST":
            # A key request carries no session to forge, so no CSRF token either.
            if key is None and r["headers"].get("x-csrf-token") != "csrf-token":
                return 403, {"detail": {"error": "csrf_failed",
                                        "message": "CSRF token missing or invalid"}}, []
            view_id = r["path"].split("/")[4]
            status, body = self.answers.get(view_id, (200, _answer()))
            return status, body, []
        return 404, {"detail": "Not Found"}, []

    @staticmethod
    def _reply(req, status: int, body, cookies: list):
        headers = http.client.HTTPMessage()
        headers["Content-Type"] = "application/json"
        for cookie in cookies:
            headers["Set-Cookie"] = cookie   # appends: one header per cookie
        response = urllib.response.addinfourl(
            io.BytesIO(json.dumps(body).encode()), headers, req.full_url, status)
        response.msg = "OK" if status < 400 else "Error"
        return response


@pytest.fixture
def pack_file(tmp_path: Path) -> Path:
    path = tmp_path / "governance.library.json"
    path.write_text(json.dumps(PACK), encoding="utf-8")
    return path


_RealApi = script.Api


@pytest.fixture
def run(monkeypatch, capsys):
    """Run the script against ``server``: (exit status, stdout, stderr)."""
    monkeypatch.setenv("SYNODIC_PASSWORD", PASSWORD)
    monkeypatch.delenv("SYNODIC_EMAIL", raising=False)
    monkeypatch.delenv("SYNODIC_API_KEY", raising=False)

    def go(server: FakeApi, *args: str):
        monkeypatch.setattr(script, "Api",
                            lambda base_url, **kw: _RealApi(base_url, handlers=(server,), **kw))
        status = script.main([*args, "--base-url", BASE, "--email", "me@example.com"])
        out, err = capsys.readouterr()
        assert PASSWORD not in out + err
        return status, out, err

    return go


@pytest.fixture
def run_with_key(monkeypatch, capsys):
    """As ``run``, with an API key in ``SYNODIC_API_KEY`` and no email or password anywhere."""
    monkeypatch.delenv("SYNODIC_EMAIL", raising=False)
    monkeypatch.delenv("SYNODIC_PASSWORD", raising=False)

    def go(server: FakeApi, key: str, *args: str):
        monkeypatch.setenv("SYNODIC_API_KEY", key)
        monkeypatch.setattr(script, "Api",
                            lambda base_url, **kw: _RealApi(base_url, handlers=(server,), **kw))
        status = script.main([*args, "--base-url", BASE])
        out, err = capsys.readouterr()
        assert key not in out + err
        return status, out, err

    return go


def _imports(server: FakeApi) -> list:
    return [r for r in server.requests if r["path"].endswith("/library/import")]


def test_a_run_signs_in_and_is_a_dry_run_unless_applied(run, pack_file):
    server = FakeApi()
    status, out, _ = run(server, str(pack_file), "--view", "v1")

    assert status == 0
    login, imported = server.requests
    assert (login["method"], login["path"]) == ("POST", "/api/v1/auth/login")
    assert "x-csrf-token" not in login["headers"]
    assert imported["path"] == "/api/v1/views/v1/library/import"
    assert imported["query"] == {"strategy": "merge", "dryRun": "true"}
    assert imported["headers"]["x-csrf-token"] == "csrf-token"
    assert imported["body"] == PACK
    assert "Would add" in out and "Nothing changed. Run again with --apply" in out


def test_a_data_source_fans_out_to_every_view_it_lists(run, pack_file):
    # A deployment with AUTH_ENVIRONMENT_ID names the CSRF cookie nx_csrf_<env>.
    server = FakeApi(csrf_cookie="nx_csrf_uat")
    status, out, _ = run(server, str(pack_file), "--data-source", "ds1", "--apply",
                         "--strategy", "replace", "--branch", "br1")

    assert status == 0
    listed = [r for r in server.requests if r["path"] == "/api/v1/views/"]
    assert [(r["query"]["dataSourceId"], r["query"]["offset"]) for r in listed] == [("ds1", "0"), ("ds1", "2")]
    assert [r["path"].split("/")[4] for r in _imports(server)] == ["v1", "v2", "v3"]
    assert all(r["query"] == {"strategy": "replace", "dryRun": "false", "branchId": "br1"}
               and r["headers"]["x-csrf-token"] == "csrf-token" for r in _imports(server))
    for name in ("Finance (v1)", "Sales (v2)", "Ops (v3)"):
        assert name in out
    assert "Nothing changed" not in out


def test_a_refused_item_or_an_http_error_fails_the_run(run, pack_file):
    refused = _answer(added=1, refused=1, items=[
        {"kind": "rule", "name": "PII", "action": "refuse",
         "reason": "A rule can't use 'within hops' or a path", "warnings": []},
        {"kind": "query", "name": "Tables", "action": "add",
         "warnings": ["Refers to entity types this view doesn't show: table"]},
    ])
    server = FakeApi(answers={
        "v2": (200, refused),
        "v3": (403, {"detail": "Missing permission: workspace:view:edit"}),
    })
    status, out, _ = run(server, str(pack_file), "--data-source", "ds1")

    assert status == 1
    assert len(_imports(server)) == 3   # one refusal doesn't stop the others
    assert "HTTP 403: Missing permission: workspace:view:edit" in out
    assert "Sales (v2): can't import rule “PII”: A rule can't use 'within hops' or a path" in out
    assert "Sales (v2): query “Tables”: Refers to entity types this view doesn't show: table" in out


def test_a_wrong_password_stops_before_any_view(run, pack_file, monkeypatch):
    monkeypatch.setenv("SYNODIC_PASSWORD", "wrong")
    server = FakeApi()
    status, _, err = run(server, str(pack_file), "--data-source", "ds1")

    assert status == 2
    assert "HTTP 401: Invalid email or password" in err
    assert [r["path"] for r in server.requests] == ["/api/v1/auth/login"]


def test_an_api_key_publishes_without_signing_in(run_with_key, pack_file):
    """With an API key, nothing signs in — so it works where password sign-in is off. The key is
    checked first, then every request carries it, and no write needs a CSRF token."""
    server = FakeApi()
    status, out, _ = run_with_key(server, KEY, str(pack_file), "--data-source", "ds1", "--apply")

    assert status == 0
    assert server.requests[0]["path"] == "/api/v1/api-keys/self"
    assert "/api/v1/auth/login" not in [r["path"] for r in server.requests]
    assert all(r["headers"]["authorization"] == f"Bearer {KEY}" for r in server.requests)
    assert not any("x-csrf-token" in r["headers"] for r in server.requests)
    assert [r["path"].split("/")[4] for r in _imports(server)] == ["v1", "v2", "v3"]
    assert "Nothing changed" not in out


@pytest.mark.parametrize("key, says", [
    (PAUSED_KEY, "is paused until its owner signs in again"),
    (PAUSED_SERVICE_KEY, "is paused until its service account has a manager again"),
    (FENCED_KEY, "can't be used from this address"),
    ("nxpat_" + "c" * 38, "HTTP 401: The API key is not valid."),
])
def test_a_key_that_cannot_act_stops_before_any_view(run_with_key, pack_file, key, says):
    server = FakeApi()
    status, _, err = run_with_key(server, key, str(pack_file), "--data-source", "ds1")

    assert status == 2
    assert says in err
    assert [r["path"] for r in server.requests] == ["/api/v1/api-keys/self"]


def test_a_file_that_isnt_a_pack_is_refused_before_signing_in(run, tmp_path):
    other = tmp_path / "view.json"
    other.write_text(json.dumps({"format": "synodic.view-bundle"}), encoding="utf-8")
    server = FakeApi()
    status, _, err = run(server, str(other), "--view", "v1")

    assert status == 2
    assert "isn't a view library pack" in err
    assert server.requests == []


def test_a_data_source_without_a_readable_view_fails(run, pack_file):
    server = FakeApi(views=[])
    status, _, err = run(server, str(pack_file), "--data-source", "ds-empty")

    assert status == 1
    assert "has no view you can read" in err
    assert _imports(server) == []
