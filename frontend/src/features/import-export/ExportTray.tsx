/**
 * ExportTray — the exports the server prepares, wherever the person is in the app.
 *
 * A large export takes minutes, and nobody should have to sit in its dialog for them. Once the
 * dialog closes — or the person goes on working on the canvas, changes page, or reloads — the
 * export shows here, bottom right, getting on as it did in its dialog (`ExportStatusRow`: the same
 * status, compact), and the tray says up front that the file downloads by itself the moment it is
 * ready, which it then does. A running export can be cancelled here (asked once more); a finished
 * one can be downloaded again until it goes, by itself shortly after its download started, or when
 * dismissed. It minimises to a pill with the overall progress, and opens again for an export
 * started after that.
 *
 * Page chrome, not an overlay: it sits under a dialog's backdrop, never over a dialog's buttons,
 * above the canvas dock, and publishes its height (`--export-tray-height`) so the notification
 * stack starts above it. Mounted once, by AppLayout, and only there does it follow the exports.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, ChevronUp, Download, Sparkles } from 'lucide-react'
import { remember, remembered } from '@/services/importExportApiService'
import { useAuthStore } from '@/store/auth'
import {
  dismissExport, exportProgress, exportStage, isWorking, runBackgroundExports, useBackgroundExports, useMyExports,
  type BackgroundExport, type ExportStage,
} from './backgroundExports'
import { AutoDownloadNote, ExportStatusRow, ProgressRing } from './ExportProgress'

/** When the tray was minimised: it stays a pill until an export newer than that starts. */
const MINIMISED = 'export-tray:minimised-at'
/** How long a finished export stays before it goes by itself: one downloaded, one cancelled. */
const LINGER_MS: Partial<Record<ExportStage, number>> = { downloaded: 30_000, cancelled: 8_000 }
const GAP_PX = 12

export function ExportTray() {
  const userId = useAuthStore((s) => s.user?.id ?? null)
  // This person's exports are followed from this tab while they are signed in.
  useEffect(() => runBackgroundExports(), [userId])
  const mine = useMyExports()
  const shown = useBackgroundExports((s) => s.shown)
  const items = mine.filter((e) => !shown.includes(e.jobId))
  const [minimisedAt, setMinimisedAt] = useState<number | null>(() => Number(remembered(MINIMISED)) || null)
  // Hovered or focused: nothing leaves from under the pointer.
  const [held, setHeld] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useTrayReservation(ref)

  const minimised = minimisedAt != null && (items[0]?.startedAt ?? 0) <= minimisedAt
  const minimise = (on: boolean) => {
    const at = on ? Date.now() : null
    setMinimisedAt(at)
    remember(MINIMISED, at ? String(at) : null)
  }
  const running = items.filter((e) => isWorking(exportStage(e)))
  const known = running.map((e) => exportProgress(e).pct).filter((p): p is number => p != null)
  const overall = known.length && known.length === running.length
    ? Math.floor(known.reduce((a, b) => a + b, 0) / known.length) : null

  return (
    <div ref={ref} className="fixed right-6 z-40 flex flex-col items-end pointer-events-none"
      style={{ bottom: 'calc(1.5rem + var(--canvas-dock-height, 0px))' }}>
      <p className="sr-only" role="status" aria-live="polite">{announcement(mine)}</p>
      <AnimatePresence mode="wait" initial={false}>
        {items.length > 0 && (minimised ? (
          <motion.button key="pill" type="button" onClick={() => minimise(false)}
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
            aria-label={running.length ? `Show exports, ${running.length} in progress` : 'Show exports'}
            className="pointer-events-auto flex items-center gap-2.5 pl-1.5 pr-3.5 py-1.5 rounded-full bg-canvas-elevated border border-glass-border shadow-xl shadow-black/15 hover:shadow-2xl transition-shadow">
            <span className="relative w-8 h-8 flex-shrink-0">
              <span className="absolute inset-[3px] rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-white flex items-center justify-center">
                <Download className="w-3.5 h-3.5" />
              </span>
              {running.length > 0 && <ProgressRing pct={overall} />}
            </span>
            <span className="text-xs font-semibold text-ink tabular-nums">
              {running.length ? `Exporting${overall != null ? ` · ${overall}%` : '…'}` : 'Exports'}
            </span>
            <ChevronUp className="w-3.5 h-3.5 text-ink-muted" />
          </motion.button>
        ) : (
          <motion.section key="panel" aria-label="Exports"
            initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }} transition={{ type: 'spring', damping: 24, stiffness: 300 }}
            onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)}
            onFocus={() => setHeld(true)}
            onBlur={(ev) => { if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) setHeld(false) }}
            className="pointer-events-auto w-[22rem] max-w-[calc(100vw-3rem)] rounded-2xl overflow-hidden bg-canvas-elevated border border-glass-border shadow-2xl shadow-black/20">
            <header className="flex items-center gap-3 px-4 py-3 border-b border-glass-border bg-gradient-to-r from-indigo-500/[0.06] via-violet-500/[0.04] to-transparent">
              <span className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-white shadow-md shadow-indigo-500/25 flex-shrink-0">
                <Download className="w-4 h-4" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold text-ink">Exports</h2>
                <p className="text-[11px] text-ink-muted">
                  {running.length ? `Preparing ${running.length === 1 ? 'a file' : `${running.length} files`}` : 'Recent exports'}
                </p>
              </div>
              <button type="button" onClick={() => minimise(true)} aria-label="Minimise exports"
                className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                <ChevronDown className="w-4 h-4" />
              </button>
            </header>
            <ul className="max-h-[min(24rem,50vh)] overflow-y-auto divide-y divide-glass-border">
              <AnimatePresence initial={false}>
                {items.map((e) => <TrayItem key={e.jobId} e={e} held={held} />)}
              </AnimatePresence>
            </ul>
            {running.length > 0 && (
              <div className="flex items-start gap-2 px-4 py-2.5 border-t border-glass-border bg-indigo-500/[0.04] dark:bg-indigo-400/[0.06]">
                <Sparkles className="w-3.5 h-3.5 text-indigo-500 mt-0.5 flex-shrink-0" />
                <AutoDownloadNote compact />
              </div>
            )}
          </motion.section>
        ))}
      </AnimatePresence>
    </div>
  )
}

