/**
 * featuresService.update() error handling.
 *
 * Regression guard for the "response body" bug: the shared request() helper used
 * to read the Response body twice on a non-2xx reply (res.json() then res.text()),
 * which throws the browser's native "Response body is already used" TypeError when
 * the body is empty or non-JSON — masking the real failure on every failed toggle.
 * These tests pin the single-read behaviour: a non-JSON/empty error body yields a
 * clean, status-aware message, and JSON error bodies keep their friendly copy.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

const { fetchWithTimeoutMock } = vi.hoisted(() => ({ fetchWithTimeoutMock: vi.fn() }))
vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: fetchWithTimeoutMock }))

import { featuresService, FeaturesConcurrencyError } from '../featuresService'

const BODY_STREAM_ERROR = /body|already read|already used|unusable/i

async function updateError(): Promise<Error> {
  return featuresService.update({ version: 0 }).then(
    () => {
      throw new Error('expected update() to reject')
    },
    (e: unknown) => e as Error,
  )
}

describe('featuresService.update — error body handling', () => {
  beforeEach(() => fetchWithTimeoutMock.mockReset())

  it('does NOT double-read on a non-JSON (proxy HTML) 502; message is status-aware', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    )
    const err = await updateError()
    expect(err.message).toContain('502')
    expect(err.message).not.toMatch(BODY_STREAM_ERROR)
  })

  it('does NOT double-read on an empty 500 body; message is status-aware', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(new Response('', { status: 500 }))
    const err = await updateError()
    expect(err.message).toContain('500')
    expect(err.message).not.toMatch(BODY_STREAM_ERROR)
  })

  it('surfaces the backend detail from a JSON 500 (Part B path)', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: 'Internal Server Error' }), { status: 500 }),
    )
    const err = await updateError()
    expect(err.message).toBe('Internal Server Error')
  })

  it('keeps the friendly 429 copy from a nested detail body', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: { detail: 'Slow down there' } }), { status: 429 }),
    )
    const err = await updateError()
    expect(err.message).toBe('Slow down there')
  })

  it('falls back to the friendly 429 default when the body is empty', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(new Response('', { status: 429 }))
    const err = await updateError()
    expect(err.message).toMatch(/too many updates/i)
  })

  it('throws FeaturesConcurrencyError on 409', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: 'version mismatch' }), { status: 409 }),
    )
    const err = await updateError()
    expect(err).toBeInstanceOf(FeaturesConcurrencyError)
  })

  it('returns the parsed response on success', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ values: { editModeEnabled: true }, version: 2 }), {
        status: 200,
      }),
    )
    const res = await featuresService.update({ version: 1 })
    expect(res.version).toBe(2)
    expect(res.values).toEqual({ editModeEnabled: true })
  })

  // The nginx-405 bug: an env-derived base URL routed this PATCH outside `/api/`, so it hit the
  // SPA static fallback and 405'd. Lock the URL to the same-origin `/api/` path like every sibling.
  it('sends the toggle PATCH to the same-origin /api/v1/admin/features path', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ values: {}, version: 1 }), { status: 200 }),
    )
    await featuresService.update({ version: 0 })
    const [url, init] = fetchWithTimeoutMock.mock.calls[0]
    expect(url).toBe('/api/v1/admin/features')
    expect(String(url).startsWith('/api/')).toBe(true)
    expect((init as RequestInit | undefined)?.method).toBe('PATCH')
  })
})
