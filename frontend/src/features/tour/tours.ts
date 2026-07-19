import { Sparkles } from 'lucide-react'
import type { TourDefinition } from './types'

/**
 * Product tours. Each step spotlights a real element by CSS selector — we anchor
 * on `data-tour="…"` attributes so refactors don't silently break a tour. Steps
 * with no target render as a centered card (intro / outro).
 */
export const TOURS: TourDefinition[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    description: 'A two-minute lap around the workspace — search, navigation, personas, and help.',
    icon: Sparkles,
    estimate: '2 min',
    steps: [
      {
        title: 'Welcome aboard 👋',
        body: "Here's a quick lap around the workspace. It takes about two minutes — you can leave any time with **Esc**.",
      },
      {
        target: '[data-tour="search"]',
        placement: 'bottom',
        title: 'Find anything, fast',
        body: 'Jump to any workspace, view, or data source from here — or press **⌘K** from anywhere.',
      },
      {
        target: '[data-tour="nav"]',
        placement: 'right',
        title: 'Get around',
        body: 'Your workspaces, data sources, and views live in the sidebar. This is home base.',
      },
      {
        target: '[data-tour="persona"]',
        placement: 'bottom',
        title: 'Business or technical?',
        body: 'Flip between a **business** and a **technical** lens — the same graph, described in the language that suits you.',
      },
      {
        target: '[data-tour="help"]',
        placement: 'bottom',
        title: 'Help is always here',
        body: 'Open the Help panel to search the docs and read guides without leaving your work. Press **?** any time.',
      },
      {
        title: "You're all set",
        body: 'That’s the tour. Open the **Help** panel whenever you want to take it again or dive into the guides.',
      },
    ],
  },
]

export function getTour(id: string): TourDefinition | undefined {
  return TOURS.find((t) => t.id === id)
}

/** The tour offered to first-time users (once the feature is enabled). */
export const FIRST_RUN_TOUR = 'getting-started'