function TrayItem({ e, held }: { e: BackgroundExport; held: boolean }) {
  useLinger(e, exportStage(e), held)
  return (
    <motion.li layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="px-4 py-3">
      <ExportStatusRow e={e} />
    </motion.li>
  )
}

/** A finished export goes by itself a while after it finished (its download, or its cancel), but
 *  never from under the pointer: held, it waits, and lingers a moment more once let go. */
function useLinger(e: BackgroundExport, stage: ExportStage, held: boolean) {
  const since = stage === 'downloaded' ? e.downloadedAt : stage === 'cancelled' ? e.endedAt : null
  const linger = LINGER_MS[stage]
  useEffect(() => {
    if (!linger || !since || held) return
    const timer = setTimeout(() => dismissExport(e.jobId), Math.max(1_500, linger - (Date.now() - since)))
    return () => clearTimeout(timer)
  }, [e.jobId, linger, since, held])
}

/** The tray's height, for the notification stack to start above it; none while it is empty. */
function useTrayReservation(ref: React.RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const root = document.documentElement
    const publish = () => {
      if (el.offsetHeight) root.style.setProperty('--export-tray-height', `${el.offsetHeight + GAP_PX}px`)
      else root.style.removeProperty('--export-tray-height')
    }
    publish()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(publish) : null
    ro?.observe(el)
    return () => {
      ro?.disconnect()
      root.style.removeProperty('--export-tray-height')
    }
  }, [ref])
}

/** What a screen reader hears: how the export that changed last ended up. */
function announcement(exports: BackgroundExport[]): string {
  let latest: BackgroundExport | null = null
  let at = 0
  for (const e of exports) {
    const t = Math.max(e.downloadedAt ?? 0, e.endedAt ?? 0)
    if (t > at) [latest, at] = [e, t]
  }
  if (!latest) return ''
  switch (exportStage(latest)) {
    case 'downloaded': return `${latest.fileName} is ready. Its download has started.`
    case 'ready': return `${latest.fileName} is ready.`
    case 'failed': return `${latest.fileName} could not be exported.`
    case 'expired': return `${latest.fileName} is no longer kept. Export it again.`
    case 'cancelled': return `${latest.fileName} was cancelled.`
    default: return ''
  }
}
