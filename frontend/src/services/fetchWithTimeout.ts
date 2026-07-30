/**
 * Fetch wrapper with AbortController timeout, session cookies, CSRF,
 * and transparent refresh-on-401.
 *
 * One wrapper carries four cross-cutting concerns because the codebase
 * has ~20 service modules that each call ``fetchWithTimeout`` directly.
 * Centralising here means every service inherits the full session
 * behaviour; the alternative is patching all of them.
 *
 * Behaviour:
 *   * ``credentials: 'include'`` — HttpOnly session cookies on every call.
 *   * On non-GET/HEAD/OPTIONS methods the value of the ``nx_csrf``
 *     cookie is mirrored into the ``X-CSRF-Token`` header.
 *   * On 401 for non-auth routes, a single silent ``POST /auth/refresh``
 *     is attempted; on success the original request is retried once
 *     with the rotated cookies. Concurrent 401s share the same in-flight
 *     refresh. If refresh fails we dispatch ``'auth:session-lost'`` on
 *     ``window`` so the auth store can transition to unauthenticated.
 *   * Default timeout via AbortController, sourced from
 *     ``TIMEOUTS.DEFAULT_MS`` in ``src/config/timeouts.ts`` (30 s out of
 *     the box, overridable via ``VITE_TIMEOUT_DEFAULT_MS``). Per-call
 *     override remains supported via the ``timeoutMs`` option — see
 *     ``RemoteGraphProvider`` for trace / children / aggregated-edges
 *     overrides. Earlier 8 s default was aborting legitimately slow BE
 *     responses on deep trace traversals.
 *
 * Exactly ONE endpoint is exempt from the refresh-on-401 dance:
 * /auth/refresh itself, which would otherwise recurse into itself. Not
 * /auth/* as a whole — /auth/me 401ing on boot is precisely the case
 * the silent refresh exists to recover, and it must keep going through
 * it. See {@link REFRESH_EXEMPT_PATHS}.
 *
 * The /login ROUTE is exempt too, and that is a different rule from the
 * endpoint list: see {@link onLoginRoute}.
 */

import { TIMEOUTS } from '../config/timeouts'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const CSRF_COOKIE = 'nx_csrf'
const CSRF_HEADER = 'X-CSRF-Token'
const REFRESH_URL = '/api/v1/auth/refresh'
const LOGIN_PATH = '/login'
const SESSION_LOST_EVENT = 'auth:session-lost'
const ACCESS_DENIED_EVENT = 'auth:access-denied'

/** Cap how long we'll wait when honoring a server-provided Retry-After. */
const RETRY_AFTER_MAX_MS = 5_000

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null
  const prefix = `${name}=`
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length))
    }
  }
  return null
}

function urlPath(input: RequestInfo | URL): string {
  const raw =
    typeof input === 'string'
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url
  try {
    return new URL(raw, 'http://local').pathname
  } catch {
    return raw
  }
}

/**
 * Endpoints that must never trigger the silent refresh-on-401.
 *
 * A set rather than a bare ``===`` so the membership is explicit and
 * greppable: the module docstring used to claim all of /auth/* was in
 * here, and nothing in the code said otherwise. Only /auth/refresh is,
 * because bouncing it off itself would recurse. Every other endpoint,
 * including /auth/me called on boot, benefits from the silent refresh
 * so a still-valid refresh cookie can resurrect an expired access
 * cookie without ever logging the user out.
 */
const REFRESH_EXEMPT_PATHS = new Set([REFRESH_URL])

function isRefreshExempt(input: RequestInfo | URL): boolean {
  return REFRESH_EXEMPT_PATHS.has(urlPath(input))
}

/**
 * True while the user is sitting on the login page.
 *
 * The login page is deliberately NOT allowed to recover a session
 * silently. Landing on /login used to 401, silently refresh, succeed,
 * and sign the user in without them typing anything — which also made
 * switching accounts impossible. Scoped to this ONE route on purpose:
 * reloading /dashboard with an expired access cookie must still recover
 * silently, because there the user has already said who they are.
 */
function onLoginRoute(): boolean {
  if (typeof window === 'undefined') return false
  const path = window.location.pathname
  return path === LOGIN_PATH || path === `${LOGIN_PATH}/`
}

