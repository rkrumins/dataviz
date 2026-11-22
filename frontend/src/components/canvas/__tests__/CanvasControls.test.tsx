/**
 * The Graph's Canvas Controls (shown in the Technical view) carry the Entity IDs switch, so a
 * Graph reader hides or shows the ID under each card's name in place — the same preference as
 * Display settings' "Show entity IDs" on Context View.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, describe, expect, it } from 'vitest'

import { CanvasControls } from '../CanvasControls'
import { usePreferencesStore } from '@/store/preferences'

afterEach(() => usePreferencesStore.setState({ showCanvasEntityIds: true }))

describe('CanvasControls — Entity IDs', () => {
  it('is on by default, and turning it off hides the IDs; on again shows them', () => {
    render(<ReactFlowProvider><CanvasControls /></ReactFlowProvider>)
    const ids = screen.getByRole('button', { name: /Entity IDs/ })
    expect(ids).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(ids)
    expect(usePreferencesStore.getState().showCanvasEntityIds).toBe(false)
    expect(ids).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(ids)
    expect(usePreferencesStore.getState().showCanvasEntityIds).toBe(true)
  })
})
