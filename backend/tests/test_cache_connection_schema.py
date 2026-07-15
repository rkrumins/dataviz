"""extra_config is PLAINTEXT in the DB and is returned by ProviderResponse.
Secrets must therefore never be accepted into it — that is exactly how
falkordbConnection.sentinel.password ended up stored in the clear and echoed
back over the API."""
import pytest
from pydantic import ValidationError

from backend.common.models.management import ProviderCreateRequest


def _req(**extra):
    base = dict(
        name="p", providerType="falkordb", host="h", port=6379,
        credentials={"username": "u", "password": "p"},
    )
    base.update(extra)
    return base


def test_valid_cache_connection_is_accepted():
    r = ProviderCreateRequest(**_req(extraConfig={
        "cacheConnection": {
            "mode": "standalone", "host": "cache-b", "port": 6379, "db": 0,
            "tls": {"enabled": True, "caCertPath": "/certs/cache/ca.crt"},
        }
    }))
    assert r.extra_config["cacheConnection"]["host"] == "cache-b"


def test_cluster_mode_is_rejected():
    with pytest.raises(ValidationError, match="cluster"):
        ProviderCreateRequest(**_req(extraConfig={
            "cacheConnection": {"mode": "cluster", "host": "h"}
        }))


def test_sentinel_requires_master_and_nodes():
    with pytest.raises(ValidationError, match="sentinel"):
        ProviderCreateRequest(**_req(extraConfig={
            "cacheConnection": {"mode": "sentinel", "host": "h"}
        }))


@pytest.mark.parametrize("secret_key", ["password", "cachePassword", "authToken"])
def test_secrets_are_refused_inside_extra_config(secret_key):
    with pytest.raises(ValidationError, match="credentials"):
        ProviderCreateRequest(**_req(extraConfig={
            "cacheConnection": {"host": "h", secret_key: "leaked"}
        }))


def test_cache_credentials_are_accepted_in_the_encrypted_blob():
    r = ProviderCreateRequest(**_req(credentials={
        "username": "u", "password": "p",
        "cache_username": "cu", "cache_password": "cp",
    }))
    assert r.credentials.cache_username == "cu"
    assert r.credentials.cache_password == "cp"
