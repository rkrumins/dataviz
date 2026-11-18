/**
 * ShortcutsHint — the keys a surface answers to, on a small keyboard button: hovered or focused
 * (`?` focuses it, where the surface wires that), it lists them, each with what it does. Only the
 * keys that apply right now are listed — a surface passes what it offers.
 */
import { Keyboard } from 'lucide-react'
import { HoverTip } from './HoverTip'
import { Kbd } from './Kbd'

export function ShortcutsHint({ id, shortcuts }: {
  /** The button's id, for `?` to focus it. */
  id?: string
  /** `[keys, what it does]`; keys `"j k"` show as two chips. */
  shortcuts: ReadonlyArray<readonly [string, string]>
}) {
  return (
    <HoverTip width="data" className="inline-flex" label={(
      <span className="block space-y-1">
        <span className="block text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted">Keyboard</span>
        {shortcuts.map(([keys, what]) => (
          <span key={keys} className="flex items-center justify-between gap-4 text-[11.5px]">
            <span className="text-ink-secondary">{what}</span>
            <span className="inline-flex items-center gap-0.5 shrink-0">{keys.split(' ').map((k) => <Kbd key={k} shortcut={k} />)}</span>
          </span>
        ))}
      </span>
    )}>
      <button id={id} type="button" aria-label="Keyboard shortcuts"
        className="w-7 h-7 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
        <Keyboard className="w-3.5 h-3.5" aria-hidden />
      </button>
    </HoverTip>
  )
}
