/** Where to let go of a view file dropped on a page (see `useViewFileDrop`). */
import { FileUp } from 'lucide-react'

export function ViewFileDropOverlay({ show }: { show: boolean }) {
  if (!show) return null
  return (
    <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-indigo-500/[0.06] backdrop-blur-[1px]">
      <div className="flex flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-indigo-400 bg-canvas-elevated/95 px-12 py-10 shadow-2xl">
        <span className="w-14 h-14 rounded-2xl bg-indigo-500/10 text-indigo-500 flex items-center justify-center">
          <FileUp className="w-7 h-7" />
        </span>
        <p className="text-sm font-bold text-ink">Drop to import this view</p>
        <p className="text-xs text-ink-muted">A <span className="font-mono">.view.json</span> file opens the Import journey</p>
      </div>
    </div>
  )
}
