/**
 * Fetch wrapper with AbortController timeout, session cookies, and
 * CSRF header propagation.
 *
 * Why these concerns live in one place: the codebase has ~20 service
 * modules, most with their own local ``request()`` helper that calls
 * this function. Centralising cookie + CSRF behaviour here means every
 * service gets it for free — the alternative was patching all 20.
 *
 * Behaviour:
 *   * ``credentials: 'include'`` by default so the HttpOnly session
 *     cookies are sent on every request (works in dev where the front-
 *     end proxies to the API and in production where the two are on
 *     different origins).
 *   * On non-GET/HEAD/OPTIONS methods the value of the ``nx_csrf``
 *     cookie is mirrored into the ``X-CSRF-Token`` header — the double-
 *     submit comparison the backend's CSRFMiddleware enforces.
 *   * Default 5 s timeout via AbortController; callers may override
 *     with ``timeoutMs`` and/or pass their own ``signal``.
 */

const DEFAULT_TIMEOUT_MS = 5_000
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const CSRF_COOKIE = 'nx_csrf'
const CSRF_HEADER = 'X-CSRF-Token'

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

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchInit } = init ?? {}
  const method = (fetchInit.method ?? 'GET').toUpperCase()

  const headers = new Headers(fetchInit.headers)
  if (!SAFE_METHODS.has(method) && !headers.has(CSRF_HEADER)) {
    const csrf = readCookie(CSRF_COOKIE)
    if (csrf) headers.set(CSRF_HEADER, csrf)
  }

  const controller = new AbortController()

  // If the caller already provided a signal, chain it
  if (fetchInit.signal) {
    fetchInit.signal.addEventListener('abort', () => controller.abort(fetchInit.signal!.reason))
  }

  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(input, {
      credentials: 'include',
      ...fetchInit,
      headers,
      signal: controller.signal,
    })
    return res
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new TypeError('Request timed out (backend may be unavailable)')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