/**
 * What a refresh attempt actually established. This used to be a
 * ``boolean``, which collapsed "your session is gone" and "the network
 * hiccuped" into the same ``false`` — and ``false`` signed the user out.
 * That is why a rate-limited /auth/refresh logged people out at random.
 *
 *   * ``ok``        — rotated; retry the original request.
 *   * ``reauth``    — SSO re-auth envelope; we are navigating to the
 *                     IdP, so nobody should see the login screen flash.
 *   * ``expired``   — a definitive 401. The ONLY outcome allowed to
 *                     reach {@link notifySessionLost}.
 *   * ``retryable`` — 429 / 5xx / thrown network error, already retried
 *                     once. We learned nothing about the session, so the
 *                     caller surfaces the original 401 and signs nobody
 *                     out.
 */
type RefreshOutcome = 'ok' | 'reauth' | 'expired' | 'retryable'

/**
 * Single in-flight refresh promise — concurrent 401s share one network
 * call instead of each spawning its own. Cleared synchronously when it
 * settles, so a later unrelated 401 can start a fresh one.
 */
let refreshInFlight: Promise<RefreshOutcome> | null = null

/**
 * Set when we have announced a lost session; cleared by a successful
 * refresh or by {@link resetSessionLostLatch} on login.
 *
 * Two jobs. It keeps a burst of 401s from dispatching a burst of
 * session-lost events (they are STAGGERED, so the in-flight promise
 * above doesn't collapse them), and it short-circuits further refresh
 * attempts: once the session is known to be gone, every extra POST to
 * /auth/refresh is a request the server has already answered.
 */
let sessionLostAt: number | null = null

/** How long one announcement suppresses the next. */
const SESSION_LOST_WINDOW_MS = 10_000

/**
 * Clear the session-lost latch. Called from the auth store's login /
 * portal-login / auto-signin paths — a fresh session deserves a fresh
 * attempt, exactly like ``resetClaimRecovery()`` next to it.
 */
export function resetSessionLostLatch(): void {
  sessionLostAt = null
}

/**
 * One POST to /auth/refresh, classified. ``retryAfterMs`` is only ever
 * populated alongside ``retryable`` — it is the server's own backoff ask.
 */
