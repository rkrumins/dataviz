/**
 * A chip names a workspace or data source the reader can read views in without
 * being a member of it — from the facets — instead of printing its raw id.
 */
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useWorkspacesStore } from '@/store/workspaces'
import { useFilterLookups } from '../useFilterLookups'

describe('useFilterLookups', () => {
  it('names a non-member workspace and its source from the facets', () => {
    useWorkspacesStore.setState({ workspaces: [{ id: 'ws_mine', name: 'Mine', dataSources: [] }] as never })
    const facets = {
      workspaces: [{ id: 'ws_other', name: 'Finance', count: 3 }],
      dataSources: [{ id: 'ds_other', name: 'Ledger', count: 3 }],
    }
    const { result } = renderHook(() => useFilterLookups([], '2026-11-20', 'u1', facets))
    expect(result.current.workspaceName('ws_other')).toBe('Finance')
    expect(result.current.dataSourceName('ds_other')).toBe('Ledger')
    expect(result.current.workspaceName('ws_mine')).toBe('Mine')
  })
})
