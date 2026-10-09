/**
 * The file well for view files, and for views with their data (packages): drop or browse, then it
 * says what it found.
 *
 * Five states, one component: waiting, a file dragged over it, checking, checked, refused. The
 * file is only ever READ here (the server inspects it); nothing is written until the last step.
 */
import { useCallback, useRef, useState } from 'react'
import { AlertTriangle, FileArchive, FileJson2, FileUp, Loader2, RefreshCw, Shield, ShieldAlert, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { BundleIntegrity } from '@/services/viewTransferApiService'
import { fileSize } from './format'

export function IntegrityBadge({ integrity, environment }: { integrity: BundleIntegrity; environment?: string | null }) {
  const meta = {
    verified: {
      icon: ShieldCheck, label: 'Verified',
      title: `Exactly what ${environment || 'the other environment'} exported`,
      cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
    },
    modified: {
      icon: ShieldAlert, label: 'Edited after export',
      title: 'The file was changed after it was exported. It imports as it is now.',
      cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    },
    unverifiable: {
      icon: Shield, label: 'Not verifiable',
      title: 'The file carries no fingerprint to check it against.',
      cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
    },
  }[integrity]
  const Icon = meta.icon
  return (
    <span title={meta.title} className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold', meta.cls)}>
      <Icon className="w-3 h-3" aria-hidden />
      {meta.label}
    </span>
  )
}

export function BundleDropzone({
  fileName, size, busy, error, integrity, environment, packaged = false, onFile,
}: {
  fileName: string | null
  size: number
  busy: boolean
  error: string | null
  integrity: BundleIntegrity | null
  environment?: string | null
  /** The file is a view with its data. */
  packaged?: boolean
  onFile: (file: File) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const browse = useCallback(() => inputRef.current?.click(), [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) onFile(file)
  }, [onFile])

  const input = (
    <input
      ref={inputRef}
      type="file"
      accept=".json,application/json,.zip,application/zip"
      className="sr-only"
      aria-label="Choose a view file"
      onChange={(e) => {
        const file = e.target.files?.[0]
        if (file) onFile(file)
        e.target.value = ''
      }}
    />
  )

  if (fileName && !error) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-glass-border bg-canvas-elevated px-4 py-3">
        {input}
        <span className="w-10 h-10 rounded-xl bg-indigo-500/10 text-indigo-500 flex items-center justify-center shrink-0">
          {busy ? <Loader2 className="w-5 h-5 animate-spin" />
            : packaged ? <FileArchive className="w-5 h-5" /> : <FileJson2 className="w-5 h-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink truncate" title={fileName}>{fileName}</p>
          <p className="text-[11px] text-ink-muted">
            {busy ? 'Checking the file…' : `${packaged ? 'A view with its data · ' : ''}${fileSize(size)}`}
          </p>
        </div>
        {!busy && integrity && <IntegrityBadge integrity={integrity} environment={environment} />}
        {!busy && (
          <button type="button" onClick={browse}
            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
            <RefreshCw className="w-3 h-3" /> Replace
          </button>
        )}
      </div>
    )
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={browse}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); browse() } }}
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn(
        'relative flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 text-center cursor-pointer transition-colors outline-none',
        'focus-visible:ring-2 focus-visible:ring-indigo-500',
        error ? 'border-rose-300 bg-rose-50/60 dark:border-rose-800 dark:bg-rose-950/20'
          : dragging ? 'border-indigo-500 bg-indigo-50/70 dark:bg-indigo-950/30'
            : 'border-glass-border hover:border-indigo-300 hover:bg-indigo-50/30 dark:hover:bg-indigo-950/10',
      )}
    >
      {input}
      <span className={cn('w-14 h-14 rounded-2xl flex items-center justify-center',
        error ? 'bg-rose-100 text-rose-500 dark:bg-rose-900/40' : 'bg-indigo-500/10 text-indigo-500')}>
        {error ? <AlertTriangle className="w-7 h-7" /> : <FileUp className="w-7 h-7" />}
      </span>
      {error ? (
        <>
          <p className="text-sm font-semibold text-ink">{fileName ? `${fileName} can't be imported` : "This file can't be imported"}</p>
          <p className="text-xs text-ink-muted max-w-sm leading-relaxed">{error}</p>
          <p className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400">Choose another file</p>
        </>
      ) : (
        <>
          <p className="text-sm font-semibold text-ink">{dragging ? 'Release to check the file' : 'Drop a view file here'}</p>
          <p className="text-xs text-ink-muted">
            or <span className="font-semibold text-indigo-600 dark:text-indigo-400">browse</span> for a <span className="font-mono">.view.json</span> exported from any environment
          </p>
          <p className="text-[11px] text-ink-muted">
            A view with its data (<span className="font-mono">.view-package.zip</span>) comes in here too, through a draft
          </p>
        </>
      )}
    </div>
  )
}