async function attemptRefresh(): Promise<{
  outcome: RefreshOutcome
  retryAfterMs: number | null
}> {
  try {
    // Bare fetch — avoids the circular import that would exist if this
    // module pulled in authService, and avoids recursing through the
    // refresh-on-401 logic above (the isAuthEndpoint guard would catch
    // it anyway, but going direct is cheaper).
    const res = await fetch(REFRESH_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    })
    if (res.ok) {
      // Phase 10: the new JWT carries re-resolved claims (the
      // backend refresh path calls ``permission_service.resolve``
      // — see auth_service/service.py:365). Re-hydrate the FE
      // store so route guards (RequirePermission, TopBar admin
      // cog) react to role / binding mutations made
      // mid-session. Fire-and-forget — a failed re-hydrate
      // logs and the next page transition picks up fresh state.
      // Dynamic import avoids a circular dep through the auth
      // store.
      //
      // After the store rehydrates, compare claims before/after: a
      // rotated JWT with IDENTICAL claims changes no data, so the
      // blanket invalidation below is skipped and React Query's
      // staleTime governs freshness. Only a real access shift
      // (rare) pays the full refetch wave — exactly the behaviour
      // users expect after their access shifts mid-session, without
      // a 15-20 request burst on every routine ~5-min token
      // rotation.
      void (async () => {
        try {
          const mod = await import('@/store/auth')
          const before = mod.claimsSnapshot(mod.useAuthStore.getState().permissions)
          // skipAuthRefresh: we JUST refreshed the token, so this
          // re-resolve's GET /me/session must NOT re-enter the
          // 401→refresh→re-resolve path. Without it, a /me/session that
          // still 401s recurses at network speed — the app-wide request
          // storm.
          await mod.useAuthStore.getState().refreshPermissions({ skipAuthRefresh: true })
          const after = mod.claimsSnapshot(mod.useAuthStore.getState().permissions)
          if (before === after) return
          try {
            const qcMod = await import('@/lib/queryClient')
            const qc = qcMod.getQueryClient()
            if (qc) await qc.invalidateQueries()
          } catch {
            // best-effort — the next user-triggered render still
            // resolves fresh data within React Query's staleTime.
          }
          // Reload Zustand stores + emit ``permissions:changed``
          // for page-level caches. Without this, the sidebar /
          // CommandPalette / open page would keep their pre-
          // revocation cache because they don't live in React
          // Query. See store/permissionChangeBus.ts.
          try {
            const busMod = await import('@/store/permissionChangeBus')
            await busMod.notifyPermissionsChanged()
          } catch {
            // best-effort
          }
        } catch {
          // best-effort
        }
      })()
      return { outcome: 'ok', retryAfterMs: null }
    }

    // SSO daily ceiling: the backend signals "session expired at the
    // IdP, follow login_url to re-authenticate" via a structured 401
    // body. Navigate transparently — the user shouldn't have to click
    // anything; they just see one extra IdP redirect that completes
    // automatically when the IdP session is still warm.
    if (res.status === 401) {
      try {
        const body = (await res.clone().json()) as {
          detail?: { error?: string; login_url?: string }
        }
        const detail = body?.detail
        if (
          detail?.error === 'sso_reauth_required'
          && typeof detail.login_url === 'string'
          && detail.login_url.startsWith('/')
        ) {
          // Wipe the cached user DTO before the bounce. The IdP
          // re-auth may resolve to a different account, and we
          // don't want a stale cache seeding the next /auth/me.
          // Dynamic import avoids a top-level circular dep through
          // the auth store.
          try {
            const mod = await import('@/store/userCache')
            mod.clearUserCache()
          } catch {
            // ignore — bounce still happens
          }
          if (typeof window !== 'undefined') {
            window.location.href = detail.login_url
          }
          // Not "success", but not a lost session either: we're about
          // to navigate, so nobody should be signed out or shown the
          // /login screen mid-bounce.
          return { outcome: 'reauth', retryAfterMs: null }
        }
      } catch {
        // Body wasn't the structured envelope — a plain 401.
      }
      // A 401 that is NOT the re-auth envelope is the one definitive
      // answer the server can give us: the session really is gone.
      return { outcome: 'expired', retryAfterMs: null }
    }

    // 429 (rate-limited), 5xx, or anything else. The server declined
    // to answer the question; it did not answer "no". Signing the user
    // out on this is what randomly logged people out whenever
    // /auth/refresh was rate-limited.
    return {
      outcome: 'retryable',
      retryAfterMs: parseRetryAfterMs(res.headers.get('Retry-After')),
    }
  } catch {
    // Threw — DNS, offline, connection reset. Says nothing about the
    // session either.
    return { outcome: 'retryable', retryAfterMs: null }
  }
}

async function tryRefresh(): Promise<RefreshOutcome> {
  // The server has already told us this session is gone. Every further
  // POST would just re-ask a settled question.
  if (sessionLostAt !== null) return 'expired'
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    try {
      const first = await attemptRefresh()
      if (first.outcome !== 'retryable') {
        if (first.outcome === 'ok') sessionLostAt = null
        return first.outcome
      }
      // ONE bounded retry, honouring the server's Retry-After. The 429
      // handling further down can't cover this: it only retries safe
      // methods, and it never sees the bare POST above.
      const waitMs = first.retryAfterMs
      if (waitMs !== null) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs))
      }
      const second = await attemptRefresh()
      if (second.outcome === 'ok') sessionLostAt = null
      return second.outcome
    } finally {
      // Synchronous, not queueMicrotask. Deferring it left a window in
      // which the promise was settled but still shared — harmless — and,
      // more to the point, made the lifetime of the de-dup depend on
      // microtask timing rather than on the request. Rotation is
      // idempotent inside the grace window, so a duplicate POST is
      // absorbed today; with REFRESH_ROTATION_GRACE_SECONDS=0, which the
      // backend documents as a supported setting, a duplicate is read as
      // a stolen chain and kills the family.
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

function notifySessionLost(): void {
  if (typeof window === 'undefined') return
  // One announcement per window. A burst of 401s arrives STAGGERED, so
  // the shared in-flight promise doesn't collapse them — without this
  // latch each one dispatches its own sign-out.
  const now = Date.now()
  if (sessionLostAt !== null && now - sessionLostAt < SESSION_LOST_WINDOW_MS) return
  sessionLostAt = now
  window.dispatchEvent(new CustomEvent(SESSION_LOST_EVENT))
}

/**
 * Parse the value of an HTTP ``Retry-After`` header. Returns the wait in
 * milliseconds, capped to {@link RETRY_AFTER_MAX_MS}. Returns ``null``
 * when the header is missing or malformed.
 *
 * Supports both the integer-seconds form (most common, what FastAPI
 * emits) and the HTTP-date form. We add 10–250 ms of jitter so a fleet
 * of clients receiving the same Retry-After don't all retry on the same
 * tick — the thundering herd the load-shed signal exists to prevent.
 */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null
  const trimmed = header.trim()
  if (!trimmed) return null

  let ms: number | null = null
  const asNum = Number(trimmed)
  if (Number.isFinite(asNum) && asNum >= 0) {
    ms = Math.floor(asNum * 1000)
  } else {
    const ts = Date.parse(trimmed)
    if (!Number.isNaN(ts)) ms = ts - Date.now()
  }
  if (ms === null || ms < 0) return null
  const jitter = 10 + Math.floor(Math.random() * 240)
  return Math.min(RETRY_AFTER_MAX_MS, ms + jitter)
}


