/**
 * Resolve a narrowing on the server, as the composer's spec changes.
 *
 * Each change waits a beat (a stepper clicked three times asks once), and a newer
 * spec aborts the request for an older one. The answer the composer previews IS
 * the answer applying uses: the server keys it by the spec's hash and shares it
 * with everyone asking, so pressing Narrow after the preview costs nothing.
 */
import { useCallback, useEffect, useState } from 'react'

import { useGraphProvider } from '@/providers'
import { httpStatusOf, isClientTimeout } from '@/services/graphRequestFailure'
import type { MembershipResult, MembershipSpec } from '@/types/membership'

import { specKey } from './model'

export type ResolveState =
  | { status: 'idle' }
  | { status: 'loading'; key: string; last: MembershipResult | null }
  | { status: 'ready'; key: string; result: MembershipResult }
  | { status: 'error'; key: string; message: string }

const DEBOUNCE_MS = 250

/** The server's words where it gave some (a switch that is off says which). */
function serverMessage(err: unknown): string | null {
  const m = err instanceof Error ? /^API Error \d+: (.*)$/s.exec(err.message) : null
  if (!m) return null
  try {
    const detail = (JSON.parse(m[1]) as { detail?: unknown }).detail
    if (detail && typeof detail === 'object' && typeof (detail as { message?: unknown }).message === 'string') {
      return (detail as { message: string }).message
    }
  } catch { /* not JSON */ }
  return null
}

/** A failed resolution, in words. */
export function narrowErrorText(err: unknown): string {
  const said = serverMessage(err)
  if (said) return said
  const status = httpStatusOf(err)
  if (status === 429 || status === 503) return 'The graph is busy right now. Try again in a moment.'
  if (status === 404) return 'This view can’t be found, or you can’t open it.'
  if (status === 501) return 'This data source can’t narrow the canvas.'
  if (isClientTimeout(err)) return 'That took too long. Try a shorter reach, or try again.'
  return 'Couldn’t work out what to show. Try again.'
}

type Settled =
  | { key: string; attempt: number; result: MembershipResult }
  | { key: string; attempt: number; message: string }

/** `spec` is held, not rebuilt each render (the composer keeps it in state): a
 *  new object is a new question. */
export function useNarrowResolve(viewId: string | null, spec: MembershipSpec | null) {
  const provider = useGraphProvider()
  const [settled, setSettled] = useState<Settled | null>(null)
  const [attempt, setAttempt] = useState(0)
  const key = spec ? specKey(spec) : null

  useEffect(() => {
    const resolve = provider.resolveMembers?.bind(provider)
    if (!spec || !viewId || !resolve) return
    const key = specKey(spec)
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      resolve(viewId, { spec }, { signal: controller.signal })
        .then((result) => { if (!controller.signal.aborted) setSettled({ key, attempt, result }) })
        .catch((err) => {
          if (!controller.signal.aborted) setSettled({ key, attempt, message: narrowErrorText(err) })
        })
    }, DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [provider, viewId, spec, attempt])

  // What the composer shows is derived, never set in step with the spec: the
  // answer for this spec once it has come, and until then the last one, dimmed.
  let state: ResolveState
  if (!key) state = { status: 'idle' }
  else if (!provider.resolveMembers) state = { status: 'error', key, message: 'This data source can’t narrow the canvas.' }
  else if (settled && settled.key === key && settled.attempt === attempt) {
    state = 'result' in settled
      ? { status: 'ready', key, result: settled.result }
      : { status: 'error', key, message: settled.message }
  } else state = { status: 'loading', key, last: settled && 'result' in settled ? settled.result : null }

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { state, retry }
}
