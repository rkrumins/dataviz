"""Publish a view library pack (display rules and saved queries) to one view, or to every view of
a data source.

There is no data-source-level library: rules and saved queries belong to a view. Publishing to a
data source is therefore a fan-out. The script lists the views of the data source you can read
(``GET /api/v1/views/?dataSourceId=…``) and imports the pack into each one
(``POST /api/v1/views/{id}/library/import``), as the Property Manager's Import does for one view.

There are no API tokens, so the script signs in with an email and password. The session comes back
as cookies, and every write echoes the ``nx_csrf`` cookie as the ``X-CSRF-Token`` header. The
password is read from ``--password``, ``SYNODIC_PASSWORD`` or a prompt, and is never printed.

A run is a dry run unless ``--apply`` is given: each view answers what the import would do, and
nothing changes. Only the standard library is used, so the script runs from any machine with
Python 3.9+, inside the repo (``python -m backend.scripts.publish_view_library``) or as a
single file.

Usage::

    export SYNODIC_EMAIL=you@example.com SYNODIC_PASSWORD=…
    python -m backend.scripts.publish_view_library pack.library.json --view view_abc
    python -m backend.scripts.publish_view_library pack.library.json --data-source ds_abc
    python -m backend.scripts.publish_view_library pack.library.json --data-source ds_abc --apply

Exit status: 0 when every view took the pack with nothing refused; 1 when a view refused an item or
answered with an HTTP error, or the data source has no view you can read; 2 when the arguments, the
pack file or the sign-in are wrong.
"""
from __future__ import annotations

import argparse
import getpass
import http.cookiejar
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

# backend/common/models/view_library.py — copied, so the script needs nothing but Python.
PACK_FORMAT = "synodic.view-library"
PACK_VERSION = 1

_TIMEOUT_S = 120.0
_PAGE = 200  # the views list's largest page
_LOCALHOSTS = frozenset({"localhost", "127.0.0.1"})


class PublishError(Exception):
    """A pack that isn't one, or a sign-in that didn't take."""


class HttpError(Exception):
    """The server said no (``status``), or couldn't be reached (``status`` None)."""

    def __init__(self, status: Optional[int], detail: str) -> None:
        super().__init__(f"HTTP {status}: {detail}" if status else detail)
        self.status = status


class _CookiePolicy(http.cookiejar.DefaultCookiePolicy):
    """Local development serves http:// while the session cookies may be marked Secure: send them
    back to localhost anyway, and to nothing else over plain http."""

    def return_ok_secure(self, cookie, request):
        if urllib.parse.urlsplit(request.get_full_url()).hostname in _LOCALHOSTS:
            return True
        return super().return_ok_secure(cookie, request)


def _detail(raw: bytes) -> str:
    """What an error body says went wrong, on one line."""
    try:
        body = json.loads(raw)
    except ValueError:
        return raw.decode("utf-8", "replace").strip()[:300] or "no detail"
    detail = body.get("detail", body) if isinstance(body, dict) else body
    if isinstance(detail, dict):  # {"error": …, "message": …}
        detail = detail.get("message") or detail.get("error") or detail
    if isinstance(detail, list):  # a 422's validation errors
        detail = "; ".join(
            f"{'.'.join(str(p) for p in e.get('loc', ()))}: {e.get('msg')}" if isinstance(e, dict) else str(e)
            for e in detail[:3])
    return str(detail)[:300]