/**
 * Notify the AppLayout-mounted access-denied modal that a request was
 * 403'd. The detail object carries enough for the modal to render a
 * useful message; the missing-permission name comes from the backend's
 * ``detail`` field which is shaped by the ``requires(...)`` factory as
 * ``"Missing permission: <perm>"``.
 *
 * The event handler is fire-and-forget — calling code still receives
 * the underlying ``Response`` (or thrown error from ``apiClient``) so
 * per-call error handling can remain in place.
 */
async function notifyAccessDenied(res: Response, requestPath: string): Promise<void> {
  if (typeof window === 'undefined') return
  let detail: string | null = null
  let permission: string | null = null
  let scope: { type: 'global' | 'workspace'; id: string | null } | null = null
  try {
    const clone = res.clone()
    const text = await clone.text()
    if (text) {
      try {
        // Phase 5: the backend ``requires()`` 403 body is structured:
        //   { detail: { error, permission, scope, message } }
        // We tolerate both the old (string detail) and new (dict detail)
        // shapes so a deploy mid-upgrade doesn't render '[object Object]'.
        const body = JSON.parse(text) as {
          detail?: string | {
            error?: string
            permission?: string
            scope?: { type?: 'global' | 'workspace'; id?: string | null }
            message?: string
          }
        }
        if (typeof body.detail === 'string') {
          detail = body.detail
        } else if (body.detail) {
          detail = body.detail.message ?? body.detail.error ?? null
          permission = body.detail.permission ?? null
          scope = body.detail.scope
            ? {
                type: body.detail.scope.type ?? 'global',
                id: body.detail.scope.id ?? null,
              }
            : null
        }
      } catch {
        detail = text
      }
    }
  } catch {
    // ignore — we'll dispatch with detail=null
  }
  window.dispatchEvent(
    new CustomEvent(ACCESS_DENIED_EVENT, {
      detail: { detail, permission, scope, path: requestPath, status: res.status },
    }),
  )
}

/**
 * Build the Headers object for a request, injecting CSRF on writes and
 * defaulting ``Content-Type: application/json`` when the body is a
 * JSON-stringified payload.
 *
 * Why the Content-Type default: every service module here calls
 * ``authFetch(url, { method: 'POST', body: JSON.stringify(data) })`` —
 * i.e., the body is already a JSON string — and none of them set the
 * header explicitly. Without this default, ``fetch`` infers
 * ``text/plain;charset=UTF-8`` from the string body, FastAPI parses the
 * entire body as a single string field, and every Pydantic model in the
 * backend rejects it with *"Input should be a valid dictionary or object
 * to extract fields from"*. Defaulting here fixes every POST/PUT/PATCH
 * at once. FormData / Blob / URLSearchParams bodies skip this branch so
 * the browser's auto-detected multipart/octet-stream boundaries are
 * preserved.
 *
 * Factored out so both the original attempt and the post-refresh retry
 * re-read a possibly-rotated ``nx_csrf`` cookie.
 */
