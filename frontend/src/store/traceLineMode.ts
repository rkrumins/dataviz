/**
 * traceLineMode — how many of a trace's lines the Context View draws.
 *
 * Each view has its own answer until the reader chooses one. The Business
 * view starts on On hover: the trace's cards are laid out, and a card's lines
 * draw when it is pointed at or picked, so a table with hundreds of partners
 * does not bury the canvas in lines. The Technical view starts on every line,
 * the trace as it has always drawn. Trace settings → Lines changes it, for
 * both views, and the trace bar's "Show every line" does too.
 *
 * A trace's own choice, apart from Display's: that one is shared by browsing
 * and starts on On hover, so a trace that followed it would change every
 * Technical trace.
 */
import { usePersonaStore, type PersonaMode } from './persona'
import { usePreferencesStore, type LineageRenderMode } from './preferences'

const defaultFor = (mode: PersonaMode): LineageRenderMode => (mode === 'business' ? 'stubs' : 'raw')

export function useTraceLineMode(): LineageRenderMode {
  const mode = usePersonaStore((s) => s.mode)
  return usePreferencesStore((s) => s.traceLineMode) ?? defaultFor(mode)
}
