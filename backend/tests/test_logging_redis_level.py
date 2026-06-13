"""configure_json_logging must pin the chatty redis loggers to INFO so a
global LOG_LEVEL=DEBUG (used to debug our own code) does not flood the output
with redis connection DEBUG noise."""
import logging

from backend.app.middleware.logging import configure_json_logging


def test_redis_loggers_pinned_to_info_under_debug(monkeypatch):
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    configure_json_logging()
    assert logging.getLogger().level == logging.DEBUG  # root honors LOG_LEVEL
    assert logging.getLogger("redis").level == logging.INFO
    assert logging.getLogger("redis.connection").level == logging.INFO
