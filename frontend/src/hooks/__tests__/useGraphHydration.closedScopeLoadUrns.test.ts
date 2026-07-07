/**
 * `closedScopeLoadUrns` — the pure load-set computation for a CLOSED-SCOPE
 * Context Model view (one with persisted `entityAssignments`).
 *
 * Bug: a closed-scope view loads ONLY the URNs in persisted `entityAssignments`
 * (see `useGraphHydration.ts`'s `assignedUrns`/`hasExplicitAssignments` block).
 * An entity CREATED in this branch's draft has no persisted assignment yet, so
 * it is never fetched — never rendered. Fix: in a DRAFT, union the
 * branch-created delta (`useBranchCreatedDelta`) into the load set.
 *
 * Pinned here:
 *  - empty delta → assigned-only (the mandatory regression: a view with NO
 *    created entities loads EXACTLY as today), regardless of isDraft.
 *  - draft + non-empty delta → assigned ∪ delta.
 *  - non-draft (main/published) + non-empty delta → assigned-only (delta is
 *    ignored outside a draft — explicit guard, even though in practice the
 *    delta is empty on main anyway).
 *  - de-duplicates URNs present in both sets.
 */
import { describe, it, expect, vi } from 'vitest'

// Importing the module executes its top-level imports, which transitively
// reach `@/store/schema` → `@/store/workspaces` → `workspaceSwitchCleanup`
// → `@/main` (a real app entrypoint with a module-load-time
// `ReactDOM.createRoot(...)` side effect). Mocked the same way as the
// sibling `useGraphHydration.empty.test.ts` so a pure-function test doesn't
// need a DOM `#root` element.
vi.mock('@/providers/GraphProviderContext', () => ({
  useGraphProvider: () => ({}),
  useGraphProviderContext: () => ({ providerVersion: 1 }),
}))
vi.mock('@/hooks/useViewSchema', () => ({
  useViewContainmentEdgeTypes: () => [],
  useViewLineageEdgeTypes: () => [],
  useViewRootEntityTypes: () => [],
  useViewEntityTypes: () => [],
  useViewSchemaIsReady: () => true,
}))
vi.mock('@/store/schema', () => ({
  useActiveView: () => undefined,
  isContainmentEdgeType: () => false,
  normalizeEdgeType: (t: string) => t,
}))

import { closedScopeLoadUrns } from '../useGraphHydration'

describe('closedScopeLoadUrns', () => {
  it('empty delta → assigned-only, draft or not', () => {
    const assigned = new Set(['a', 'b'])
    expect(closedScopeLoadUrns(assigned, new Set(), true).sort()).toEqual(['a', 'b'])
    expect(closedScopeLoadUrns(assigned, new Set(), false).sort()).toEqual(['a', 'b'])
  })

  it('draft + non-empty delta → union of assigned and delta', () => {
    const assigned = new Set(['a', 'b'])
    const delta = new Set(['c', 'd'])
    expect(closedScopeLoadUrns(assigned, delta, true).sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('non-draft + non-empty delta → assigned-only (delta ignored outside a draft)', () => {
    const assigned = new Set(['a', 'b'])
    const delta = new Set(['c', 'd'])
    expect(closedScopeLoadUrns(assigned, delta, false).sort()).toEqual(['a', 'b'])
  })

  it('de-duplicates a URN present in both assigned and delta', () => {
    const assigned = new Set(['a', 'b'])
    const delta = new Set(['b', 'c'])
    expect(closedScopeLoadUrns(assigned, delta, true).sort()).toEqual(['a', 'b', 'c'])
  })
})
