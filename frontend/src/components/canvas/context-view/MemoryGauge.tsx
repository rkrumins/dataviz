/**
 * MemoryGauge — how much memory this tab's script is holding, and a way to
 * give back what can be refetched.
 *
 * Quiet until it matters: it shows itself once the heap passes 1 GB (amber;
 * red from 2 GB), or always when the reader asks for it (Display > Display
 * options > Show memory usage). Sampled every few seconds from Chromium's
 * `performance.memory`; where the browser does not report it, nothing is
 * shown rather than a guess (lib/memoryMonitor.ts).
 *
 * "Free memory" releases every cache the app can rebuild from the server —
 * the Focus Lens's and the drawer's walks it is not showing, and the
 * providers' cached responses — then samples again, so the reader sees what
 * it bought.
 */
import { useEffect, useState } from 'react'
import { MemoryStick } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePreferencesStore } from '@/store/preferences'
import {
  HEAP_HIGH_BYTES,
  formatBytes,
  heapLevel,
  readHeap,
  releaseMemory,
  type HeapReading,
} from '@/lib/memoryMonitor'

const SAMPLE_MS = 5000

function useHeapReading(): HeapReading | null {
  const [reading, setReading] = useState<HeapReading | null>(() => readHeap())
  useEffect(() => {
    const id = window.setInterval(() => setReading(readHeap()), SAMPLE_MS)
    return () => window.clearInterval(id)
  }, [])
  return reading
}

export function MemoryGauge({ className }: { className?: string }) {
  const pinned = usePreferencesStore((s) => s.showMemoryUsage) ?? false
  const reading = useHeapReading()
  const [open, setOpen] = useState(false)
  const [released, setReleased] = useState<{ responses: number; before: number } | null>(null)
  const [after, setAfter] = useState<HeapReading | null>(null)

  useEffect(() => {
    if (!released) return
    // Give the collector a moment, then show what the release bought.
    const id = window.setTimeout(() => setAfter(readHeap()), 2500)
    return () => window.clearTimeout(id)
  }, [released])

  if (!reading || (!pinned && reading.used < HEAP_HIGH_BYTES && !open)) return null

  const level = heapLevel(reading.used)
  const share = Math.min(1, reading.used / Math.max(1, reading.limit))
  const tone = level === 'very-high'
    ? { text: 'text-rose-600 dark:text-rose-400', bar: 'bg-rose-500', ring: 'border-rose-500/40' }
    : level === 'high'
      ? { text: 'text-amber-600 dark:text-amber-400', bar: 'bg-amber-500', ring: 'border-amber-500/40' }
      : { text: 'text-ink-muted', bar: 'bg-accent-lineage', ring: 'border-glass-border' }

  const free = () => {
    const responses = releaseMemory()
    setAfter(null)
    setReleased({ responses, before: reading.used })
  }

  return (
    <div className={cn('self-end flex flex-col items-end gap-1', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Memory this tab's script is holding"
        className={cn(
          'flex items-center gap-2 px-2.5 py-1.5 rounded-xl bg-canvas-elevated border shadow-lg text-[11.5px] transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
          tone.ring, tone.text,
        )}
      >
        <MemoryStick className="w-3.5 h-3.5" />
        <span className="font-medium">Memory</span>
        <span className="relative w-10 h-1 rounded-full bg-black/10 dark:bg-white/15 overflow-hidden" aria-hidden>
          <span className={cn('absolute inset-y-0 left-0 rounded-full', tone.bar)} style={{ width: `${Math.max(4, share * 100)}%` }} />
        </span>
        <span className="tabular-nums">{formatBytes(reading.used)}</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Memory"
          className="w-80 rounded-xl bg-canvas-elevated border border-glass-border shadow-lg p-3 text-[11.5px] text-ink-muted"
        >
          <p className="text-[12px] font-semibold text-ink">
            {formatBytes(reading.used)} of {formatBytes(reading.limit)} in use
          </p>
          <div className="mt-2 h-1.5 rounded-full bg-black/[0.06] dark:bg-white/[0.08] overflow-hidden" aria-hidden>
            <div className={cn('h-full rounded-full', tone.bar)} style={{ width: `${Math.max(2, share * 100)}%` }} />
          </div>
          <p className="mt-2 leading-snug">
            {level === 'ok'
              ? 'The script heap is comfortable.'
              : 'A lot is loaded. Freeing memory releases what can be fetched again — walks the Focus Lens and the drawer are not showing, and cached responses. Nothing on screen changes.'}
          </p>
          <p className="mt-1 leading-snug text-ink-muted opacity-80">
            This is the page&apos;s script memory. The browser&apos;s Task Manager shows the whole tab.
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={free}
              className="px-2.5 py-1 rounded-md text-[11.5px] font-semibold bg-accent-lineage/10 text-accent-lineage hover:bg-accent-lineage/15 transition-colors"
            >
              Free memory
            </button>
            {released && (
              <span className="tabular-nums">
                {after
                  ? `Now ${formatBytes(after.used)}${after.used < released.before ? ` — ${formatBytes(released.before - after.used)} released` : ''}`
                  : `Released ${released.responses.toLocaleString()} cached ${released.responses === 1 ? 'response' : 'responses'}…`}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
