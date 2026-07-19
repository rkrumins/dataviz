/**
 * The product tour is a persistent, always-replayable action in the hub — not a
 * one-off checklist step that vanishes once taken. These cover the replay path
 * the launcher relies on, including the "everything done" state.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { progress } = vi.hoisted(() => ({
  progress: {
    value: {
      steps: [
        { id: 'connect-provider', label: 'Connect a provider', description: 'x', done: true, href: '/ingestion' },
        { id: 'create-view', label: 'Create a view', description: 'x', done: false, href: '/workspaces' },
      ],
      completedCount: 1,
      total: 2,
      allDone: false,
      isLoading: false,
    },
  },
}))

vi.mock('@/hooks/useOnboardingProgress', () => ({
  GETTING_STARTED_TOUR: 'getting-started',
  useOnboardingProgress: () => progress.value,
}))

let toursOn = true
vi.mock('@/store/features', () => ({ useFeature: () => toursOn }))

import { GettingStarted } from '../GettingStarted'
import { useTourStore } from '@/features/tour/tourStore'

const renderHub = () => render(<MemoryRouter><GettingStarted /></MemoryRouter>)

describe('GettingStarted — product tour access', () => {
  beforeEach(() => {
    useTourStore.setState({ activeTourId: null, stepIndex: 0, completed: [] })
    toursOn = true
    progress.value = { ...progress.value, allDone: false, completedCount: 1 }
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

  it('still offers replay when every onboarding step is complete', () => {
    progress.value = { ...progress.value, allDone: true, completedCount: 2 }
    useTourStore.setState({ completed: ['getting-started'] })
    renderHub()
    expect(screen.getByText('All set 🎉')).toBeInTheDocument()
    // The fix: the tour does not disappear with the checklist.
    expect(screen.getByRole('button', { name: /replay/i })).toBeInTheDocument()
  })

  it('hides the tour entirely when the flag is off', () => {
    toursOn = false
    renderHub()
    expect(screen.queryByText('Product tour')).not.toBeInTheDocument()
  })
})
