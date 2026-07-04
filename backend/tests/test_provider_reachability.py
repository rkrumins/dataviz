"""resolve_provider_status — the single backend decision shared by the provider
status endpoint and the blank-model provisioning gate. Pure, no infra."""
from backend.app.providers.reachability import (
    resolve_provider_status, STATUS_READY, STATUS_UNAVAILABLE, STATUS_UNKNOWN,
)

PID = "prov_abc"


def _resolve(breakers=None, warmup=None, is_active=True):
    return resolve_provider_status(
        is_active=is_active, provider_id=PID,
        breaker_states=breakers or {}, warmup_cache=warmup or {})


def test_inactive_is_unknown():
    assert _resolve(is_active=False) == (STATUS_UNKNOWN, None)


def test_breaker_wins_and_is_authoritative():
    assert _resolve(breakers={f"{PID}:g1": "healthy"})[0] == STATUS_READY
    s, err = _resolve(breakers={f"{PID}:g1": "instantiation_failed"})
    assert s == STATUS_UNAVAILABLE and "instantiation_failed" in err
    assert _resolve(breakers={f"{PID}:g1": "unavailable"})[0] == STATUS_UNAVAILABLE
    assert _resolve(breakers={f"{PID}:g1": "degraded"})[0] == STATUS_UNAVAILABLE


def test_breaker_overrides_warmup():
    # A live-traffic breaker verdict beats a stale warmup result.
    s, _ = _resolve(breakers={f"{PID}:g1": "unavailable"}, warmup={PID: {"ok": True}})
    assert s == STATUS_UNAVAILABLE


def test_warmup_fallback_when_no_breaker():
    assert _resolve(warmup={PID: {"ok": True}})[0] == STATUS_READY
    s, err = _resolve(warmup={PID: {"ok": False, "reason": "dns_unresolvable"}})
    assert s == STATUS_UNAVAILABLE and err == "dns_unresolvable"


def test_never_observed_is_unknown():
    assert _resolve()[0] == STATUS_UNKNOWN


def test_breaker_key_must_match_provider_prefix():
    # A different provider's breaker must not leak into this one's status.
    assert _resolve(breakers={"prov_other:g1": "unavailable"})[0] == STATUS_UNKNOWN


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("provider reachability resolution: OK")
