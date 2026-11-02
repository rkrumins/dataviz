/**
 * ConnectModePill — what a connection in progress is waiting for, and the way
 * out. Shown at the top of the canvas while a connection is armed (a source is
 * chosen, the target is next) or while the Connect tool waits for a source.
 *
 * Nothing is held during a click-to-connect, so the reader may scroll, jump
 * with the Layer Strip or search before picking a target; this capsule keeps
 * saying what happens next the whole time. A click that lands on no card
 * shakes it once (`nudge`) rather than dropping the connection.
 *
 * `data-connect-ui` marks it as connect chrome: its own clicks never nudge.
 */
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { Kbd } from '@/components/ui/Kbd'
import { HoverTip } from '@/components/ui/HoverTip'
import { formatShortcut } from '@/lib/platform'

export interface ConnectModePillProps {
  /** 'tool': waiting for the card a link starts from; 'armed': for its target. */
  phase: 'tool' | 'armed'
  /** The source's name, when one card is the source. */
  sourceLabel?: string | null
  /** How many cards the connection carries (a selection carries several). */
  sourceCount: number
  /** Targets collected with ⌘/Ctrl-click. */
  targetCount: number
  /** Bumped by a click on no card — the pill shakes once. */
  nudge: number
  /** The Connect tool is on: it keeps going after each link. */
  tool: boolean
  onLinkTargets: () => void
  onClearTargets: () => void
  /** Drop the source (the tool, if on, waits for the next one). */
  onCancel: () => void
  /** Turn the Connect tool off. */
  onExitTool: () => void
  /** Pick the target from a searchable list instead (the keyboard path). */
  onSearchTarget?: () => void
}

const quietAction = cn(
  'pointer-events-auto inline-flex items-center gap-1 h-7 px-2.5 rounded-lg text-[11.5px] font-semibold',
  'text-ink-secondary hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.07] transition-colors',
)
const primaryAction = cn(
  'pointer-events-auto inline-flex items-center gap-1.5 h-7 px-3 rounded-lg text-[11.5px] font-semibold',
  'bg-accent-lineage text-white shadow-sm hover:brightness-110 transition',
)

export function ConnectModePill(props: ConnectModePillProps) {
  const { phase, sourceLabel, sourceCount, targetCount, nudge, tool, onLinkTargets, onClearTargets, onCancel, onExitTool, onSearchTarget } = props

  const mod = formatShortcut('mod')
  const several = sourceCount > 1
  const headline = phase === 'tool'
    ? 'Connect — click the entity a link starts from'
    : several
      ? <>Connecting <strong className="font-semibold">{sourceCount.toLocaleString()} entities</strong></>
      : <>Connecting from <strong className="font-semibold">{sourceLabel || 'this entity'}</strong></>
  const detail = phase === 'tool'
    ? 'Then click where it goes. The tool stays on for the next link.'
    : targetCount > 0
      ? `${targetCount.toLocaleString()} ${targetCount === 1 ? 'target' : 'targets'} picked — ${mod}-click for more, or link them now.`
      : several
        ? 'Click the entity they all feed. Scroll or jump to it first if it is off screen.'
        : `Click a target — ${mod}-click to pick several. Scroll or jump to it if it is off screen.`

  return (
    <div
      role="status"
      aria-live="polite"
      data-connect-ui
      className="pointer-events-none absolute inset-x-0 top-3 z-40 flex justify-center px-4"
    >
      {/* Keyed on the nudge: each stray click remounts the capsule, replaying its shake. */}
      <div
        key={nudge}
        className={cn(
          'pointer-events-auto flex items-center gap-3 w-full min-w-0 max-w-[560px]',
          'px-4 py-2.5 rounded-2xl backdrop-blur-xl',
          'bg-white/85 dark:bg-neutral-900/85',
          'ring-1 ring-black/[0.07] dark:ring-white/[0.09]',
          'shadow-xl shadow-black/[0.08] dark:shadow-black/50',
          nudge > 0 && 'nx-connect-nudge',
        )}
      >
        <span className="relative flex-none grid place-items-center w-7 h-7 rounded-full bg-accent-lineage/10 text-accent-lineage" aria-hidden="true">
          <LucideIcons.Spline className="w-3.5 h-3.5" />
          {phase === 'armed' && <span className="absolute inset-0 rounded-full ring-2 ring-accent-lineage/40 nx-connect-source-ring" />}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block font-display text-[12.5px] text-ink leading-tight truncate">{headline}</span>
          <span className="block mt-0.5 text-[10.5px] text-ink-muted leading-tight line-clamp-2">{detail}</span>
        </span>
        <span className="flex items-center gap-1 flex-none">
          {phase === 'armed' && targetCount > 0 ? (
            <>
              <button type="button" onClick={onClearTargets} className={quietAction}>Clear</button>
              <button type="button" onClick={onLinkTargets} className={primaryAction}>
                Link {targetCount.toLocaleString()}
                <Kbd shortcut="enter" tone="onAccent" />
              </button>
            </>
          ) : phase === 'armed' ? (
            <>
              {onSearchTarget && !several && (
                <HoverTip className="flex" label="Choose the target from a list" detail="Search every entity on the canvas by name — handy from the keyboard.">
                  <button type="button" onClick={onSearchTarget} className={quietAction} aria-label="Find the target in a list">
                    <LucideIcons.Search className="w-3 h-3" aria-hidden="true" />
                    Find…
                  </button>
                </HoverTip>
              )}
              <button type="button" onClick={onCancel} className={quietAction}>
                Cancel <Kbd shortcut="esc" />
              </button>
            </>
          ) : null}
          {tool && (
            <HoverTip className="flex" label="Turn the Connect tool off" shortcut="C">
              <button type="button" onClick={onExitTool} className={quietAction} aria-label="Done connecting">
                Done
              </button>
            </HoverTip>
          )}
        </span>
      </div>
    </div>
  )
}

export default ConnectModePill
