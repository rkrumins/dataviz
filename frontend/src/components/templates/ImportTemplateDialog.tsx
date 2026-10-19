/**
 * Import a layout template from a file — one exported from this library or
 * another installation's. See its layers and how they fit your data, name it,
 * choose who can use it, and it joins the library as a new template.
 */
import { useRef, useState, type DragEvent } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { FileJson, Loader2, Upload, X } from 'lucide-react'
import { Backdrop } from '@/components/ui/Backdrop'
import { useAppNotifications } from '@/components/ui/notifications'
import { useWorkspaceEntityTypes } from '@/hooks/useWorkspaceEntityTypes'
import { useInvalidateLayoutTemplates } from '@/hooks/useLayoutTemplates'
import { useModalA11y } from '@/hooks/useModalA11y'
import { cn } from '@/lib/utils'
import {
    layoutTemplateService, type LayoutTemplate, type TemplateVisibility,
} from '@/services/layoutTemplateService'
import { useWorkspacesStore } from '@/store/workspaces'
import { AudiencePicker } from './AudiencePicker'
import { FitRing } from './TemplateCard'
import { TemplatePreview } from './TemplatePreview'
import { readTemplateFile, type TemplateFileContent } from './templateFile'
import { fitTemplate } from './templateFit'
import { primarySource, useFitWorkspaces } from './useTemplateFits'

/** "Finance flow" → "Finance flow (imported)", then "(imported 2)" … until it is free. */
function freeName(name: string, taken: ReadonlySet<string>): string {
    if (!taken.has(name.toLowerCase())) return name
    for (let n = 1; ; n++) {
        const suffix = n === 1 ? ' (imported)' : ` (imported ${n})`
        const candidate = `${name.slice(0, 80 - suffix.length)}${suffix}`
        if (!taken.has(candidate.toLowerCase())) return candidate
    }
}

/** How the file's layers fit the active workspace's data, when it can be read. */
function FitLine({ layers }: { layers: TemplateFileContent['layers'] }) {
    const choices = useFitWorkspaces()
    const activeWorkspaceId = useWorkspacesStore(s => s.activeWorkspaceId)
    const workspace = choices.find(ws => ws.id === activeWorkspaceId) ?? choices[0]
    const source = workspace ? primarySource(workspace) : undefined
    const { types } = useWorkspaceEntityTypes(workspace?.id, source?.id)
    if (!workspace || !types) return null
    const fit = fitTemplate(layers, types)
    if (fit.typedLayers === 0) return null
    return (
        <div className="flex items-center gap-2 text-xs text-ink-muted">
            <FitRing matched={fit.matchedLayers} typed={fit.typedLayers} workspaceName={workspace.name} />
            <span>
                Matches {fit.matchedLayers} of {fit.typedLayers} layer{fit.typedLayers === 1 ? '' : 's'} in {workspace.name}
                {fit.unmatchedTypes.length > 0 && <> — not there: {fit.unmatchedTypes.join(', ')}</>}
            </span>
        </div>
    )
}

