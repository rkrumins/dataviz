/**
 * LibraryImportDialog — bring another view's display rules and saved queries
 * into this one, seeing first exactly what that will do.
 *
 * Choose a library file (exported from any view), choose how it lands —
 * add what's new, add everything, or replace — and the server answers item
 * by item what the import would do: what it adds and under which name,
 * what it skips as already here, what it can't take and why, and what
 * refers to entity types this view doesn't show. Nothing changes until
 * "Import".
 *
 * Portal-mounted (mirrors CreateRuleModal) so the fixed overlay resolves to
 * the viewport, not to the drawer's framer-motion transform.
 */
import { motion } from 'framer-motion'
import {
    AlertTriangle, FileJson, Search as SearchIcon, Tags, Upload, X,
} from 'lucide-react'
import { type DragEvent, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { Backdrop } from '@/components/ui/Backdrop'
import { cn } from '@/lib/utils'
import {
    importViewLibrary,
    type ImportStrategy,
    type LibraryImportItem,
    type LibraryImportResult,
    type LibraryPack,
} from '@/services/viewLibraryService'
import { useViewLibraryStore } from '@/store/viewLibraryStore'

import { readLibraryFile } from './libraryFile'


export interface LibraryImportDialogProps {
    viewId: string
    branchId: string | null
    onClose: () => void
    /** After a real import; the view's library already holds the result. */
    onImported: (result: LibraryImportResult) => void
}


const STRATEGIES: ReadonlyArray<{ value: ImportStrategy; label: string; description: string }> = [
    {
        value: 'merge', label: "Add what's new",
        description: "Adds what this view doesn't have. Items with the same name and criteria are skipped.",
    },
    {
        value: 'copy', label: 'Add everything',
        description: 'Adds every item. A name already in use gets a number.',
    },
    {
        value: 'replace', label: 'Replace',
        description: "Removes this view's rules and saved queries, then adds the file's.",
    },
]


export function LibraryImportDialog({ viewId, branchId, onClose, onImported }: LibraryImportDialogProps) {
    const [pack, setPack] = useState<LibraryPack | null>(null)
    const [fileName, setFileName] = useState<string | null>(null)
    const [fileError, setFileError] = useState<string | null>(null)
    const [strategy, setStrategy] = useState<ImportStrategy>('merge')
    const [preview, setPreview] = useState<LibraryImportResult | null>(null)
    const [previewError, setPreviewError] = useState<string | null>(null)
    const [importing, setImporting] = useState(false)
    const [importError, setImportError] = useState<string | null>(null)
    const [dragging, setDragging] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)
    const adopt = useViewLibraryStore((s) => s.adopt)

    // What the import would do, asked again whenever the file or the way it
    // lands changes (each clears the last answer); an answer to an earlier
    // question is never shown.
    useEffect(() => {
        if (!pack) return
        let current = true
        importViewLibrary(viewId, pack, { strategy, dryRun: true, branchId })
            .then((result) => { if (current) setPreview(result) })
            .catch((e: Error) => { if (current) setPreviewError(e.message) })
        return () => { current = false }
    }, [viewId, branchId, pack, strategy])

    const clearPreview = () => {
        setPreview(null)
        setPreviewError(null)
    }

    const choose = (next: ImportStrategy) => {
        if (next === strategy) return
        clearPreview()
        setStrategy(next)
    }

    const takeFile = async (file: File | undefined) => {
        if (!file) return
        setFileName(file.name)
        setFileError(null)
        setPack(null)
        clearPreview()
        try {
            setPack(await readLibraryFile(file))
        } catch (e) {
            setFileError((e as Error).message)
        }
    }

    const onDrop = (e: DragEvent) => {
        e.preventDefault()
        setDragging(false)
        void takeFile(e.dataTransfer.files?.[0])
    }

    const handleImport = async () => {
        if (!pack) return
        setImporting(true)
        setImportError(null)
        try {
            const result = await importViewLibrary(viewId, pack, { strategy, dryRun: false, branchId })
            if (result.library) adopt(result.library)
            onImported(result)
        } catch (e) {
            setImportError((e as Error).message)
        } finally {
            setImporting(false)
        }
    }

    const ruleCount = pack?.displayRules?.length ?? 0
    const queryCount = pack?.savedQueries?.length ?? 0
    const canImport = Boolean(preview) && !importing
        && (preview!.added > 0 || (strategy === 'replace' && preview!.removed > 0))

    if (typeof document === 'undefined') return null
    return createPortal(
        <>
        <Backdrop open={true} onClick={onClose} zClassName="z-[60]" className="bg-black/50" />
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 pointer-events-none">
            <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.15 }}
                className={cn(
                    'pointer-events-auto relative w-full max-w-lg rounded-2xl overflow-hidden flex flex-col',
                    'max-h-[88vh]',
                    'bg-canvas-elevated',
                    'border border-slate-200 dark:border-glass-border',
                    'shadow-2xl shadow-black/40',
                )}
                role="dialog"
                aria-modal="true"
                aria-labelledby="library-import-title"
            >
                {/* Header */}
                <div className={cn(
                    'flex items-center gap-3 px-5 py-4 shrink-0',
                    'border-b border-slate-200 dark:border-glass-border',
                )}>
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-accent-lineage/15">
                        <Upload className="w-5 h-5 text-accent-lineage" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h3 id="library-import-title" className="text-[15px] font-display font-bold text-ink leading-tight">
                            Import rules and saved queries
                        </h3>
                        <p className="text-[11.5px] text-ink-muted mt-0.5">
                            From a library file exported from any view. You'll see what changes before anything does.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className={cn(
                            'inline-flex items-center justify-center w-8 h-8 rounded-lg',
                            'text-ink-muted hover:text-ink transition-colors',
                            'hover:bg-black/5 dark:hover:bg-white/5',
                        )}
                        aria-label="Cancel"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <div className="px-5 py-4 overflow-y-auto custom-scrollbar flex flex-col gap-4">
                    {/* 1 · The file */}
                    <div
                        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
                        onDragLeave={() => setDragging(false)}
                        onDrop={onDrop}
                        className={cn(
                            'rounded-xl border border-dashed px-4 py-3.5 flex items-center gap-3 transition-colors',
                            dragging
                                ? 'border-accent-lineage bg-accent-lineage/10'
                                : 'border-slate-300 dark:border-glass-border',
                        )}
                    >
                        <FileJson className="w-5 h-5 text-accent-lineage shrink-0" />
                        <div className="flex-1 min-w-0">
                            {pack ? (
                                <>
                                    <div className="text-[12.5px] font-semibold text-ink truncate">
                                        {pack.source?.viewName ? `From “${pack.source.viewName}”` : fileName}
                                    </div>
                                    <div className="text-[11px] text-ink-muted">
                                        {plural(ruleCount, 'display rule')} · {plural(queryCount, 'saved query', 'saved queries')}
                                        {pack.exportedAt ? ` · exported ${formatDate(pack.exportedAt)}` : ''}
                                    </div>
                                </>
                            ) : (
                                <div className="text-[12px] text-ink-muted">
                                    {fileName && !fileError ? `Reading ${fileName}…` : 'Drop a library file here, or choose one.'}
                                </div>
                            )}
                        </div>
                        <button
                            type="button"
                            onClick={() => inputRef.current?.click()}
                            className="shrink-0 inline-flex items-center px-3 h-7 rounded-lg text-[11.5px] font-medium bg-accent-lineage/15 text-accent-lineage hover:bg-accent-lineage/25 transition-colors"
                        >
                            {pack ? 'Choose another' : 'Choose file'}
                        </button>
                        <input
                            ref={inputRef}
                            type="file"
                            accept="application/json,.json"
                            aria-label="Library file"
                            className="hidden"
                            onChange={(e) => {
                                void takeFile(e.target.files?.[0])
                                e.target.value = ''   // the same file can be chosen again
                            }}
                        />
                    </div>
                    {fileError && (
                        <p role="alert" className="-mt-2 text-[11.5px] text-rose-400">{fileError}</p>
                    )}

                    {pack && (
                        <>
                            {/* 2 · How it lands */}
                            <div role="radiogroup" aria-label="How to import" className="flex flex-col gap-1.5">
                                {STRATEGIES.map((s) => (
                                    <button
                                        key={s.value}
                                        type="button"
                                        role="radio"
                                        aria-checked={strategy === s.value}
                                        onClick={() => choose(s.value)}
                                        className={cn(
                                            'text-left rounded-xl border px-3 py-2 transition-colors',
                                            strategy === s.value
                                                ? 'border-accent-lineage/60 bg-accent-lineage/10'
                                                : 'border-slate-200 dark:border-glass-border hover:border-accent-lineage/30',
                                        )}
                                    >
                                        <div className="text-[12px] font-semibold text-ink">{s.label}</div>
                                        <div className="text-[11px] text-ink-muted leading-snug">{s.description}</div>
                                    </button>
                                ))}
                            </div>

                            {/* 3 · What it will do */}
                            <Preview preview={preview} error={previewError} strategy={strategy} />
                        </>
                    )}
                </div>

                {/* Footer */}
                <div className={cn(
                    'flex items-center justify-end gap-2 px-5 py-3.5 shrink-0',
                    'border-t border-slate-200 dark:border-glass-border',
                    'bg-black/[0.02] dark:bg-white/[0.02]',
                )}>
                    {importError && (
                        <span role="alert" className="mr-auto text-[11.5px] text-rose-400 truncate" title={importError}>
                            Couldn't import — {importError}
                        </span>
                    )}
                    <button
                        type="button"
                        onClick={onClose}
                        className="inline-flex items-center px-3.5 h-8 rounded-lg text-[12px] font-medium text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={() => void handleImport()}
                        disabled={!canImport}
                        className={cn(
                            'inline-flex items-center gap-1.5 px-3.5 h-8 rounded-lg text-[12px] font-semibold transition-colors',
                            canImport
                                ? strategy === 'replace'
                                    ? 'bg-rose-600 hover:bg-rose-700 text-white'
                                    : 'bg-accent-lineage hover:bg-accent-lineage/90 text-white shadow-sm shadow-accent-lineage/30'
                                : 'bg-slate-100 dark:bg-white/5 text-slate-400 dark:text-ink-muted cursor-not-allowed',
                        )}
                    >
                        <Upload className="w-3.5 h-3.5" />
                        {importing ? 'Importing…' : importLabel(preview, strategy)}
                    </button>
                </div>
            </motion.div>
        </div>
        </>,
        document.body,
    )
}


