/**
 * YourDataModels — the reader's own data models in the Playground, and those others shared.
 *
 * A data model (a semantic layer) says what types of things and connections a graph holds. Here
 * the reader sees theirs — draft or published, which version, how many of their graphs use it —
 * opens one in the editor, shares their own with the Playground (others may build on it, only
 * they may change it), and makes a new one in one of four ways: blank, a copy of one they may
 * build on, a layer file exported from Semantic Layers, or from the files of their data (Bring
 * your own data). Their quota of data models is shown, and New stops at it, saying why.
 */
import { useId, useState, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, CircleAlert, FileJson, Layers, Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useModalA11y } from '@/hooks/useModalA11y'
import { usePlayground } from '@/hooks/usePlayground'
import { Backdrop } from '@/components/ui/Backdrop'
import { Button } from '@/components/ui/Button'
import { useAppNotifications } from '@/components/ui/notifications'
import { ToggleSwitch } from '@/components/admin/AdminFeatures/ToggleSwitch'
import { useOntologies } from '@/features/ontology/hooks/useOntologies'
import { useOntologyMutations } from '@/features/ontology/hooks/useOntologyMutations'
import { playgroundService, type LayerSource, type PlaygroundModel, type PlaygroundModelKind } from '@/services/playgroundService'
import { layerRefusal } from './layerRefusal'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const FIELD = 'input bg-canvas border-black/10 dark:border-white/10'

const KIND_LABEL: Record<PlaygroundModelKind, string> = {
    approved: 'Approved', starter: 'Starter', sample: 'Sample', yours: 'Yours', shared: 'Shared',
}
const COPYABLE: PlaygroundModelKind[] = ['approved', 'starter', 'sample', 'shared']

