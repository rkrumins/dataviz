/**
 * traceLineMode — how many of a trace's lines the Context View draws.
 *
 * Each view keeps its own answer. The Business view starts on On hover: the
 * trace's cards are laid out, and a card's lines draw when it is pointed at or
 * picked, so a table with hundreds of partners does not bury the canvas in
 * lines. The Technical view starts on every line, the trace as it has always
 * drawn. Trace settings → Lines, Display's While tracing and the trace bar's
 * "Show every line" change the view you're in; Preferences → Trace lines
 * shows both, and puts them back.
 *
 * A trace's own choice, apart from Display's: that one is shared by browsing
 * and starts on On hover, so a trace that followed it would change every
 * Technical trace. Its budgets are its own too: Lines kept and Lines per card.
 */
import { usePersonaStore } from './persona'
import { DEFAULT_TRACE_LINE_MODE, usePreferencesStore, type LineageRenderMode } from './preferences'

/** The choice of the view you're in. Anything but a choice per view (what an
 *  earlier build stored) reads as that view's default. */
export function useTraceLineMode(): LineageRenderMode {
  const view = usePersonaStore((s) => s.mode)
  return usePreferencesStore((s) => s.traceLineMode?.[view] ?? DEFAULT_TRACE_LINE_MODE[view])
}

/** Make a choice for the view you're in. */
export function chooseTraceLineMode(mode: LineageRenderMode): void {
  usePreferencesStore.getState().setTraceLineMode(usePersonaStore.getState().mode, mode)
}