function Preview({ preview, error, strategy }: {
    preview: LibraryImportResult | null
    error: string | null
    strategy: ImportStrategy
}) {
    if (error) {
        return <p role="alert" className="text-[11.5px] text-rose-400">Couldn't check the file — {error}</p>
    }
    if (!preview) {
        return <p className="text-[11.5px] text-ink-muted">Checking what the import would do…</p>
    }
    return (
        <div className="flex flex-col gap-2">
            <p className="text-[11.5px] text-ink-secondary" aria-live="polite">
                {[
                    `${preview.added} to add`,
                    preview.skipped ? `${preview.skipped} already here` : null,
                    preview.refused ? `${preview.refused} can't be imported` : null,
                ].filter(Boolean).join(' · ')}
            </p>
            {strategy === 'replace' && preview.removed > 0 && (
                <p className="flex items-start gap-1.5 text-[11.5px] text-rose-400 leading-snug">
                    <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
                    First removes this view's {plural(preview.removed, 'rule or saved query', 'rules and saved queries')}.
                </p>
            )}
            <ul className="flex flex-col gap-1 max-h-[34vh] overflow-y-auto custom-scrollbar pr-1">
                {preview.items.map((item, i) => <PreviewRow key={`${item.kind}-${i}`} item={item} />)}
            </ul>
        </div>
    )
}