export function YourDataModels({ className }: { className?: string }) {
    const { notify } = useAppNotifications()
    const queryClient = useQueryClient()
    const { invalidateAll } = useOntologyMutations()
    const info = usePlayground().data
    const models = useQuery({ queryKey: ['playground', 'models'], queryFn: () => playgroundService.listModels(), retry: false })
    // Whether one of the reader's own is shared is on the layer itself.
    const { data: layers } = useOntologies()
    const [creating, setCreating] = useState(false)
    const [sharing, setSharing] = useState<string | null>(null)

    if (!models.data) return null
    const listed = models.data.filter(m => m.kind === 'yours' || m.kind === 'shared')
    const quota = info?.layerQuota ?? 0
    const used = info?.layersUsed ?? listed.filter(m => m.kind === 'yours').length
    const full = quota > 0 && used >= quota
    const isShared = (id: string) => layers?.find(l => l.id === id)?.ownerVisibility === 'workspace'

    async function share(model: PlaygroundModel, next: boolean) {
        setSharing(model.id)
        try {
            await playgroundService.shareLayer(model.id, next)
            notify('success', next
                ? `“${model.name}” is shared with the Playground — others can build on it; only you can change it`
                : `Only you can see “${model.name}” now — graphs already built on it keep working`)
        } catch (e) {
            notify('error', `Couldn’t change who can use “${model.name}”: ${layerRefusal(e)}`)
        } finally {
            invalidateAll()
            void queryClient.invalidateQueries({ queryKey: ['playground'] })
            setSharing(null)
        }
    }

    return (
        <section aria-labelledby="data-models-title" className={className}>
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 id="data-models-title" className="text-sm font-semibold text-ink">Your data models</h3>
                    <p className="mt-0.5 text-xs text-ink-muted">
                        The types of things and connections a graph holds. Make your own, or copy one and change it.
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    {quota > 0 && (
                        <span className={cn('text-xs', full ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-ink-muted')}>
                            {used} of {quota} used
                        </span>
                    )}
                    <Button size="sm" variant="primary" leftIcon={Plus} disabled={full} onClick={() => setCreating(true)}>
                        New data model
                    </Button>
                </div>
            </div>
            {full && (
                <p className="mt-2 flex items-start gap-1.5 rounded-xl bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700 dark:text-amber-300">
                    <CircleAlert className="mt-px w-3.5 h-3.5 shrink-0" aria-hidden />
                    You’ve made all {quota} data models you may keep — delete one you’re done with to make another.
                </p>
            )}

            {listed.length === 0 ? (
                <p className="mt-3 rounded-2xl border border-dashed border-glass-border px-4 py-3 text-xs text-ink-muted">
                    No data models of your own yet. Each graph uses one; a new one starts as a draft you can change and publish.
                </p>
            ) : (
                <ul aria-label="Your data models" className="mt-3 grid gap-2 sm:grid-cols-2">
                    {listed.map(m => {
                        const own = m.kind === 'yours'
                        const shared = own && isShared(m.id)
                        return (
                            <li key={m.id} className="flex items-center gap-3 rounded-2xl border border-glass-border bg-canvas/60 p-3">
                                <span className="w-9 h-9 rounded-xl bg-violet-500/10 text-violet-600 dark:text-violet-300 flex items-center justify-center shrink-0">
                                    <Layers className="w-4 h-4" aria-hidden />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="flex items-center gap-1.5">
                                        <span data-model-name className="min-w-0 break-words text-sm font-semibold text-ink">{m.name}</span>
                                        <KindBadge kind={m.kind} />
                                    </span>
                                    <span className="block text-[11px] text-ink-muted">
                                        {m.isPublished ? 'Published' : 'Draft'} · v{m.version} · {m.usedBy ? `used by ${plural(m.usedBy, 'graph')}` : 'not used yet'}
                                        {!own && ' · read-only'}
                                    </span>
                                </span>
                                {own && (
                                    <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-ink-muted">
                                        <ToggleSwitch
                                            size="sm" checked={shared} disabled={sharing !== null}
                                            aria-label={`Share ${m.name} with the Playground`}
                                            onChange={next => void share(m, next)}
                                        />
                                        <span aria-hidden>{shared ? 'Shared' : 'Share'}</span>
                                    </span>
                                )}
                                <Link
                                    to={`/schema/${m.id}`}
                                    aria-label={`Open ${m.name} in the editor`}
                                    className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-violet-600 dark:text-violet-300 hover:bg-violet-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40"
                                >
                                    Open in editor <ArrowRight className="w-3.5 h-3.5" aria-hidden />
                                </Link>
                            </li>
                        )
                    })}
                </ul>
            )}
            {creating && <NewDataModelDialog models={models.data} onClose={() => setCreating(false)} />}
        </section>
    )
}

function KindBadge({ kind }: { kind: PlaygroundModelKind }) {
    return (
        <span className={cn(
            'shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold ring-1',
            kind === 'yours'
                ? 'bg-violet-500/10 text-violet-700 dark:text-violet-300 ring-violet-500/25'
                : kind === 'shared'
                    ? 'bg-sky-500/10 text-sky-700 dark:text-sky-300 ring-sky-500/25'
                    : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-500/25',
        )}>
            {KIND_LABEL[kind]}
        </span>
    )
}

type Way = 'blank' | 'copy' | 'import' | 'file'
const WAYS: { way: Way; title: string; detail: string }[] = [
    { way: 'blank', title: 'Blank', detail: 'Start empty and add your own types in the editor.' },
    { way: 'copy', title: 'Copy one you can use', detail: 'Start from an approved data model, a starter, a sample’s or one shared with you — then change it.' },
    { way: 'import', title: 'Import a layer file', detail: 'A JSON file exported from Semantic Layers, in any workspace.' },
    { way: 'file', title: 'From a file of your data', detail: 'Bring your own data: the types in your files become a data model of your own.' },
]

function NewDataModelDialog({ models, onClose }: { models: PlaygroundModel[]; onClose: () => void }) {
    const ref = useModalA11y(true, onClose)
    const navigate = useNavigate()
    const [, setParams] = useSearchParams()
    const queryClient = useQueryClient()
    const { invalidateAll } = useOntologyMutations()
    const ids = { title: useId(), name: useId(), file: useId() }
    const [way, setWay] = useState<Way>('blank')
    const [name, setName] = useState('')
    const [nameEdited, setNameEdited] = useState(false)
    const [copyOf, setCopyOf] = useState<PlaygroundModel | null>(null)
    const [layerFile, setLayerFile] = useState<{ fileName: string; layer: Record<string, unknown> } | null>(null)
    const [fileError, setFileError] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const copyable = models.filter(m => COPYABLE.includes(m.kind))

    const suggest = (next: string) => { if (!nameEdited) setName(next) }

    async function readLayerFile(e: ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0]
        e.target.value = ''
        if (!file) return
        setFileError(null)
        setLayerFile(null)
        try {
            const data: unknown = JSON.parse(await file.text())
            const defs = (data as { entityTypeDefinitions?: unknown } | null)?.entityTypeDefinitions
            if (!data || typeof data !== 'object' || Array.isArray(data) || !defs || typeof defs !== 'object') {
                setFileError(`${file.name} isn’t a layer file exported from Semantic Layers.`)
                return
            }
            const layer = data as Record<string, unknown>
            setLayerFile({ fileName: file.name, layer })
            if (typeof layer.name === 'string') suggest(layer.name.trim())
        } catch {
            setFileError(`${file.name} couldn’t be read as JSON.`)
        }
    }

    const from: LayerSource | null = way === 'blank' ? { blank: true }
        : way === 'copy' ? (copyOf ? { cloneOf: copyOf.id } : null)
        : way === 'import' ? (layerFile ? { layer: layerFile.layer } : null)
        : null
    const ready = way === 'file' || (!!from && !!name.trim())

    async function create() {
        if (way === 'file') {
            onClose()
            setParams(prev => { const next = new URLSearchParams(prev); next.set('start', 'import'); return next })
            return
        }
        if (!from || !name.trim()) return
        setBusy(true)
        setError(null)
        try {
            const made = await playgroundService.createLayer({ name: name.trim(), from })
            invalidateAll()
            void queryClient.invalidateQueries({ queryKey: ['playground'] })
            navigate(`/schema/${made.id}`)
        } catch (e) {
            setError(layerRefusal(e))
            setBusy(false)
        }
    }

    return createPortal(
        <>
            <Backdrop open onClick={onClose} zClassName="z-[60]" />
            <div className="fixed inset-0 z-[61] flex items-center justify-center p-3 sm:p-6 pointer-events-none">
                <div
                    ref={ref} role="dialog" aria-modal="true" aria-labelledby={ids.title} tabIndex={-1}
                    className="pointer-events-auto flex max-h-full w-full max-w-lg flex-col rounded-3xl border border-glass-border bg-canvas-elevated shadow-2xl outline-none"
                >
                    <div className="flex items-start gap-3 p-5 pb-3">
                        <span className="w-10 h-10 rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white flex items-center justify-center shadow-md shadow-violet-500/20 shrink-0">
                            <Layers className="w-5 h-5" aria-hidden />
                        </span>
                        <div className="min-w-0 flex-1">
                            <h2 id={ids.title} className="font-display text-lg font-bold text-ink">New data model</h2>
                            <p className="text-sm text-ink-secondary">Yours to change and publish. Only you see it until you share it.</p>
                        </div>
                        <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40">
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-4 custom-scrollbar">
                        <fieldset>
                            <legend className="text-xs font-semibold text-ink-secondary">How do you want to start?</legend>
                            <div className="mt-2 grid gap-2">
                                {WAYS.map(w => (
                                    <label key={w.way} className={cn(
                                        'flex cursor-pointer items-start gap-2.5 rounded-2xl border px-3 py-2.5 transition',
                                        way === w.way ? 'border-violet-500/50 bg-violet-500/[0.06]' : 'border-glass-border hover:border-violet-500/30',
                                    )}>
                                        <input type="radio" name="way" value={w.way} checked={way === w.way} onChange={() => { setWay(w.way); setError(null) }} className="mt-0.5 accent-violet-600" />
                                        <span className="min-w-0">
                                            <span className="block text-sm font-semibold text-ink">{w.title}</span>
                                            <span className="block text-xs text-ink-muted">{w.detail}</span>
                                        </span>
                                    </label>
                                ))}
                            </div>
                        </fieldset>

                        {way === 'copy' && (
                            <fieldset>
                                <legend className="text-xs font-semibold text-ink-secondary">Copy which?</legend>
                                {copyable.length === 0 ? (
                                    <p className="mt-2 text-xs text-ink-muted">There’s none you can copy yet.</p>
                                ) : (
                                    <div className="mt-2 max-h-48 space-y-1 overflow-y-auto custom-scrollbar">
                                        {copyable.map(m => (
                                            <label key={m.id} className="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
                                                <input type="radio" name="copyOf" value={m.id} checked={copyOf?.id === m.id}
                                                    onChange={() => { setCopyOf(m); suggest(`${m.name} (copy)`) }} className="accent-violet-600" />
                                                <span className="min-w-0 flex-1 truncate text-sm text-ink">{m.name}</span>
                                                <span className="shrink-0 text-[11px] text-ink-muted">{plural(m.entityTypeCount + m.relationshipTypeCount, 'type')}</span>
                                                <KindBadge kind={m.kind} />
                                            </label>
                                        ))}
                                    </div>
                                )}
                            </fieldset>
                        )}

                        {way === 'import' && (
                            <div>
                                <label htmlFor={ids.file} className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-xl border border-glass-border bg-canvas px-3 text-xs font-semibold text-ink shadow-sm hover:bg-black/[0.04] dark:hover:bg-white/[0.06] focus-within:ring-2 focus-within:ring-violet-500/40">
                                    <FileJson className="w-3.5 h-3.5" aria-hidden /> Choose a layer file
                                    <input id={ids.file} type="file" accept=".json,application/json" className="sr-only" onChange={readLayerFile} />
                                </label>
                                {layerFile && <p className="mt-1.5 text-xs text-ink-secondary">{layerFile.fileName}</p>}
                                {fileError && <p role="alert" className="mt-1.5 text-xs font-medium text-rose-600 dark:text-rose-400">{fileError}</p>}
                            </div>
                        )}

                        {way !== 'file' && (
                            <div>
                                <label htmlFor={ids.name} className="text-xs font-semibold text-ink-secondary">Name</label>
                                <input
                                    id={ids.name} value={name} placeholder="My data model"
                                    onChange={e => { setName(e.target.value); setNameEdited(true) }}
                                    className={cn(FIELD, 'mt-1 w-full')}
                                />
                            </div>
                        )}

                        {error && (
                            <p role="alert" className="flex items-start gap-1.5 rounded-xl bg-rose-500/10 px-3 py-2 text-xs font-medium text-rose-700 dark:text-rose-300">
                                <CircleAlert className="mt-px w-3.5 h-3.5 shrink-0" aria-hidden /> {error}
                            </p>
                        )}
                    </div>

                    <div className="flex items-center justify-end gap-2 border-t border-glass-border px-5 py-3">
                        <Button size="md" variant="ghost" onClick={onClose}>Cancel</Button>
                        <Button size="md" variant="primary" loading={busy} disabled={!ready} onClick={create}>
                            {way === 'file' ? 'Bring your own data' : 'Create and open'}
                        </Button>
                    </div>
                </div>
            </div>
        </>,
        document.body,
    )
}
