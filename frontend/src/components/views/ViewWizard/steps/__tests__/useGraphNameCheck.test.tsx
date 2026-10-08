/**
 * useGraphNameCheck — the physical graph name, live-checked on its connection (extracted from
 * BasicsStep, whose behaviour it must keep). Pinned here:
 *   - nothing is checked, or derived into the fields, without a connection;
 *   - a derived name follows what it's derived from, and a taken one moves to the server's free
 *     alternative on its own (saying which it moved from);
 *   - a typed name is never moved: the alternative is offered, one click away; resetting goes back
 *     to the derived name;
 *   - a malformed name is refused without asking; a check that fails doesn't block.
 */
import { useState } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const checkMock = vi.fn()
vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/versioningApiService')>()),
  checkBlankGraphName: (...a: unknown[]) => checkMock(...a),
}))

import { useGraphNameCheck, type GraphNameFields } from '../useGraphNameCheck'

const SCOPE = { workspaceId: 'ws1', providerId: 'p1' }

function useChecked(derivedName: string, scope: typeof SCOPE | null = SCOPE, initial: GraphNameFields = {}) {
  const [fields, setFields] = useState<GraphNameFields>(initial)
  const check = useGraphNameCheck({
    scope, derivedName, fields, update: (patch) => setFields(prev => ({ ...prev, ...patch })),
  })
  return { ...check, fields }
}

beforeEach(() => vi.clearAllMocks())

describe('useGraphNameCheck', () => {
  it('checks nothing without a connection', async () => {
    const { result } = renderHook(() => useChecked('data_lineage', null))
    await new Promise(r => setTimeout(r, 450))
    expect(checkMock).not.toHaveBeenCalled()
    expect(result.current.effectiveName).toBe('data_lineage')
    expect(result.current.fields.graphName).toBeUndefined()
    expect(result.current.nameCheck.state).toBe('idle')
  })

  it('takes the derived name, and finds it free', async () => {
    checkMock.mockResolvedValue({ available: true, normalized: 'data_lineage' })
    const { result } = renderHook(() => useChecked('data_lineage'))
    await waitFor(() => expect(result.current.nameCheck.state).toBe('available'))
    expect(checkMock).toHaveBeenCalledWith('ws1', 'p1', 'data_lineage')
    expect(result.current.fields).toMatchObject({ graphName: 'data_lineage', graphNameAvailable: true })
  })

  it('moves a derived name that is taken to the free one, and says which it moved from', async () => {
    checkMock.mockImplementation(async (_ws: string, _p: string, name: string) => (name === 'data_lineage'
      ? { available: false, normalized: name, reason: 'Taken', suggestion: 'data_lineage_2' }
      : { available: true, normalized: name }))
    const { result } = renderHook(() => useChecked('data_lineage'))
    await waitFor(() => expect(result.current.nameCheck.state).toBe('available'))
    expect(result.current.fields).toMatchObject({ graphName: 'data_lineage_2', graphNameAvailable: true })
    expect(result.current.autoUniquifiedFrom).toBe('data_lineage')
  })

  it('never moves a typed name, offers the free one, and can go back to the derived one', async () => {
    checkMock.mockImplementation(async (_ws: string, _p: string, name: string) => (name === 'mine'
      ? { available: false, normalized: name, reason: 'This name is taken.', suggestion: 'mine_2' }
      : { available: true, normalized: name }))
    const { result } = renderHook(() => useChecked('data_lineage'))
    await waitFor(() => expect(result.current.nameCheck.state).toBe('available'))

    act(() => result.current.edit('MINE'))
    await waitFor(() => expect(result.current.nameCheck.state).toBe('unavailable'))
    expect(result.current.fields).toMatchObject({ graphName: 'mine', graphNameIsAuto: false, graphNameAvailable: false })
    expect(result.current.nameCheck).toMatchObject({ reason: 'This name is taken.', suggestion: 'mine_2' })

    act(() => result.current.acceptSuggestion())
    await waitFor(() => expect(result.current.nameCheck.state).toBe('available'))
    expect(result.current.fields).toMatchObject({ graphName: 'mine_2', graphNameIsAuto: false, graphNameAvailable: true })

    act(() => result.current.resetToDerived())
    await waitFor(() => expect(result.current.fields.graphName).toBe('data_lineage'))
    expect(result.current.isAutoName).toBe(true)
  })

  it('refuses a malformed name without asking the server', async () => {
    const { result } = renderHook(() => useChecked('data_lineage'))
    act(() => result.current.edit('x!'))
    await waitFor(() => expect(result.current.nameCheck.state).toBe('unavailable'))
    expect(result.current.fields.graphNameAvailable).toBe(false)
    expect(checkMock).not.toHaveBeenCalledWith('ws1', 'p1', 'x!')
  })

  it('doesn’t block when the check itself fails', async () => {
    checkMock.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useChecked('data_lineage'))
    await waitFor(() => expect(checkMock).toHaveBeenCalled())
    await waitFor(() => expect(result.current.nameCheck.state).toBe('idle'))
    expect(result.current.fields.graphNameAvailable).toBeUndefined()
  })
})
