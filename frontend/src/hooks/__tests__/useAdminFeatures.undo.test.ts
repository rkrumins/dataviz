/**
 * The Undo on "Lineage trace — turned off" has to actually put it back.
 *
 * It is a closure, and the notification store keeps closures VERBATIM: the one the page hands over
 * outlives by seconds the render that made it. So whatever that closure captured is what it will
 * still be holding when the admin reaches for it — and `handleChange` used to capture `data`,
 * which carries the optimistic-concurrency `version`. By the time the Undo was clicked the save it
 * reverses had already moved the server on, so the undo PATCHed a version that no longer existed:
 * the admin got "Someone else saved. Reloaded." and the feature stayed off.
 *
 * The page's own test cannot see any of this — it mocks this hook wholesale. This one drives the
 * REAL hook against a service that enforces `version` the way the endpoint does.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAdminFeatures } from '../useAdminFeatures'
import { useNotificationStore } from '@/components/ui/notifications'

/** The saved state, as a server that refuses a stale write would hold it. */
const server = vi.hoisted(() => ({
  version: 1,
  values: {} as Record<string, unknown>,
  patches: [] as Array<Record<string, unknown> & { version: number }>,
}))

vi.mock('@/services/featuresService', async importOriginal => {
  const actual = await importOriginal<typeof import('@/services/featuresService')>()
  const snapshot = () => ({
    schema: [],
    categories: [],
    values: { ...server.values },
    version: server.version,
  })
  return {
    ...actual,
    featuresService: {
      ...actual.featuresService,
      get: async () => snapshot(),
      update: async (patch: Record<string, unknown> & { version: number }) => {
        server.patches.push(patch)
        const { version, ...values } = patch
        // 409 — exactly what backend/app/api/v1/endpoints/features.py does on a version mismatch.
        if (version !== server.version) {
          throw new actual.FeaturesConcurrencyError('Feature flags were updated by someone else.')
        }
        server.version += 1
        server.values = values
        return snapshot()
      },
    },
  }
})

beforeEach(() => {
  server.version = 1
  server.values = { signupEnabled: false, traceEnabled: true }
  server.patches.length = 0
  useNotificationStore.setState({ notifications: [], history: [], _nextId: 1 })
})

const loaded = async () => {
  const { result } = renderHook(() => useAdminFeatures())
  await waitFor(() => expect(result.current.isLoading).toBe(false))
  return result
}

describe('an Undo captured before the save still saves', () => {
  it('PATCHes the version the save produced, not the one the render held', async () => {
    const result = await loaded()
    // The closure the notification keeps: made BEFORE the save, used after it.
    const undo = result.current.handleChange

    await act(async () => {
      await result.current.handleChange('signupEnabled', true)
    })
    expect(server.version).toBe(2)

    let landed: boolean | undefined
    await act(async () => {
      landed = await undo('signupEnabled', false)
    })

    expect(landed).toBe(true)
    expect(server.patches.at(-1)).toMatchObject({ version: 2, signupEnabled: false })
    expect(server.values.signupEnabled).toBe(false)
    // Not "Someone else saved. Reloaded." — nobody else saved.
    expect(useNotificationStore.getState().notifications.map(n => n.type)).not.toContain('error')
  })

  it('puts back its own switch only, not the whole page as it was', async () => {
    const result = await loaded()
    const undoSignup = result.current.handleChange

    await act(async () => {
      await result.current.handleChange('signupEnabled', true)
    })
    await act(async () => {
      await result.current.handleChange('traceEnabled', false)
    })
    // A PATCH carries the whole values map, so a closure holding the old one would
    // quietly turn Lineage trace back on while undoing Self-registration.
    await act(async () => {
      await undoSignup('signupEnabled', false)
    })

    expect(server.values).toMatchObject({ signupEnabled: false, traceEnabled: false })
  })
})
