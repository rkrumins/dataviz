import { describe, it, expect, beforeEach } from 'vitest'

import { useVersioningPanelStore } from '../versioningPanelStore'

beforeEach(() => {
  useVersioningPanelStore.setState({ requestedTab: null })
})

describe('versioningPanelStore — one-shot panel-open bridge', () => {
  it('openPanel records the requested tab', () => {
    useVersioningPanelStore.getState().openPanel('changes')
    expect(useVersioningPanelStore.getState().requestedTab).toBe('changes')
  })

  it('clearRequest resets the pending request to null', () => {
    useVersioningPanelStore.getState().openPanel('changes')
    useVersioningPanelStore.getState().clearRequest()
    expect(useVersioningPanelStore.getState().requestedTab).toBeNull()
  })
})
