"""The settings' old routes (``docs/guide/VERSIONED_GRAPH_SETTINGS.md``, "If you used the old
endpoints"): each still answers, for one more release, and says it is deprecated — in the OpenAPI
document, and in every answer: ``Deprecation: true``, and a ``Link`` to the settings API route that
replaces it, with the request's own ids where the two paths share them.

That a real answer carries the headers: ``test_drafts_policy.py``.
"""
from __future__ import annotations

from starlette.requests import Request
from starlette.responses import Response

from backend.app.auth import api_key_surface
from backend.app.main import app

_PLATFORM = "/api/v1/admin/versioning/settings"
_WORKSPACE = "/api/v1/{ws_id}/versioning/settings"
_GRAPH = "/api/v1/{ws_id}/versioning/graphs/{graph_id}/settings"
_ADMIN, _WS = "/api/v1/admin/versioning", "/api/v1/{ws_id}/versioning"

#: Each old route, and the settings API route that replaces it.
OLD = {
    ("GET", f"{_ADMIN}/build-policy"): _PLATFORM,
    ("PUT", f"{_ADMIN}/build-policy"): _PLATFORM,
    ("GET", f"{_ADMIN}/residency-policy"): _PLATFORM,
    ("PUT", f"{_ADMIN}/residency-policy"): _PLATFORM,
    ("POST", f"{_ADMIN}/residency-policy/preview"): f"{_PLATFORM}/preview?mode=full",
    ("GET", f"{_ADMIN}/draft-retention"): _PLATFORM,
    ("PUT", f"{_ADMIN}/draft-retention"): _PLATFORM,
    ("PUT", f"{_ADMIN}/graphs/{{graph_id}}/read-mode"): _GRAPH,
    ("GET", f"{_WS}/drafts-policy"): _WORKSPACE,
    ("PUT", f"{_WS}/drafts-policy"): _WORKSPACE,
    ("GET", f"{_WS}/data-sources/{{data_source_id}}/drafts-policy"): _GRAPH,
    ("PUT", f"{_WS}/data-sources/{{data_source_id}}/drafts-policy"): _GRAPH,
    ("GET", f"{_WS}/graphs/{{graph_id}}/import-settings"): _GRAPH,
    ("PUT", f"{_WS}/graphs/{{graph_id}}/import-settings"): _GRAPH,
}


def _marked(dependant) -> list:
    return [d.call for d in dependant.dependencies
            if getattr(d.call, "__qualname__", "") == "_superseded_by.<locals>.mark"]


def test_every_old_settings_route_says_it_is_deprecated_and_names_what_replaces_it():
    found = {(m, p): (r, d) for m, p, r, d in api_key_surface.routes(app) if (m, p) in OLD}
    assert set(found) == set(OLD)
    for (method, path), (route, dependant) in found.items():
        assert route.deprecated, (method, path)
        (mark,) = _marked(dependant)
        response = Response()
        mark(Request({"type": "http", "path_params": {"ws_id": "ws_1", "graph_id": "g_1"}}),
             response)
        assert response.headers["Deprecation"] == "true"
        successor = OLD[(method, path)].replace("{ws_id}", "ws_1").replace("{graph_id}", "g_1")
        assert response.headers["Link"] == f'<{successor}>; rel="successor-version"', path


def test_an_id_the_old_path_does_not_have_stays_a_placeholder():
    """The data source's drafts policy is reached by its data source, the settings API by its
    graph: the link names the workspace and leaves the graph to fill in."""
    (_m, _p, _route, dependant), = [
        row for row in api_key_surface.routes(app)
        if row[:2] == ("GET", f"{_WS}/data-sources/{{data_source_id}}/drafts-policy")]
    (mark,) = _marked(dependant)
    response = Response()
    mark(Request({"type": "http", "path_params": {"ws_id": "ws_1", "data_source_id": "ds_1"}}),
         response)
    assert response.headers["Link"] == ('</api/v1/ws_1/versioning/graphs/{graph_id}/settings>; '
                                        'rel="successor-version"')


def test_the_settings_api_itself_is_not_deprecated():
    current = [(m, p) for m, p, r, _d in api_key_surface.routes(app)
               if "/versioning/settings" in p or p.endswith("/settings") and "/versioning/graphs/" in p]
    assert current
    deprecated = [(m, p) for m, p, r, _d in api_key_surface.routes(app)
                  if (m, p) in current and r.deprecated]
    assert deprecated == []