class Api:
    """The calls a publish makes, on one signed-in session."""

    def __init__(self, base_url: str, *, handlers: Sequence[urllib.request.BaseHandler] = ()) -> None:
        self.base_url = base_url.rstrip("/")
        self.jar = http.cookiejar.CookieJar(policy=_CookiePolicy())
        self._opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), *handlers)

    def csrf_token(self) -> Optional[str]:
        """The ``nx_csrf`` cookie (``nx_csrf_<env>`` where the deployment sets AUTH_ENVIRONMENT_ID)."""
        for cookie in self.jar:
            if cookie.name == "nx_csrf" or cookie.name.startswith("nx_csrf_"):
                return cookie.value
        return None

    def call(self, method: str, path: str, *, params: Optional[Dict[str, Any]] = None,
             body: Any = None) -> Any:
        url = f"{self.base_url}{path}" + (f"?{urllib.parse.urlencode(params)}" if params else "")
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(url, data=data, method=method)
        request.add_header("Accept", "application/json")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        token = self.csrf_token()
        if method != "GET" and token:
            request.add_header("X-CSRF-Token", token)
        try:
            with self._opener.open(request, timeout=_TIMEOUT_S) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            raise HttpError(exc.code, _detail(exc.read())) from None
        except urllib.error.URLError as exc:
            raise HttpError(None, f"can't reach {self.base_url}: {exc.reason}") from None
        return json.loads(raw) if raw else None


def read_pack(path: str) -> Dict[str, Any]:
    try:
        pack = json.loads(Path(path).read_text(encoding="utf-8"))
    except OSError as exc:
        raise PublishError(f"can't read {path}: {exc.strerror}") from None
    except ValueError:
        raise PublishError(f"{path} isn't JSON") from None
    if not isinstance(pack, dict) or pack.get("format") != PACK_FORMAT:
        raise PublishError(f"{path} isn't a view library pack: its format must be {PACK_FORMAT!r}")
    if pack.get("version") != PACK_VERSION:
        raise PublishError(f"{path} is version {pack.get('version')!r}; this script publishes version {PACK_VERSION}")
    return pack


def sign_in(api: Api, email: str, password: str) -> None:
    api.call("POST", "/api/v1/auth/login", body={"email": email, "password": password})
    if api.csrf_token() is None:
        raise PublishError("signed in, but no nx_csrf cookie came back: is --base-url the API's address?")


def views_of_data_source(api: Api, data_source_id: str) -> List[Dict[str, str]]:
    """Every live view of the data source that the signed-in user can read."""
    views: List[Dict[str, str]] = []
    offset = 0
    while True:
        page = api.call("GET", "/api/v1/views/",
                        params={"dataSourceId": data_source_id, "limit": _PAGE, "offset": offset})
        views += [{"id": v["id"], "name": v.get("name") or v["id"]} for v in page.get("items", [])]
        if not page.get("hasMore") or page.get("nextOffset") is None:
            return views
        offset = page["nextOffset"]


@dataclass
class Outcome:
    view_id: str
    view_name: str
    result: Optional[Dict[str, Any]] = None  # the view's LibraryImportResult
    error: Optional[str] = None

    @property
    def failed(self) -> bool:
        return self.error is not None or bool((self.result or {}).get("refused"))

    @property
    def label(self) -> str:
        return self.view_id if self.view_name == self.view_id else f"{self.view_name} ({self.view_id})"


def publish(api: Api, views: List[Dict[str, str]], pack: Dict[str, Any], *, strategy: str,
            apply: bool, branch_id: Optional[str]) -> List[Outcome]:
    params = {"strategy": strategy, "dryRun": "false" if apply else "true"}
    if branch_id:
        params["branchId"] = branch_id
    outcomes = []
    for view in views:
        path = f"/api/v1/views/{urllib.parse.quote(view['id'], safe='')}/library/import"
        try:
            outcomes.append(Outcome(view["id"], view["name"],
                                    result=api.call("POST", path, params=params, body=pack)))
        except HttpError as exc:
            outcomes.append(Outcome(view["id"], view["name"], error=str(exc)))
    return outcomes


