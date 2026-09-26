import { describe, it, expect } from 'vitest'
import { summarizeProvenance, type HistoryVersion } from '../edgeProvenance'

const v = (branch_id: string, commit_seq: number, op: string, actor: string, created_at: string): HistoryVersion =>
  ({ branch_id, commit_seq, op, actor, created_at })

const names = { usr_ana: 'Ana', usr_bo: 'Bo' }

describe('summarizeProvenance', () => {
  it('reads a published relationship from the main line', () => {
    const p = summarizeProvenance([
      v('main', 2, 'create', 'usr_ana', '2026-01-01T00:00:00Z'),
      v('main', 5, 'update', 'usr_bo', '2026-02-01T00:00:00Z'),
    ], { mainBranchId: 'main', branchId: null, userNames: names })
    expect(p.created).toEqual({ at: '2026-01-01T00:00:00Z', by: 'Ana', inDraft: false })
    expect(p.updated).toEqual({ at: '2026-02-01T00:00:00Z', by: 'Bo', inDraft: false })
  })

  it('a relationship created in the open draft reads as created there', () => {
    const p = summarizeProvenance([
      v('d1', 1, 'create', 'usr_bo', '2026-03-01T00:00:00Z'),
    ], { mainBranchId: 'main', branchId: 'd1', userNames: names })
    expect(p.created).toEqual({ at: '2026-03-01T00:00:00Z', by: 'Bo', inDraft: true })
    expect(p.updated?.inDraft).toBe(true)
  })

  it('a draft edit is the latest change; creation stays on main', () => {
    const p = summarizeProvenance([
      v('main', 9, 'create', 'usr_ana', '2026-01-01T00:00:00Z'),
      v('d1', 1, 'update', 'usr_bo', '2026-03-01T00:00:00Z'),
    ], { mainBranchId: 'main', branchId: 'd1', userNames: names })
    expect(p.created).toMatchObject({ by: 'Ana', inDraft: false })
    expect(p.updated).toMatchObject({ by: 'Bo', inDraft: true })
  })

  it('orders within a branch — a draft seq of 1 never outranks main seq 9', () => {
    const p = summarizeProvenance([
      v('main', 9, 'update', 'usr_ana', '2026-04-01T00:00:00Z'),
      v('main', 1, 'create', 'usr_ana', '2026-01-01T00:00:00Z'),
    ], { mainBranchId: 'main', branchId: null, userNames: names })
    expect(p.updated?.at).toBe('2026-04-01T00:00:00Z')
  })

  it("ignores other people's drafts", () => {
    const p = summarizeProvenance([
      v('main', 1, 'create', 'usr_ana', '2026-01-01T00:00:00Z'),
      v('other', 3, 'update', 'usr_bo', '2026-05-01T00:00:00Z'),
    ], { mainBranchId: 'main', branchId: 'd1', userNames: names })
    expect(p.updated).toMatchObject({ by: 'Ana', inDraft: false })
  })

  it('names a platform write "system"', () => {
    const p = summarizeProvenance([v('main', 2, 'create', 'system', '2026-01-01T00:00:00Z')], { mainBranchId: 'main' })
    expect(p.created?.by).toBe('system')
  })

  it('says nothing when there is no history', () => {
    expect(summarizeProvenance([], { mainBranchId: 'main' })).toEqual({ created: undefined, updated: undefined })
  })
})
