/**
 * The hub renders role-aware tracks, and the product tour is a persistent,
 * always-replayable action (not a checklist step that vanishes once taken) —
 * including the "everything done" state the launcher relies on.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Boxes, Compass } from 'lucide-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { progress } = vi.hoisted(() => ({
  progress: { value: {} as Record<string, unknown> },
}))

vi.mock('@/hooks/useOnboardingProgress', () => ({
  GETTING_STARTED_TOUR: 'getting-started',
  useOnboardingProgress: () => progress.value,
}))

let toursOn = true
vi.mock('@/store/features', () => ({ useFeature: () => toursOn }))

import { GettingStarted } from '../GettingStarted'
import { useTourStore } from '@/features/tour/tourStore'

type TStep = { id: string; label: string; description: string; icon: typeof Compass; done: boolean; href: string }
type TTrack = { id: string; title: string; subtitle: string; accent: string; icon: typeof Boxes; steps: TStep[]; completedCount: number; total: number; allDone: boolean }

const step = (id: string, done: boolean): TStep => ({ id, label: id, description: 'd', icon: Compass, done, href: '/x' })
const track = (id: string, title: string, icon: typeof Boxes, steps: TStep[]): TTrack => ({
  id, title, subtitle: 's', accent: id === 'setup' ? 'setup' : 'explore', icon, steps,
  completedCount: steps.filter((s) => s.done).length, total: steps.length, allDone: steps.every((s) => s.done),
})

const setTracks = (tracks: TTrack[], allDone = false) => {
  const all = tracks.flatMap((t) => t.steps)
  progress.value = {
    tracks,
    completedCount: all.filter((s) => s.done).length,
    total: all.length,
    allDone,
    isLoading: false,
  }
}

const renderHub = () => render(<MemoryRouter><GettingStarted /></MemoryRouter>)

describe('GettingStarted — tracks + tour access', () => {
  beforeEach(() => {
    useTourStore.setState({ activeTourId: null, stepIndex: 0, completed: [] })
    toursOn = true
    setTracks([
      track('setup', 'Set up the platform', Boxes, [step('connect-provider', true), step('discover-assets', false)]),
      track('explore', 'Explore your data', Compass, [step('create-view', false)]),
    ])
  })

  it('renders each visible track', () => {
    renderHub()
    expect(screen.getByText('Set up the platform')).toBeInTheDocument()
    expect(screen.getByText('Explore your data')).toBeInTheDocument()
  })

  it('offers the tour and starts it on click', async () => {
    renderHub()
    expect(screen.getByText('Product tour')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /start/i }))
    expect(useTourStore.getState().activeTourId).toBe('getting-started')
  })

  it('labels the CTA "Replay" once the tour has been taken', () => {
    useTourStore.setState({ completed: ['getting-started'] })
    renderHub()
    expect(screen.getByRole('button', { name: /replay/i })).toBeInTheDocument()
  })

  it('still offers replay when everything is complete', () => {
    setTracks([track('explore', 'Explore your data', Compass, [step('create-view', true)])], true)
    useTourStore.setState({ completed: ['getting-started'] })
    renderHub()
    expect(screen.getByText("You're all set 🎉")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /replay/i })).toBeInTheDocument()
  })

  it('hides the tour entirely when the flag is off', () => {
    toursOn = false
    renderHub()
    expect(screen.queryByText('Product tour')).not.toBeInTheDocument()
  })
})
