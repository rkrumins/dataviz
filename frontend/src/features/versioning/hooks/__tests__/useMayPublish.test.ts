/**
 * Whether the reader may advance a graph's main: the server's word on main's access — the publish
 * permission, or in the Playground having made the graph — else the publish permission itself.
 */
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useMayPublish } from '../useMayPublish'

let holdsPublish = false
let branches: Array<Record<string, unknown>> | undefined
const useBranches = vi.fn((_ws?: string, _gid?: string | null) => ({ data: branches }))

vi.mock('@/store/auth', () => ({
  usePermission: (p: string) => p === 'workspace:datasource:publish' && holdsPublish,
}))
vi.mock('../useVersioning', () => ({
  useBranches: (ws?: string, gid?: string | null) => useBranches(ws, gid),
}))

const main = (access?: Record<string, boolean>) => ({ branchId: 'b_main', kind: 'main', access })

beforeEach(() => {
  holdsPublish = false
  branches = undefined
  useBranches.mockClear()
})

describe('useMayPublish', () => {
  it("takes the server's word on main: a Playground maker without publish may", () => {
    branches = [main({ canRead: true, canWrite: false, canManage: false, canPublish: true })]
    expect(renderHook(() => useMayPublish('ws1', 'g1')).result.current).toBe(true)
    expect(useBranches).toHaveBeenCalledWith('ws1', 'g1')
  })

  it('takes a no from the server even with the permission', () => {
    holdsPublish = true
    branches = [main({ canRead: true, canWrite: false, canManage: false, canPublish: false })]
    expect(renderHook(() => useMayPublish('ws1', 'g1')).result.current).toBe(false)
  })

  it('falls back to the publish permission while the branches load, or from an older server', () => {
    holdsPublish = true
    expect(renderHook(() => useMayPublish('ws1', 'g1')).result.current).toBe(true)
    branches = [main({ canRead: true, canWrite: false, canManage: false })]
    expect(renderHook(() => useMayPublish('ws1', 'g1')).result.current).toBe(true)
    holdsPublish = false
    expect(renderHook(() => useMayPublish('ws1', 'g1')).result.current).toBe(false)
  })
})
