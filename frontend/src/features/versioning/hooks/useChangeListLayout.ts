/**
 * How the reader lays change lists out — top-down under their containers, or one list — remembered
 * once chosen; until then, the persona's default: Business top-down, Technical the list.
 */
import { usePersonaMode } from '@/store/persona'
import { usePreferencesStore, type ChangeListLayout } from '@/store/preferences'

export function useChangeListLayout(): [ChangeListLayout, (layout: ChangeListLayout) => void] {
  const persona = usePersonaMode()
  const chosen = usePreferencesStore((s) => s.changeListLayout)
  const set = usePreferencesStore((s) => s.setChangeListLayout)
  return [chosen ?? (persona === 'business' ? 'tree' : 'list'), set]
}
