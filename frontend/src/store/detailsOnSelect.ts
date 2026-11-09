/**
 * detailsOnSelect — whether selecting an entity opens its details.
 *
 * Each view has its own answer, because the two read the canvas differently.
 * The Technical view inspects as it clicks, so the details follow every click.
 * The Business view browses: a click picks an entity out, and its details open
 * when asked for — the Details button, Enter, or the context menu. Either can
 * be changed under Preferences → Entity details.
 *
 * Once the details are open they follow the selection in both views, the way
 * an inspector does; this decides only whether a click opens them.
 */
import { usePersonaStore, type PersonaMode } from './persona'
import { usePreferencesStore } from './preferences'

const defaultFor = (mode: PersonaMode) => mode === 'technical'

/** Read where no React is: the canvas store's selection actions. */
export function opensDetailsOnSelect(): boolean {
  const mode = usePersonaStore.getState().mode
  return usePreferencesStore.getState().openDetailsOnSelect?.[mode] ?? defaultFor(mode)
}

/** The same answer, kept current for what renders the on-demand ways in. */
export function useOpensDetailsOnSelect(): boolean {
  const mode = usePersonaStore((s) => s.mode)
  return usePreferencesStore((s) => s.openDetailsOnSelect?.[mode] ?? defaultFor(mode))
}