const ACTION_BADGE: Record<LibraryImportItem['action'], { label: string; className: string }> = {
    add: { label: 'Add', className: 'bg-emerald-500/15 text-emerald-500' },
    skip: { label: 'Already here', className: 'bg-slate-500/15 text-ink-muted' },
    refuse: { label: "Can't import", className: 'bg-rose-500/15 text-rose-400' },
}


function PreviewRow({ item }: { item: LibraryImportItem }) {
    const Icon = item.kind === 'rule' ? Tags : SearchIcon
    const badge = ACTION_BADGE[item.action]
    return (
        <li className="rounded-lg border border-slate-200 dark:border-glass-border px-2.5 py-1.5">
            <div className="flex items-center gap-2 min-w-0">
                <Icon className="w-3.5 h-3.5 text-ink-muted shrink-0" aria-label={item.kind === 'rule' ? 'Display rule' : 'Saved query'} />
                <span className="text-[12px] text-ink truncate flex-1 min-w-0">
                    {item.name}
                    {item.newName && <span className="text-ink-muted"> → as “{item.newName}”</span>}
                </span>
                <span className={cn('shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold', badge.className)}>
                    {badge.label}
                </span>
            </div>
            {item.reason && item.action === 'refuse' && (
                <p className="mt-0.5 pl-[22px] text-[11px] text-rose-400 leading-snug">{item.reason}</p>
            )}
            {item.warnings.map((w) => (
                <p key={w} className="mt-0.5 pl-[22px] text-[11px] text-amber-500 leading-snug">{w}</p>
            ))}
        </li>
    )
}


function importLabel(preview: LibraryImportResult | null, strategy: ImportStrategy): string {
    if (!preview) return 'Import'
    if (strategy === 'replace') return `Replace with ${plural(preview.added, 'item')}`
    return preview.added > 0 ? `Import ${plural(preview.added, 'item')}` : 'Nothing to import'
}


function plural(n: number, one: string, many = `${one}s`): string {
    return `${n.toLocaleString()} ${n === 1 ? one : many}`
}


function formatDate(iso: string): string {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { dateStyle: 'medium' })
}