function buildHeaders(
  method: string,
  raw: HeadersInit | undefined,
  body: BodyInit | null | undefined,
): Headers {
  const headers = new Headers(raw)
  if (!SAFE_METHODS.has(method) && !headers.has(CSRF_HEADER)) {
    const csrf = readCookie(CSRF_COOKIE)
    if (csrf) headers.set(CSRF_HEADER, csrf)
  }
  if (typeof body === 'string' && body.length > 0 && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  return headers
}

async function runOnce(
  input: RequestInfo | URL,
  fetchInit: RequestInit,
  method: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  if (fetchInit.signal) {
    fetchInit.signal.addEventListener('abort', () =>
      controller.abort((fetchInit.signal as AbortSignal).reason),
    )
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, {
      credentials: 'include',
      ...fetchInit,
      headers: buildHeaders(method, fetchInit.headers, fetchInit.body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit & { timeoutMs?: number; silent403?: boolean; skipAuthRefresh?: boolean },
): Promise<Response> {
  const { timeoutMs = TIMEOUTS.DEFAULT_MS, silent403 = false, skipAuthRefresh = false, ...fetchInit } = init ?? {}
  const method = (fetchInit.method ?? 'GET').toUpperCase()

  let res: Response
  try {
    res = await runOnce(input, fetchInit, method, timeoutMs)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new TypeError(
        `Request timed out after ${Math.round(timeoutMs / 1000)}s ` +
        '(client-side limit — backend may be slow or unavailable)',
      )
    }
    throw err
  }

  // Silent refresh: access cookie expired (or missing) but the refresh
  // cookie may still be good. Attempt exactly one refresh + retry before
  // giving up. /auth/refresh itself is exempt so its own 401 doesn't
  // recurse into another refresh, and so is the /login route — see
  // ``onLoginRoute``.
  if (
    res.status === 401
    && !isRefreshExempt(input)
    && !skipAuthRefresh
    && !onLoginRoute()
  ) {
    const outcome = await tryRefresh()
    if (outcome === 'ok' || outcome === 'reauth') {
      try {
        return await runOnce(input, fetchInit, method, timeoutMs)
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw new TypeError(
            `Request timed out after ${Math.round(timeoutMs / 1000)}s ` +
            '(client-side limit — backend may be slow or unavailable)',
          )
        }
        throw err
      }
    }
    // 'retryable' means we never got an answer about the session (429,
    // 5xx, network). Surface the original 401 and sign NOBODY out.
    if (outcome === 'expired') notifySessionLost()
  }

  // Server-side backpressure: 429 (queue saturated, fair-share cap) or
  // 503 (provider unavailable / circuit open). Both carry Retry-After.
  // We honor it ONCE with jitter on idempotent methods only — retrying a
  // POST/PUT/PATCH would risk duplicate side-effects.
  if ((res.status === 429 || res.status === 503) && SAFE_METHODS.has(method)) {
    const waitMs = parseRetryAfterMs(res.headers.get('Retry-After'))
    if (waitMs !== null) {
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs))
      try {
        return await runOnce(input, fetchInit, method, timeoutMs)
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw new TypeError(
            `Request timed out after ${Math.round(timeoutMs / 1000)}s ` +
            '(client-side limit — backend may be slow or unavailable)',
          )
        }
        throw err
      }
    }
  }

  // 403 surfaces as a non-blocking modal mounted by AppLayout. We do
  // NOT short-circuit the request — the calling service still gets the
  // Response and can shape its own error handling — we just announce
  // the denial centrally so the user sees a clear "you don't have X"
  // message instead of a generic toast.
  //
  // Callers can opt out with ``silent403: true`` when the 403 is an
  // expected outcome for a user tier (a background probe firing an
  // admin-only endpoint to render counts, for example). The Response
  // still flows through so the service can degrade gracefully — only
  // the global modal is suppressed.
  // A forced password rotation is announced the same structured way,
  // and needs to win over the access-denied modal: the account is not
  // missing a permission, it is being held until it picks a new
  // password. Every route but the change screen answers this way, so
  // whichever request happens to fire first does the redirect.
  if (res.status === 403) {
    try {
      const body = (await res.clone().json()) as {
        detail?: { error?: string }
      }
      if (body?.detail?.error === 'password_change_required') {
        if (!window.location.pathname.startsWith('/password-change-required')) {
          window.location.assign('/password-change-required')
        }
        return res
      }
    } catch {
      // Not a JSON body — fall through to the normal 403 handling.
    }
    if (!silent403) void notifyAccessDenied(res, urlPath(input))
  }

  return res
}