export function ImportTemplateDialog({ existingNames, onClose, onImported }: {
    /** The names already in the library: a clash is renamed "(imported)". */
    existingNames: readonly string[]
    onClose: () => void
    onImported: (template: LayoutTemplate) => void
}) {
    const ref = useModalA11y(true, onClose)
    const { notify } = useAppNotifications()
    const invalidate = useInvalidateLayoutTemplates()
    const inputRef = useRef<HTMLInputElement>(null)
    const [dragging, setDragging] = useState(false)
    const [fileName, setFileName] = useState<string | null>(null)
    const [fileError, setFileError] = useState<string | null>(null)
    const [content, setContent] = useState<TemplateFileContent | null>(null)
    const [name, setName] = useState('')
    const [audience, setAudience] = useState<{ visibility: TemplateVisibility; workspaceId: string | null }>({
        visibility: 'private', workspaceId: null,
    })
    const [importing, setImporting] = useState(false)
    const taken = new Set(existingNames.map(n => n.toLowerCase()))

    const takeFile = async (file: File | undefined) => {
        if (!file) return
        setFileName(file.name)
        setFileError(null)
        setContent(null)
        try {
            const read = await readTemplateFile(file)
            setContent(read)
            setName(freeName(read.name, taken))
        } catch (e) {
            setFileError((e as Error).message)
        }
    }

    const onDrop = (e: DragEvent) => {
        e.preventDefault()
        setDragging(false)
        void takeFile(e.dataTransfer.files?.[0])
    }

    const submit = async () => {
        if (!content) return
        setImporting(true)
        try {
            const created = await layoutTemplateService.create({ ...content, name: name.trim(), ...audience })
            notify('success', `Imported "${created.name}"`)
            void invalidate()
            onImported(created)
        } catch (e) {
            notify('error', (e as Error).message)
        } finally {
            setImporting(false)
        }
    }

    const nameOk = name.trim().length > 0 && name.trim().length <= 80
    const audienceOk = audience.visibility !== 'workspace' || !!audience.workspaceId
    const renamed = !!content && name !== content.name && taken.has(content.name.toLowerCase())

    return createPortal(
        <>
            <Backdrop open onClick={onClose} zClassName="z-[60]" className="bg-black/50" />
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 pointer-events-none">
                <motion.div
                    ref={ref}
                    initial={{ opacity: 0, scale: 0.97 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.15 }}
                    role="dialog"
                    aria-modal="true"
                    aria-label="Import a layout template"
                    tabIndex={-1}
                    className="pointer-events-auto w-full max-w-2xl max-h-[88vh] flex flex-col rounded-2xl bg-canvas-elevated border border-slate-200 dark:border-slate-700 shadow-2xl focus:outline-none"
                >
                    <div className="h-1 rounded-t-2xl bg-gradient-to-r from-violet-500 via-fuchsia-500 to-indigo-500 shrink-0" />
                    <header className="flex items-start gap-3 px-6 pt-5 pb-3 shrink-0">
                        <div className="w-10 h-10 rounded-xl bg-violet-500/10 border border-violet-500/20 text-violet-600 flex items-center justify-center shrink-0">
                            <Upload className="w-5 h-5" aria-hidden />
                        </div>
                        <div className="flex-1 min-w-0">
                            <h2 className="text-lg font-bold text-ink">Import a layout template</h2>
                            <p className="text-xs text-ink-muted mt-0.5">
                                From a .layout-template.json file. Only the layout comes in — never entities, shares or history.
                            </p>
                        </div>
                        <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5">
                            <X className="w-4 h-4" />
                        </button>
                    </header>

                    <div className="px-6 pb-4 overflow-y-auto custom-scrollbar space-y-5">
                        <div
                            onDragOver={e => { e.preventDefault(); setDragging(true) }}
                            onDragLeave={() => setDragging(false)}
                            onDrop={onDrop}
                            className={cn(
                                'rounded-xl border-2 border-dashed px-4 py-4 flex items-center gap-3 transition-colors',
                                dragging ? 'border-violet-500 bg-violet-500/10' : 'border-slate-300 dark:border-slate-600',
                            )}
                        >
                            <FileJson className="w-6 h-6 text-violet-500 shrink-0" aria-hidden />
                            <div className="flex-1 min-w-0 text-sm">
                                {content ? (
                                    <>
                                        <div className="font-semibold text-ink truncate">{fileName}</div>
                                        <div className="text-xs text-ink-muted">
                                            {content.layers.length} layer{content.layers.length === 1 ? '' : 's'}
                                        </div>
                                    </>
                                ) : (
                                    <div className="text-ink-muted">
                                        {fileName && !fileError ? `Reading ${fileName}…` : 'Drop a template file here, or choose one.'}
                                    </div>
                                )}
                            </div>
                            <button
                                type="button"
                                onClick={() => inputRef.current?.click()}
                                className="shrink-0 px-3 h-8 rounded-lg text-xs font-semibold bg-violet-500/10 text-violet-700 dark:text-violet-300 hover:bg-violet-500/20"
                            >
                                {content ? 'Choose another' : 'Choose file'}
                            </button>
                            <input
                                ref={inputRef}
                                type="file"
                                accept="application/json,.json"
                                aria-label="Template file"
                                className="hidden"
                                onChange={e => {
                                    void takeFile(e.target.files?.[0])
                                    e.target.value = ''   // the same file can be chosen again
                                }}
                            />
                        </div>
                        {fileError && <p role="alert" className="-mt-3 text-xs text-rose-600 dark:text-rose-400">{fileError}</p>}

                        {content && (
                            <>
                                <div className="rounded-2xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
                                    <TemplatePreview layers={content.layers} />
                                    {content.description && <p className="text-xs text-ink-muted">{content.description}</p>}
                                    <FitLine layers={content.layers} />
                                </div>
                                <label className="block">
                                    <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Name</span>
                                    <input
                                        type="text"
                                        value={name}
                                        maxLength={80}
                                        onChange={e => setName(e.target.value)}
                                        className="input border-slate-200 dark:border-slate-700 mt-1.5 h-10 w-full bg-glass-base/40"
                                    />
                                    {renamed && (
                                        <span className="block mt-1 text-[11px] text-ink-muted">
                                            Your library already has “{content.name}”, so this one is renamed to keep them apart.
                                        </span>
                                    )}
                                </label>
                                <div>
                                    <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Who can use it</span>
                                    <div className="mt-2">
                                        <AudiencePicker visibility={audience.visibility} workspaceId={audience.workspaceId} onChange={setAudience} />
                                    </div>
                                </div>
                            </>
                        )}
                    </div>

                    <footer className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-200 dark:border-slate-700 shrink-0">
                        <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5">
                            Cancel
                        </button>
                        <button
                            type="button"
                            disabled={!content || !nameOk || !audienceOk || importing}
                            onClick={() => void submit()}
                            className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold bg-gradient-to-r from-violet-500 to-indigo-600 text-white shadow-md disabled:opacity-50"
                        >
                            {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                            Import template
                        </button>
                    </footer>
                </motion.div>
            </div>
        </>,
        document.body,
    )
}
