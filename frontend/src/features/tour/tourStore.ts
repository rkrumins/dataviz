import { create } from 'zustand'
import { getTour } from './tours'

const COMPLETED_KEY = 'nx-tours-completed'

function loadCompleted(): string[] {
  try {
    const raw = localStorage.getItem(COMPLETED_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

function saveCompleted(ids: string[]) {
  try {
    localStorage.setItem(COMPLETED_KEY, JSON.stringify(ids))
  } catch {
    /* private mode — completion just won't persist */
  }
}

interface TourState {
  activeTourId: string | null
  stepIndex: number
  /** Tour ids the user has finished — persisted, so we don't re-offer them. */
  completed: string[]

  start: (tourId: string) => void
  next: () => void
  prev: () => void
  goTo: (index: number) => void
  /** Stop without marking complete (user skipped). */
  stop: () => void
  /** Stop and record completion. */
  finish: () => void
  hasCompleted: (tourId: string) => boolean
}

export const useTourStore = create<TourState>()((set, get) => ({
  activeTourId: null,
  stepIndex: 0,
  completed: loadCompleted(),

  start: (tourId) => {
    if (getTour(tourId)) set({ activeTourId: tourId, stepIndex: 0 })
  },

  next: () => {
    const { activeTourId, stepIndex } = get()
    const tour = activeTourId ? getTour(activeTourId) : undefined
    if (!tour) return
    if (stepIndex >= tour.steps.length - 1) {
      get().finish()
    } else {
      set({ stepIndex: stepIndex + 1 })
    }
  },

  prev: () => set((s) => ({ stepIndex: Math.max(0, s.stepIndex - 1) })),

  goTo: (index) => {
    const { activeTourId } = get()
    const tour = activeTourId ? getTour(activeTourId) : undefined
    if (!tour) return
    set({ stepIndex: Math.max(0, Math.min(index, tour.steps.length - 1)) })
  },

  stop: () => set({ activeTourId: null, stepIndex: 0 }),

  finish: () => {
    const { activeTourId, completed } = get()
    if (activeTourId && !completed.includes(activeTourId)) {
      const next = [...completed, activeTourId]
      saveCompleted(next)
      set({ completed: next })
    }
    set({ activeTourId: null, stepIndex: 0 })
  },

  hasCompleted: (tourId) => get().completed.includes(tourId),
}))
