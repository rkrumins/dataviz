"""A port from the environment, read the same way everywhere (backend/common/env_port.py).

Kubernetes injects ``FALKORDB_PORT=tcp://<ip>:6379`` into every pod for a Service named
``falkordb`` — as this repo's manifests name it — and ``int()`` of that made the version store's
same-server check fail, so no blank graph could be created: from the Playground's samples or a new
empty data source. Each reader here takes such a link's port, never fails on what isn't a port,
and never logs the value (a URL can carry a password).
"""
from __future__ import annotations

import asyncio
import logging

import pytest

from backend.common import env_port as ep

LINK = "tcp://10.0.0.5:6379"            # what a Kubernetes service link writes
PG_URL = "postgresql://app:s3cret@db:5432/app"


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    monkeypatch.setattr(ep, "_warned", set())
    for name in ("FALKORDB_PORT", "FALKORDB_HOST", "LOCAL_DEV_FALKORDB_OVERRIDE"):
        monkeypatch.delenv(name, raising=False)


@pytest.mark.parametrize("raw, port", [
    (None, 6379), ("", 6379), ("  ", 6379), ("6380", 6380), (LINK, 6379),
    ("redis://falkordb:6390", 6390), ("rediss://user:pw@falkordb:6391/0", 6391),
    (PG_URL, 6379),                       # another store's URL is not FalkorDB's port
    ("falkordb", 6379), ("70000", 6379), ("tcp://10.0.0.5:notaport", 6379),
])
def test_a_falkordb_port_reads_as_a_number_a_link_or_the_default(monkeypatch, raw, port):
    if raw is None:
        monkeypatch.delenv("FALKORDB_PORT", raising=False)
    else:
        monkeypatch.setenv("FALKORDB_PORT", raw)
    assert ep.env_port("FALKORDB_PORT", 6379, store="falkordb") == port


def test_what_isnt_a_port_is_said_once_without_its_value(monkeypatch, caplog):
    monkeypatch.setenv("FALKORDB_PORT", PG_URL)
    with caplog.at_level(logging.WARNING, logger=ep.__name__):
        assert ep.env_port("FALKORDB_PORT", 6379, store="falkordb") == 6379
        assert ep.env_port("FALKORDB_PORT", 6379, store="falkordb") == 6379
    said = [r.getMessage() for r in caplog.records]
    assert len(said) == 1
    assert "FALKORDB_PORT is set to a postgresql:// URL, not a port" in said[0]
    assert "s3cret" not in said[0] and "db:5432" not in said[0]


def test_a_service_port_takes_a_link_but_no_store_url(monkeypatch):
    monkeypatch.setenv("METRICS_PORT", "tcp://10.0.0.9:9100")
    assert ep.env_port("METRICS_PORT", 9200) == 9100
    monkeypatch.setenv("METRICS_PORT", "redis://x:6379")
    assert ep.env_port("METRICS_PORT", 9200) == 9200


class _Rows:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class _Session:
    """Answers the providers query with ``rows``: (id, host, port, extra_config)."""

    def __init__(self, rows):
        self.rows = rows

    async def execute(self, _stmt):
        return _Rows(self.rows)


@pytest.mark.parametrize("raw", [LINK, "6379", None])
def test_the_same_server_check_links_the_env_instance_by_its_port_or_link(monkeypatch, raw):
    """The blank-graph path (POST /versioning/blank-graphs, from the Explorer's wizard, and every
    Playground start) asks which providers share a server; with a service link in FALKORDB_PORT it
    raised ValueError, so no blank graph could be created."""
    from backend.app.services.managed_sources import same_server_providers

    monkeypatch.setenv("FALKORDB_HOST", "10.0.0.5")
    if raw is not None:
        monkeypatch.setenv("FALKORDB_PORT", raw)
    session = _Session([("prov_same", "10.0.0.5", 6379, None), ("prov_other", "10.0.0.6", 6379, None)])
    assert asyncio.run(same_server_providers(session, None)) == ["default", "prov_same"]
    assert asyncio.run(same_server_providers(session, "prov_same")) == ["prov_same", "default"]
    assert asyncio.run(same_server_providers(session, "prov_other")) == ["prov_other"]


def test_a_connection_configured_wrongly_is_linked_to_nothing_and_fails_nothing(monkeypatch):
    """Only providers configured correctly are linked: an env instance whose FALKORDB_PORT isn't a
    port (here another store's URL) is neither guessed at nor allowed to fail the caller."""
    from backend.app.services.managed_sources import same_server_providers

    monkeypatch.setenv("FALKORDB_HOST", "10.0.0.5")
    monkeypatch.setenv("FALKORDB_PORT", PG_URL)
    session = _Session([("prov_same", "10.0.0.5", 6379, None), ("prov_twin", "10.0.0.5", 6379, None)])
    assert asyncio.run(same_server_providers(session, None)) == ["default"]
    assert asyncio.run(same_server_providers(session, "prov_same")) == ["prov_same", "prov_twin"]


def test_the_local_dev_override_takes_a_link(monkeypatch):
    from backend.app.providers.manager import apply_local_dev_falkordb_override

    monkeypatch.setenv("LOCAL_DEV_FALKORDB_OVERRIDE", "true")
    monkeypatch.setenv("FALKORDB_HOST", "localhost")
    monkeypatch.setenv("FALKORDB_PORT", "tcp://10.0.0.5:6380")
    assert apply_local_dev_falkordb_override("falkordb", 6379) == ("localhost", 6380)
    monkeypatch.delenv("FALKORDB_PORT")
    assert apply_local_dev_falkordb_override("falkordb", 6381) == ("localhost", 6381)


def test_the_env_instance_connects_on_a_links_port(monkeypatch):
    from backend.app.providers.falkordb_connection import env_conn_config

    monkeypatch.setenv("FALKORDB_PORT", LINK)
    assert env_conn_config().port == 6379
    monkeypatch.setenv("FALKORDB_PORT", "6380")
    assert env_conn_config().port == 6380


def test_an_env_instance_without_a_port_is_said_to_be_misconfigured(monkeypatch):
    """The Redis & Graph Store page shows why, without the value; nothing dials a guessed port."""
    from backend.app.api.v1.endpoints.redis_config import build_graph_role_view
    from backend.app.providers.falkordb_connection import env_conn_config
    from backend.common.interfaces.provider import ProviderConfigurationError

    monkeypatch.setenv("FALKORDB_PORT", PG_URL)
    with pytest.raises(ProviderConfigurationError, match="FALKORDB_PORT is not a port"):
        env_conn_config()
    view = build_graph_role_view()
    assert "FALKORDB_PORT is not a port" in view["error"]
    assert "s3cret" not in view["error"]
    monkeypatch.setenv("FALKORDB_PORT", LINK)
    view = build_graph_role_view()
    assert view["error"] is None and view["port"] == 6379
