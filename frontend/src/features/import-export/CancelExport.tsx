/**
 * "Cancel export", asked once more before the server stops: an export started by mistake costs the
 * server minutes, and one cancelled by mistake costs the person starting it over. Shared by the
 * export tray and the dialogs that start exports.
 */
import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { cancelBackgroundExport } from './backgroundExports'

export function CancelExport({ jobId, variant = 'footer' }: {
  jobId: string
  /** In a dialog's footer, or under an export in the tray. */
  variant?: 'footer' | 'row'
}) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function cancel() {
    setBusy(true)
    setError(null)
    try {
      await cancelBackgroundExport(jobId)
      setAsking(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The export could not be cancelled.')
    } finally {
      setBusy(false)
    }
  }

  if (!asking) {
    return (
      <button type="button" onClick={() => setAsking(true)}
        className={cn('rounded-lg font-medium transition-colors',
          variant === 'footer'
            ? 'px-3 py-2 rounded-xl text-sm text-ink-muted hover:text-rose-600 hover:bg-rose-50 dark:hover:text-rose-400 dark:hover:bg-rose-950/30'
            : 'px-2 py-1 text-[11px] text-ink-muted hover:text-rose-600 hover:bg-rose-50 dark:hover:text-rose-400 dark:hover:bg-rose-950/30')}>
        Cancel export
      </button>
    )
  }
  return (
    <div role="group" aria-label="Cancel this export?"
      className={cn('flex flex-wrap items-center gap-2 rounded-xl border border-rose-200/70 dark:border-rose-900/60 bg-rose-50/70 dark:bg-rose-950/25',
        variant === 'footer' ? 'px-3 py-1.5' : 'w-full mt-2.5 px-3 py-2')}>
      <span className="text-[11px] text-ink mr-auto">Stop this export? Nothing will download.</span>
      <button type="button" onClick={() => setAsking(false)} disabled={busy}
        className="px-2.5 py-1 rounded-lg text-[11px] font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50">
        Keep exporting
      </button>
      <button type="button" onClick={() => void cancel()} disabled={busy}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-rose-500 text-white hover:bg-rose-600 transition-colors shadow-sm shadow-rose-500/20 disabled:opacity-60">
        {busy && <Loader2 className="w-3 h-3 animate-spin" />} Stop export
      </button>
      {error && <p role="alert" className="basis-full text-[11px] text-rose-600 dark:text-rose-400">{error}</p>}
    </div>
  )
}
