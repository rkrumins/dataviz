/**
 * useActiveDraftAccess: the freshness poll's word first, then the version list's, then the owner
 * and role; unknown, the caller may (the server still refuses).
 */
import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

let listed: unknown[] | undefined
let polled: { access?: unknown } | undefined

vi.mock('@/store/auth', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'ana' } }),
}))
vi.mock('../useVersioning', () => ({
  useBranches: () => ({ data: listed }),
  useBranchFreshness: () => ({ data: polled }),
}))

import { useActiveDraftAccess } from '../useActiveDraftAccess'

const access = (canWrite: boolean, canManage: boolean) => ({ canRead: true, canWrite, canManage })
const run = () => renderHook(() => useActiveDraftAccess('ws1', 'g1', 'v1', 'br_1')).result.current

describe('useActiveDraftAccess', () => {
  beforeEach(() => { listed = undefined; polled = undefined })

  it('takes the freshness poll’s word over the list’s', () => {
    listed = [{ branchId: 'br_1', owner: 'bob', access: access(true, false) }]
    polled = { access: access(false, false) }                 // made private since the list loaded
    expect(run()).toMatchObject({ canWrite: false, canManage: false })
  })

  it('takes the list’s word when the poll hasn’t said', () => {
    listed = [{ branchId: 'br_1', owner: 'bob', visibility: 'public', access: access(true, false) }]
    expect(run()).toMatchObject({ canWrite: true, canManage: false })
  })

  it('lets the caller edit while nothing is known', () => {
    expect(run()).toMatchObject({ draft: null, canWrite: true, canManage: true })
  })
})
