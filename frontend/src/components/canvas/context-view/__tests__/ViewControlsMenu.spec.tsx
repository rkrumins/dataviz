/**
 * ViewControlsMenu — verifies the consolidated display menu surfaces the new
 * Audience + Appearance controls and that they drive the underlying stores.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'

import { ViewControlsMenu } from '../ViewControlsMenu'
import { usePersonaStore } from '@/store/persona'
import { usePreferencesStore } from '@/store/preferences'

function props() {
  return {
    showLineageFlow: false,
    lineageRenderMode: 'auto' as const,
    onSetLineageRenderMode: vi.fn(),
    showEdgeDirection: false,
    onToggleEdgeDirection: vi.fn(),
    canvasZoom: 1,
    onSetCanvasZoom: vi.fn(),
    canvasDensity: 'spacious' as const,
    onSetCanvasDensity: vi.fn(),
    showCanvasTypeBadge: true,
    onToggleCanvasTypeBadge: vi.fn(),
    subtleCanvasTreeLines: false,
    onToggleSubtleCanvasTreeLines: vi.fn(),
    onResetCanvasDisplaySettings: vi.fn(),
  }
}

beforeEach(() => {
  // Deterministic starting state + suppress the first-run coachmark.
  usePersonaStore.setState({ mode: 'business' })
  usePreferencesStore.setState({ theme: 'system', reduceMotion: false })
  try { localStorage.setItem('synodic.viewMenu.seen.v1', '1') } catch { /* noop */ }
})

function openMenu() {
  render(<ViewControlsMenu {...props()} />)
  fireEvent.click(screen.getByRole('button', { name: /View/ }))
}

describe('ViewControlsMenu', () => {
  it('surfaces Audience + Appearance controls when opened', () => {
    openMenu()
    expect(screen.getByText('Audience')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Business' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Technical' })).toBeInTheDocument()
    expect(screen.getByText('Appearance')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'System' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: /Reduce motion/ })).toBeInTheDocument()
  })

  it('switches audience persona', () => {
    openMenu()
    fireEvent.click(screen.getByRole('radio', { name: 'Technical' }))
    expect(usePersonaStore.getState().mode).toBe('technical')
  })

  it('switches theme and toggles reduce motion', () => {
    openMenu()
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(usePreferencesStore.getState().theme).toBe('dark')
    fireEvent.click(screen.getByRole('switch', { name: /Reduce motion/ }))
    expect(usePreferencesStore.getState().reduceMotion).toBe(true)
  })
})
