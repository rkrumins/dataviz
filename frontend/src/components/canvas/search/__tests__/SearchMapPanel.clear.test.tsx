/**
 * The panel's Clear (×), when the panel is reporting on a canvas's search
 * session.
 *
 * Its own three resets — abort, rewind the view, wipe the draft — clear
 * everything the panel can see and nothing the header box holds. On a
 * canvas that owns a session, that leaves the query text sitting in the
 * box with no results, no highlights and no way back: the debounce lane
 * only dispatches when the debounced query CHANGES, so unchanged text
 * never asks again. Clear has to be the session's own teardown.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ProviderOverride } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useSearchStore } from '@/store/searchStore'
import type { PanelView } from '@/hooks/useAdvancedSearch'
import { stubAdvanced } from '@/test/stubSearchSession'

import { SearchMapPanel } from '../SearchMapPanel'

/** A finished run, so the results section — and with it the Clear
 *  button — is on screen. */
const RESULTS = {
  kind: 'results',
  template: {}, inputs: {}, query: {},
  result: {
    candidateCount: 1, truncated: false, deadlineExceeded: false,
    cacheHit: false, elapsedMs: 4,
    hits: [{
      node: { urn: 'a', displayName: 'orders', entityType: 'table', properties: {} },
      ancestorPath: [],
    }],
  },
  elapsedMs: 4,
} as unknown as PanelView

function renderPanel(onClear?: () => void) {
  // `instanceof RemoteGraphProvider` gates the panel's own calls, so the
  // stub carries the real prototype.
  const provider = Object.create(RemoteGraphProvider.prototype) as RemoteGraphProvider
  return render(
    <ProviderOverride value={{
      provider, isLoading: false, error: null, scopeKind: 'ready',
      workspaceId: 'ws', dataSourceId: null,
      providerReady: true, providerVersion: 1,
    } as never}>
      <SearchMapPanel
        open
        onClose={vi.fn()}
        viewId="view-1"
        session={stubAdvanced({ view: RESULTS })}
        onClear={onClear}
      />
    </ProviderOverride>,
  )
}

describe('SearchMapPanel — Clear', () => {
  it('hands Clear to the canvas when the canvas owns the search', () => {
    const onClear = vi.fn()
    renderPanel(onClear)

    fireEvent.click(screen.getByRole('button', { name: 'Clear results' }))

    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('still clears itself on the canvases that own no session', () => {
    useSearchStore.getState().commitDraft({
      kind: 'text', target: 'any', match: 'substring', value: 'orders',
    })
    renderPanel(undefined)

    fireEvent.click(screen.getByRole('button', { name: 'Clear results' }))

    expect(useSearchStore.getState().draftPredicate).toBeNull()
  })
})
