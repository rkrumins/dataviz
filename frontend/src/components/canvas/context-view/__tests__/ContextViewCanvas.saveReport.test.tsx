/**
 * Review & Save may only claim what it actually wrote.
 *
 * `stagedChangesToOps` drops a node update whose mapped payload is empty, and
 * `saveStagedChangesToDraft` returns `{commitId: null}` without calling the backend when the batch
 * has no ops — so an edit made of fields the mapper cannot carry resolved exactly like a real
 * commit, and this handler put a green "Saved to draft." over a save that never left the browser.
 * A description edit was precisely that case.
 *
 * Driven on the REAL canvas: the review panel's own Save button, the app's one notification store,
 * and the requests that actually left. The mapping is pinned separately (stagedChangesToOps /
 * saveStagedChangesToDraft tests); what only the canvas can prove is which sentence the user reads.
 */
import { describe, it, expect } from 'vitest'
import { act, fireEvent, screen } from '@testing-library/react'
import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { useAuthStore } from '@/store/auth'
import { useBranchStore } from '@/store/branchStore'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'
import { useNotificationStore } from '@/components/ui/notifications'

/** Every message the app raised during the save, as "<type>: <text>". */
const messages = () => useNotificationStore.getState().notifications.map(n => `${n.type}: ${n.message}`)

/** The URLs the app asked for after the canvas settled — a save that sent nothing is the defect. */
const requests: string[] = []

async function openDraftCanvas() {
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
  useNotificationStore.setState({ notifications: [], history: [] } as never)
  useStagedChangesStore.setState({ changes: [], redoStack: [], isReviewPanelOpen: false } as never)
  const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', draft: true })
  // The draft save path needs a graph AND a data source as well as a branch; the harness leaves
  // both null, which routes the confirm handler down the legacy main-mode branch instead.
  useBranchStore.setState({ dataSourceId: 'harness-ds', graphId: 'harness-graph' } as never)
  requests.length = 0
  const inner = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    return inner(input, init)
  }) as typeof globalThis.fetch
  return h
}

/** Stage one node edit, open the review panel, and press its Save button. */
async function saveOne(h: { settle: () => Promise<void> }, before: unknown, after: unknown) {
  act(() => {
    useStagedChangesStore.getState().stage({
      type: 'update_entity', targetId: 'orders', targetUrn: 'orders',
      before, after, summary: 'Edit orders',
    } as Omit<StagedChange, 'id' | 'timestamp'>)
    useStagedChangesStore.getState().openReviewPanel()
  })
  await h.settle()
  const save = await screen.findByRole('button', { name: /save 1 change/i })
  await act(async () => { fireEvent.click(save) })
  await h.settle()
}

describe('what Review & Save tells the user it saved', () => {
  it('reports that nothing was saved when the edit is made only of fields it cannot carry', async () => {
    const h = await openDraftCanvas()
    await saveOne(h, { retentionDays: 30 }, { retentionDays: 90 })
    expect(requests.some(u => u.includes('/graph/changes'))).toBe(false)
    expect(messages()).not.toContain('success: Saved to draft.')
    expect(messages().join('\n')).toMatch(/retentionDays/)
  }, 30000)

  it('names the field it left behind even when the rest of the edit did commit', async () => {
    const h = await openDraftCanvas()
    await saveOne(h, { description: '', owner: 'ana' }, { description: 'the order book', owner: 'bo' })
    expect(requests.some(u => u.includes('/graph/changes'))).toBe(true)
    expect(messages().join('\n')).toMatch(/owner/)
    expect(messages()).not.toContain('success: Saved to draft.')
  }, 30000)

  it('sends a description edit and says "Saved to draft." — the case that used to send nothing', async () => {
    const h = await openDraftCanvas()
    await saveOne(h, { description: '' }, { description: 'the order book' })
    expect(requests.some(u => u.includes('/graph/changes'))).toBe(true)
    expect(messages()).toContain('success: Saved to draft.')
  }, 30000)
})