def render(outcomes: List[Outcome], *, apply: bool) -> str:
    """One row per view, then every refused item and every warning, with its reason."""
    headers = ("View", "Added" if apply else "Would add", "Skipped", "Refused", "Removed", "Warnings", "Result")
    rows, notes = [], []
    for o in outcomes:
        if o.result is None:
            rows.append((o.label, "-", "-", "-", "-", "-", o.error or ""))
            continue
        r = o.result
        items = r.get("items") or []
        rows.append((o.label, *(str(r.get(k, 0)) for k in ("added", "skipped", "refused", "removed")),
                     str(sum(len(i.get("warnings") or []) for i in items)),
                     "refused items" if r.get("refused") else "ok"))
        for i in items:
            what = f"{i.get('kind')} “{i.get('name')}”"
            if i.get("action") == "refuse":
                notes.append(f"  {o.label}: can't import {what}: {i.get('reason')}")
            notes += [f"  {o.label}: {what}: {w}" for w in i.get("warnings") or []]
    widths = [max([len(h), *(len(row[n]) for row in rows)]) for n, h in enumerate(headers)]

    def line(cells: Sequence[str]) -> str:
        return "  ".join(c.ljust(w) for c, w in zip(cells, widths)).rstrip()

    table = [line(headers), line(tuple("-" * w for w in widths)), *(line(row) for row in rows)]
    return "\n".join(table + ([""] + notes if notes else []))


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Publish a view library pack (display rules and saved queries) to one view, "
                    "or to every view of a data source. A dry run unless --apply is given.")
    parser.add_argument("pack", help="the .library.json file to publish")
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--view", metavar="VIEW_ID", help="publish to this view")
    target.add_argument("--data-source", metavar="DATA_SOURCE_ID",
                        help="publish to every view of this data source that you can read")
    parser.add_argument("--branch", metavar="BRANCH_ID",
                        help="write the display rules to this draft of each view (saved queries "
                             "belong to the view, whatever the branch)")
    parser.add_argument("--strategy", choices=("merge", "copy", "replace"), default="merge",
                        help="merge (default): add what a view doesn't have; copy: add everything; "
                             "replace: remove a view's rules and saved queries first")
    parser.add_argument("--apply", action="store_true", help="import; without it nothing changes")
    parser.add_argument("--base-url", default=os.environ.get("SYNODIC_BASE_URL", "http://localhost:8000"),
                        help="the API's address (default: $SYNODIC_BASE_URL or http://localhost:8000)")
    parser.add_argument("--email", default=os.environ.get("SYNODIC_EMAIL"),
                        help="who signs in (default: $SYNODIC_EMAIL)")
    parser.add_argument("--password", help="their password (default: $SYNODIC_PASSWORD, else a prompt)")
    args = parser.parse_args(argv)
    if not args.email:
        parser.error("give --email or set SYNODIC_EMAIL")

    try:
        pack = read_pack(args.pack)
        password = args.password or os.environ.get("SYNODIC_PASSWORD") or getpass.getpass("Password: ")
        api = Api(args.base_url)
        sign_in(api, args.email, password)
    except (PublishError, HttpError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if args.view:
        views = [{"id": args.view, "name": args.view}]
    else:
        try:
            views = views_of_data_source(api, args.data_source)
        except HttpError as exc:
            print(f"error: couldn't list the views of {args.data_source}: {exc}", file=sys.stderr)
            return 1
        if not views:
            print(f"error: data source {args.data_source} has no view you can read", file=sys.stderr)
            return 1

    rules, queries = len(pack.get("displayRules") or []), len(pack.get("savedQueries") or [])
    print(f"{'Importing' if args.apply else 'Dry run:'} {rules} display rules and {queries} saved queries "
          f"into {len(views)} view{'s' if len(views) != 1 else ''} (strategy {args.strategy}"
          f"{f', draft {args.branch}' if args.branch else ''})\n")
    outcomes = publish(api, views, pack, strategy=args.strategy, apply=args.apply, branch_id=args.branch)
    print(render(outcomes, apply=args.apply))
    if not args.apply:
        print("\nNothing changed. Run again with --apply to import.")
    return 1 if any(o.failed for o in outcomes) else 0


if __name__ == "__main__":
    sys.exit(main())
