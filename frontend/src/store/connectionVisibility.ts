/**
 * Per-user, per-view visibility of connection types on the Context View
 * canvas (Connections panel, Phase 1). Scoped PER VIEW in localStorage,
 * keyed by view id — never written into the view definition itself. ONE
 * localStorage key, many views — same one-key-many-views shape as
 * `synodic.advancedSearch.canvasFilterMode.v1` (store/searchStore.ts).
 *
 * `hiddenTypes` is a `useMemo`-built Set keyed on the stored array, so its
 * identity is stable across renders while the stored list is unchanged —
 * it feeds a `useEdgeProjection` memo dependency, and an unstable Set
 * would re-run the whole projection every render.
 */
import { useCallback, useMemo } from 'react'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export const CONNECTION_VISIBILITY_STORAGE_KEY = 'synodic.connections.hiddenTypes.v1'

interface ConnectionVisibilityState {
  /** viewId → hidden type keys (UPPERCASE). */
  hiddenByView: Record<string, string[]>
  setHidden: (viewId: string, types: readonly string[]) => void
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

/**
 * Soft validation on rehydrate: any entry whose value is not an array of
 * strings is dropped. A corrupted key loads as "nothing hidden"; it never
 * throws on the canvas render path.
 */
function sanitizeHiddenByView(raw: unknown): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  if (raw && typeof raw === 'object') {
    for (const [viewId, value] of Object.entries(raw as Record<string, unknown>)) {
      if (isStringArray(value)) {
        result[viewId] = value.map((t) => t.toUpperCase())
      }
    }
  }
  return result
}

export const useConnectionVisibilityStore = create<ConnectionVisibilityState>()(
  persist(
    (set) => ({
      hiddenByView: {},
      setHidden: (viewId, types) =>
        set((state) => {
          if (!viewId) return state
          // Never store an empty list — delete the bucket instead, so the
          // key does not accumulate empty buckets (showAll and a toggle
          // back to nothing both land here).
          if (types.length === 0) {
            if (!(viewId in state.hiddenByView)) return state
            const next = { ...state.hiddenByView }
            delete next[viewId]
            return { hiddenByView: next }
          }
          return {
            hiddenByView: {
              ...state.hiddenByView,
              [viewId]: Array.from(new Set(types.map((t) => t.toUpperCase()))),
            },
          }
        }),
    }),
    {
      name: CONNECTION_VISIBILITY_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ hiddenByView: state.hiddenByView }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        hiddenByView: sanitizeHiddenByView(
          (persistedState as Partial<ConnectionVisibilityState> | null | undefined)?.hiddenByView
        ),
      }),
    }
  )
)

export interface ConnectionVisibility {
  hiddenTypes: ReadonlySet<string>
  isHidden: (type: string) => boolean
  toggle: (type: string) => void
  solo: (type: string, allTypes: readonly string[]) => void
  showAll: () => void
}

const EMPTY_HIDDEN: readonly string[] = []

export function useConnectionVisibility(viewId: string): ConnectionVisibility {
  const hiddenList = useConnectionVisibilityStore((s) => (viewId ? s.hiddenByView[viewId] : undefined))
  const setHidden = useConnectionVisibilityStore((s) => s.setHidden)

  const hiddenTypes = useMemo(() => new Set(hiddenList ?? EMPTY_HIDDEN), [hiddenList])

  const isHidden = useCallback((type: string) => hiddenTypes.has(type.toUpperCase()), [hiddenTypes])

  const toggle = useCallback(
    (type: string) => {
      if (!viewId) return
      const upperType = type.toUpperCase()
      const current = useConnectionVisibilityStore.getState().hiddenByView[viewId] ?? EMPTY_HIDDEN
      const next = current.includes(upperType)
        ? current.filter((t) => t !== upperType)
        : [...current, upperType]
      setHidden(viewId, next)
    },
    [viewId, setHidden]
  )

  // Deviation from the brief's `solo(type)`: a view-scoped store cannot
  // know the model's type list, so the caller supplies it. Filtering the
  // soloed type back out leaves "nothing" for a single-type list, which
  // setHidden already turns into a bucket delete — same effect as showAll.
  const solo = useCallback(
    (type: string, allTypes: readonly string[]) => {
      if (!viewId) return
      const upperType = type.toUpperCase()
      const rest = Array.from(new Set(allTypes.map((t) => t.toUpperCase()))).filter((t) => t !== upperType)
      setHidden(viewId, rest)
    },
    [viewId, setHidden]
  )

  const showAll = useCallback(() => {
    if (!viewId) return
    setHidden(viewId, [])
  }, [viewId, setHidden])

  return { hiddenTypes, isHidden, toggle, solo, showAll }
}
