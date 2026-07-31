/**
 * View health must come from the server, not from the caller's stores.
 *
 * The reported bug: a Public view showed "Source deleted" to a second account
 * while its owner saw it as healthy. This hook used to decide that itself, by
 * looking the view's workspace up in `useWorkspacesStore` — which holds only
 * the workspaces the caller is bound to. `enterprise` and `public` views exist
 * for people with no such binding, so the lookup always missed for exactly
 * their intended audience, and a miss was reported as a deletion.
 *
 * The property that makes that impossible is simple enough to assert directly:
 * the hook must not consult any store, so its output depends only on the DTO.
 */
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useViewHealth } from '../useViewHealth'
import type { View } from '@/services/viewApiService'

function view(overrides: Partial<View> = {}): View {
  return {
    id: 'view_public',
    name: 'Impact Analysis',
    workspaceId: 'ws_not_in_my_store',
    viewType: 'context',
    config: {},
    visibility: 'public',
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-30T00:00:00Z',
    ...overrides,
  } as View
}

describe('useViewHealth', () => {
  it('reports a healthy cross-workspace view as healthy', () => {
    // The workspace is deliberately one no store knows about — that is the
    // whole point. Before the fix this returned `broken`.
    const { result } = renderHook(() =>
      useViewHealth([view({ healthStatus: 'healthy' })]),
    )
    expect(result.current.get('view_public')).toEqual({
      status: 'healthy',
      reason: undefined,
    })
  })

  it('passes through the server\'s reason verbatim', () => {
    const { result } = renderHook(() =>
      useViewHealth([
        view({
          healthStatus: 'broken',
          healthReason: "This view's data source has been deleted",
        }),
      ]),
    )
    expect(result.current.get('view_public')).toEqual({
      status: 'broken',
      reason: "This view's data source has been deleted",
    })
  })

  it('defaults to healthy when the server sent no verdict', () => {
    // A view from a cache written before the field existed must not be
    // rendered as broken — silence is not a deletion.
    const { result } = renderHook(() => useViewHealth([view()]))
    expect(result.current.get('view_public')?.status).toBe('healthy')
  })

  it('distinguishes warning and stale from broken', () => {
    const { result } = renderHook(() =>
      useViewHealth([
        view({ id: 'a', healthStatus: 'warning' }),
        view({ id: 'b', healthStatus: 'stale' }),
        view({ id: 'c', healthStatus: 'broken' }),
      ]),
    )
    expect(result.current.get('a')?.status).toBe('warning')
    expect(result.current.get('b')?.status).toBe('stale')
    expect(result.current.get('c')?.status).toBe('broken')
  })
})
