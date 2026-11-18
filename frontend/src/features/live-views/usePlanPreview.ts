/**
 * What saving a narrowing as a view would make, as the choices change.
 *
 * Each change waits a beat, and a newer question aborts the older one — the same
 * shape as Narrow's own preview (`useNarrowResolve`). The sources resolve through
 * the server's shared answer, so a plan right after a narrowing costs a cache hit.
 */
import { useCallback, useEffect, useState } from 'react'

import { narrowErrorText } from '@/features/narrow/useNarrowResolve'
import { useGraphProvider } from '@/providers'
import { isResolving, type MembershipPlan, type MembershipResolving, type PlanRequest } from '@/types/membership'

export type PlanState =
  | { status: 'idle' }
  | { status: 'loading'; last: MembershipPlan | null; resolving?: MembershipResolving | null }
  | { status: 'ready'; plan: MembershipPlan }
  | { status: 'error'; message: string }

const DEBOUNCE_MS = 250
/** How long one ask lets the server work out a large set before answering
 *  with its progress (202): asked again at once, until the plan is ready. */
const RESOLVE_WAIT_MS = 10_000

type Settled =
  | { key: string; attempt: number; plan: MembershipPlan }
  | { key: string; attempt: number; message: string }

/** `request` null: nothing to ask yet (a template not chosen). */
export function usePlanPreview(viewId: string | null, request: PlanRequest | null) {
  const provider = useGraphProvider()
  const [settled, setSettled] = useState<Settled | null>(null)
  const [resolving, setResolving] = useState<{ key: string; answer: MembershipResolving } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const key = request ? JSON.stringify(request) : null

  useEffect(() => {
    const plan = provider.planMembers?.bind(provider)
    if (!key || !viewId || !plan) return
    const body = JSON.parse(key) as PlanRequest
    const controller = new AbortController()
    const ask = () => {
      plan(viewId, { ...body, waitMs: RESOLVE_WAIT_MS }, { signal: controller.signal })
        .then((answer: MembershipPlan | MembershipResolving) => {
          if (controller.signal.aborted) return
          // Still working out what the sources reach: say how far, and carry on.
          if (isResolving(answer)) { setResolving({ key, answer }); ask(); return }
          setSettled({ key, attempt, plan: answer })
        })
        .catch((err) => {
          if (!controller.signal.aborted) setSettled({ key, attempt, message: narrowErrorText(err) })
        })
    }
    const timer = window.setTimeout(ask, DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [provider, viewId, key, attempt])

  let state: PlanState
  if (!key) state = { status: 'idle' }
  else if (!provider.planMembers) state = { status: 'error', message: 'This data source can’t save views from a query.' }
  else if (settled && settled.key === key && settled.attempt === attempt) {
    state = 'plan' in settled ? { status: 'ready', plan: settled.plan } : { status: 'error', message: settled.message }
  } else {
    state = {
      status: 'loading',
      last: settled && 'plan' in settled ? settled.plan : null,
      resolving: resolving?.key === key ? resolving.answer : null,
    }
  }

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { state, retry }
}
