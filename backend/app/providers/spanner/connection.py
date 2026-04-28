"""Spanner client / instance / database lifecycle.

Owns the lazy double-checked connection setup, the credential builder
(ADC / service-account / impersonation), the ThreadPoolExecutor used to
bridge the synchronous SDK into asyncio, and the deadline-bounded
``run_in_executor`` helper.

Emulator awareness lives here. When ``SPANNER_EMULATOR_HOST`` is set the
SDK skips authentication and routes RPCs to the local emulator; we also
pick a connection pool that matches the emulator's behavior (the
production ``PingingPool`` would otherwise leak background pings against
a short-lived test instance).
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from backend.common.interfaces.provider import ProviderConfigurationError

logger = logging.getLogger(__name__)


DEFAULT_QUERY_TIMEOUT_S = 5.0
DEFAULT_DDL_TIMEOUT_S = 60.0
DEFAULT_AGGR_TIMEOUT_S = 30.0
DEFAULT_RETRY_ATTEMPTS = 3
DEFAULT_THREAD_POOL = int(os.getenv("SPANNER_GRAPH_THREAD_POOL", "20"))
DEFAULT_READ_STALENESS_S = 10.0


def is_emulator() -> bool:
    """True when the SDK is pointed at the local emulator."""
    return bool(os.getenv("SPANNER_EMULATOR_HOST"))


class SpannerConnection:
    """Owns the Spanner SDK handles + executor for one provider instance.

    The provider keeps a single ``SpannerConnection`` and delegates every
    sync call through ``run_in_executor`` so async callers never block.
    """

    def __init__(
        self,
        *,
        project_id: str,
        instance_id: str,
        database_id: str,
        auth_method: str = "adc",
        credentials_json_b64: Optional[str] = None,
        impersonate_service_account: Optional[str] = None,
        thread_pool_size: int = DEFAULT_THREAD_POOL,
    ) -> None:
        if not project_id:
            raise ValueError("SpannerConnection requires project_id")
        if not instance_id:
            raise ValueError("SpannerConnection requires instance_id")

        self.project_id = project_id
        self.instance_id = instance_id
        self.database_id = (database_id or "").strip()
        self.auth_method = (auth_method or "adc").lower()
        self.credentials_json_b64 = credentials_json_b64
        self.impersonate_service_account = impersonate_service_account
        self._thread_pool_size = thread_pool_size

        self._client: Any = None  # google.cloud.spanner.Client
        self._instance: Any = None
        self._database: Any = None
        self._executor: Optional[ThreadPoolExecutor] = None
        self._connect_lock = asyncio.Lock()
        self._latency_samples: List[float] = []
        self._last_successful_query_at: Optional[float] = None

    @property
    def database(self) -> Any:
        return self._database

    @property
    def instance(self) -> Any:
        return self._instance

    @property
    def client(self) -> Any:
        return self._client

    @property
    def executor(self) -> Optional[ThreadPoolExecutor]:
        return self._executor

    @property
    def last_successful_query_at(self) -> Optional[float]:
        return self._last_successful_query_at

    # ------------------------------------------------------------------
    # Credentials
    # ------------------------------------------------------------------

    def build_credentials(self) -> Tuple[Any, Optional[str]]:
        """Return ``(credentials, project_override)`` per ``auth_method``.

        The emulator path bypasses credentials entirely — the SDK reads
        ``SPANNER_EMULATOR_HOST`` and uses an unauthenticated channel, so
        we return ``(None, None)`` regardless of auth_method.
        """
        if is_emulator():
            return None, None

        scopes = ["https://www.googleapis.com/auth/spanner.data"]

        if self.auth_method == "adc":
            return None, None

        if self.auth_method == "service_account_json":
            if not self.credentials_json_b64:
                raise ProviderConfigurationError(
                    "spanner_graph: auth_method='service_account_json' but no "
                    "credentials_json was provided. Paste the service-account "
                    "JSON key in the wizard or switch auth method."
                )
            try:
                raw = base64.b64decode(self.credentials_json_b64).decode("utf-8")
                info = json.loads(raw)
            except Exception as exc:  # noqa: BLE001
                raise ProviderConfigurationError(
                    f"spanner_graph: malformed service-account JSON: {exc}"
                ) from exc
            if (
                info.get("type") != "service_account"
                or not info.get("client_email")
                or not info.get("private_key")
            ):
                raise ProviderConfigurationError(
                    "spanner_graph: pasted JSON is not a valid service account "
                    "key (expected type='service_account' with client_email + "
                    "private_key)."
                )
            from google.oauth2 import service_account

            creds = service_account.Credentials.from_service_account_info(info, scopes=scopes)
            return creds, info.get("project_id")

        if self.auth_method == "impersonation":
            if not self.impersonate_service_account:
                raise ProviderConfigurationError(
                    "spanner_graph: auth_method='impersonation' but no "
                    "impersonate_service_account email was provided."
                )
            from google.auth import default as adc_default
            from google.auth import impersonated_credentials

            source_creds, _ = adc_default()
            target_creds = impersonated_credentials.Credentials(
                source_credentials=source_creds,
                target_principal=self.impersonate_service_account,
                target_scopes=scopes,
                lifetime=3600,
            )
            return target_creds, None

        raise ProviderConfigurationError(
            f"spanner_graph: unknown auth_method={self.auth_method!r}"
        )

    # ------------------------------------------------------------------
    # Lazy connect
    # ------------------------------------------------------------------

    async def ensure_connected(self) -> None:
        """Idempotent lazy connect under a double-checked lock."""
        if self._database is not None:
            return
        async with self._connect_lock:
            if self._database is not None:
                return
            if not self.database_id:
                raise ProviderConfigurationError(
                    "spanner_graph: database_id missing — set it via the data "
                    "source's graph_name (formatted '<database_id>.<property_graph_name>') "
                    "or in extra_config.database_id."
                )
            self._executor = ThreadPoolExecutor(
                max_workers=self._thread_pool_size,
                thread_name_prefix=f"spanner-{self.instance_id[:8]}",
            )
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(self._executor, self._connect_sync)
            logger.info(
                "spanner_graph: connected project=%s instance=%s database=%s emulator=%s",
                self.project_id,
                self.instance_id,
                self.database_id,
                is_emulator(),
            )

    def _connect_sync(self) -> None:
        """Build the SDK handles. Runs inside the executor."""
        from google.cloud import spanner  # local import — heavy SDK

        creds, _project_override = self.build_credentials()
        client = spanner.Client(project=self.project_id, credentials=creds)
        instance = client.instance(self.instance_id)

        # Pool selection: PingingPool keeps sessions warm in production
        # (avoids first-query cold start). The emulator runs in-process
        # and doesn't need warming; PingingPool's background ping thread
        # also leaks against short-lived test instances.
        if is_emulator():
            pool = spanner.FixedSizePool(size=self._thread_pool_size)
        else:
            pool = spanner.PingingPool(
                size=self._thread_pool_size,
                default_timeout=DEFAULT_QUERY_TIMEOUT_S,
            )
        database = instance.database(self.database_id, pool=pool)

        # Probe the connection so auth / not-found errors surface here.
        with database.snapshot() as snap:
            list(snap.execute_sql("SELECT 1"))

        self._client = client
        self._instance = instance
        self._database = database

    # ------------------------------------------------------------------
    # Async ↔ sync bridge
    # ------------------------------------------------------------------

    async def run_in_executor(
        self,
        fn: Callable[..., Any],
        *args: Any,
        timeout: float = DEFAULT_QUERY_TIMEOUT_S,
    ) -> Any:
        """Run a sync callable on the provider's executor with a deadline."""
        if self._executor is None:
            await self.ensure_connected()
        assert self._executor is not None
        loop = asyncio.get_running_loop()
        t0 = time.monotonic()
        try:
            return await asyncio.wait_for(
                loop.run_in_executor(self._executor, fn, *args),
                timeout=timeout,
            )
        finally:
            duration = time.monotonic() - t0
            self._record_latency(duration)
            if duration < timeout:
                self._last_successful_query_at = time.time()

    async def run_with_retry(
        self,
        fn: Callable[[], Any],
        *,
        timeout: float,
        attempts: int = DEFAULT_RETRY_ATTEMPTS,
    ) -> Any:
        """Retry transient errors with exponential backoff.

        Aborted retries are handled inside ``run_in_transaction`` by the
        SDK itself; this layer covers ServiceUnavailable / DeadlineExceeded
        on the read path.
        """
        from .errors import is_transient

        last_exc: Optional[BaseException] = None
        for attempt in range(attempts):
            try:
                return await self.run_in_executor(fn, timeout=timeout)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                if is_transient(exc) and attempt + 1 < attempts:
                    backoff = min(2**attempt * 0.1, 1.0)
                    await asyncio.sleep(backoff)
                    continue
                raise
        if last_exc is not None:
            raise last_exc
        return None

    def _record_latency(self, duration_s: float) -> None:
        # Bounded ring buffer of 256 samples; cheap p50/p95 for diagnostics.
        self._latency_samples.append(duration_s)
        if len(self._latency_samples) > 256:
            self._latency_samples = self._latency_samples[-256:]

    def latency_percentiles(self) -> Tuple[Optional[float], Optional[float]]:
        if not self._latency_samples:
            return None, None
        window = sorted(self._latency_samples)
        n = len(window)
        return window[max(0, int(n * 0.50) - 1)], window[max(0, int(n * 0.95) - 1)]

    # ------------------------------------------------------------------
    # Shutdown
    # ------------------------------------------------------------------

    async def close(self) -> None:
        if self._client is not None:
            client = self._client
            self._client = None
            self._instance = None
            self._database = None
            try:
                if self._executor is not None:
                    loop = asyncio.get_running_loop()
                    await loop.run_in_executor(self._executor, client.close)
                else:
                    client.close()
            except Exception as exc:  # noqa: BLE001
                logger.debug("spanner_graph: client.close failed: %s", exc)
        if self._executor is not None:
            self._executor.shutdown(wait=False, cancel_futures=True)
            self._executor = None
