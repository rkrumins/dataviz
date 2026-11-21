/**
 * BringYourOwnData — "Bring your own data", in the Playground.
 *
 * A sample shows what a graph is for; this makes one of the reader's own. They start from a
 * template (or their own spreadsheet), drop the files here, and see what will be made before
 * anything is sent: how many things and connections, of which types, which column is which —
 * and every row that would be refused, by file and line. Create sends it as JSON
 * (`POST /playground/imports`), and their new graph opens on its Context View.
 *
 * Files are read in this browser (`ownData.ts`); the server never takes a file.
 */
import { useId, useMemo, useState, type DragEvent } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import {
    ArrowLeftRight, CircleAlert, Download, FileJson, FileSpreadsheet, Loader2, Sparkles, UploadCloud, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useModalA11y } from '@/hooks/useModalA11y'
import { useImportOwnData } from '@/hooks/usePlayground'
import { useAppNotifications } from '@/components/ui/notifications'
import { Backdrop } from '@/components/ui/Backdrop'
import { triggerBrowserDownload } from '@/services/importExportApiService'
import {
    OWN_DATA_LIMITS, TEMPLATE_FILES, connectionsFromCsv, guessConnectionColumns, guessThingColumns, looksLikeConnections,
    parseCsv, parseOwnDataJson, propertyColumns, summarize, thingsFromCsv, validateOwnData,
    type ConnectionColumns, type CsvTable, type OwnDataFile, type RowError, type ThingColumns,
} from './ownData'

/** A file larger than this is far past what the Playground takes. */
const MAX_BYTES = 20 * 1024 * 1024
/** Rows to fix shown at once; the rest are counted. */
const SHOWN = 8
/** A field that stands out from the dialog it sits on, in either theme. */
const FIELD = 'input bg-canvas border-black/10 dark:border-white/10'

const TEMPLATES: { file: keyof typeof TEMPLATE_FILES; what: string; type: string }[] = [
    { file: 'things.csv', what: 'Things', type: 'text/csv' },
    { file: 'connections.csv', what: 'Connections', type: 'text/csv' },
    { file: 'example.json', what: 'Both, as JSON', type: 'application/json' },
]

const THING_FIELDS: { field: keyof ThingColumns; label: string; aria: string; required?: boolean }[] = [
    { field: 'key', label: 'Key', aria: 'Key', required: true },
    { field: 'type', label: 'Type', aria: 'Type of thing', required: true },
    { field: 'name', label: 'Name', aria: 'Thing name' },
    { field: 'description', label: 'Description', aria: 'Description' },
    { field: 'tags', label: 'Tags', aria: 'Tags' },
]
const CONNECTION_FIELDS: { field: keyof ConnectionColumns; label: string; aria: string }[] = [
    { field: 'from', label: 'From', aria: 'From' },
    { field: 'type', label: 'Type', aria: 'Type of connection' },
    { field: 'to', label: 'To', aria: 'To' },
]

interface CsvFile { fileName: string; table: CsvTable }

const n = (count: number) => count.toLocaleString('en-US')
const plural = (count: number, one: string, many = `${one}s`) => `${n(count)} ${count === 1 ? one : many}`
/** "my-things.csv" → "my things": a name to start from. */
const nameFromFile = (fileName: string) => fileName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim().slice(0, OWN_DATA_LIMITS.name)

/** A refusal, in words a person can act on. */
function refusal(e: unknown): string {
    const { status, detail } = (e ?? {}) as { status?: number; detail?: { type?: string; message?: string } }
    switch (detail?.type) {
        case 'playground_quota':
        case 'quota_reached': return 'You’ve used all your graphs — delete one you’re done with, then try again.'
        case 'import_load_failed': return 'The graph couldn’t be loaded just now, and nothing was kept. Try again in a moment.'
        case 'feature_disabled': return 'Bringing your own data is turned off right now. An administrator turns it on with the Playground, Version control and Build lineage from scratch switches.'
        case 'playground_not_member': return 'Join the Playground first — open it from the sidebar — then try again.'
        case 'too_large': return `That’s more than the Playground takes: up to ${n(OWN_DATA_LIMITS.things)} things and ${n(OWN_DATA_LIMITS.connections)} connections.`
    }
    if (status === 413) return refusal({ detail: { type: 'too_large' } })
    return (e instanceof Error && e.message) || 'Couldn’t make the graph. Try again in a moment.'
}

export function BringYourOwnData({ workspaceId, onClose, quotaLeft }: {
    workspaceId: string
    /** Keep it stable: the dialog's focus handling follows it. */
    onClose: () => void
    /** How many more graphs the reader may start, when known. */
    quotaLeft?: number
}) {
    const ref = useModalA11y(true, onClose)
    const navigate = useNavigate()
    const { notify } = useAppNotifications()
    const create = useImportOwnData(workspaceId)
    const ids = { title: useId(), input: useId(), name: useId(), description: useId() }

    const [json, setJson] = useState<{ fileName: string; data: OwnDataFile } | null>(null)
    const [thingsCsv, setThingsCsv] = useState<CsvFile | null>(null)
    const [connectionsCsv, setConnectionsCsv] = useState<CsvFile | null>(null)
    const [thingCols, setThingCols] = useState<ThingColumns>(() => guessThingColumns([]))
    const [connectionCols, setConnectionCols] = useState<ConnectionColumns>(() => guessConnectionColumns([]))
    const [fileErrors, setFileErrors] = useState<string[]>([])
    const [name, setName] = useState('')
    const [nameEdited, setNameEdited] = useState(false)
    const [description, setDescription] = useState('')
    const [dragging, setDragging] = useState(false)
    /** What the server refused, until the files or the columns change. */
    const [server, setServer] = useState<{ rows: RowError[]; message: string | null } | null>(null)

    const full = quotaLeft !== undefined && quotaLeft <= 0
    const loaded = !!json || !!thingsCsv || !!connectionsCsv

    const putCsv = (role: 'things' | 'connections', f: CsvFile | null) => {
        if (role === 'things') {
            setThingsCsv(f)
            if (f) setThingCols(guessThingColumns(f.table.headers))
        } else {
            setConnectionsCsv(f)
            if (f) setConnectionCols(guessConnectionColumns(f.table.headers))
        }
    }

    const addFiles = async (files: File[]) => {
        const errors: string[] = []
        for (const f of files) {
            if (f.size > MAX_BYTES) {
                errors.push(`${f.name}: over 20 MB — far more than the Playground takes.`)
                continue
            }
            try {
                const text = await f.text()
                if (/\.json$/i.test(f.name) || f.type === 'application/json') {
                    const data = parseOwnDataJson(text)
                    setJson({ fileName: f.name, data })
                    setThingsCsv(null)
                    setConnectionsCsv(null)
                    if (!nameEdited) setName(data.name ?? nameFromFile(f.name))
                    if (data.description && !description) setDescription(data.description.slice(0, OWN_DATA_LIMITS.description))
                } else {
                    const table = parseCsv(text)
                    if (!table.headers.length) throw new Error('This file is empty.')
                    setJson(null)
                    const role = looksLikeConnections(table.headers) ? 'connections' : 'things'
                    putCsv(role, { fileName: f.name, table })
                    if (role === 'things' && !nameEdited) setName(nameFromFile(f.name))
                }
            } catch (e) {
                errors.push(`${f.name}: ${e instanceof Error ? e.message : 'couldn’t be read.'}`)
            }
        }
        setFileErrors(errors)
        setServer(null)
    }

    // Swap a CSV between things and connections (when its columns were guessed wrong).
    const swap = () => {
        const [t, c] = [thingsCsv, connectionsCsv]
        putCsv('things', c)
        putCsv('connections', t)
        setServer(null)
    }

    const { things, connections, where } = useMemo(() => {
        if (json) {
            return {
                things: json.data.things, connections: json.data.connections,
                where: (e: RowError) => `${json.fileName}, ${e.section === 'things' ? 'thing' : 'connection'} ${e.index + 1}`,
            }
        }
        const lineOf = (f: CsvFile | null, i: number) => f?.table.rows[i]?.line
        return {
            things: thingsCsv ? thingsFromCsv(thingsCsv.table, thingCols) : [],
            connections: connectionsCsv ? connectionsFromCsv(connectionsCsv.table, connectionCols) : [],
            where: (e: RowError) => {
                const f = e.section === 'things' ? thingsCsv : connectionsCsv
                return f ? `${f.fileName}, line ${lineOf(f, e.index) ?? e.index + 2}` : `${e.section}, row ${e.index + 1}`
            },
        }
    }, [json, thingsCsv, connectionsCsv, thingCols, connectionCols])
    const check = useMemo(() => validateOwnData(things, connections), [things, connections])
    const summary = useMemo(() => summarize(things, connections), [things, connections])
    const toFix = server?.rows.length ? server.rows : check.rows
    const nameOk = name.trim().length > 0 && name.trim().length <= OWN_DATA_LIMITS.name
    const ready = loaded && !check.rows.length && !check.issues.length && nameOk && !full

    const submit = () => {
        if (!ready || create.isPending) return
        const body = {
            name: name.trim(), things, connections,
            ...(description.trim() ? { description: description.trim() } : {}),
        }
        setServer(null)
        create.mutate(body, {
            onSuccess: (made) => {
                notify('success', `“${body.name}” is ready — ${plural(things.length, 'thing')} and ${plural(connections.length, 'connection')}. Explore it, then change it in a draft.`)
                onClose()
                navigate(`/views/${made.viewId}`)
            },
            onError: (e) => {
                const d = (e as { detail?: { type?: string; errors?: RowError[] } }).detail
                setServer(d?.type === 'invalid_rows' && d.errors?.length
                    ? { rows: d.errors, message: null }
                    : { rows: [], message: refusal(e) })
            },
        })
    }

    const download = (t: (typeof TEMPLATES)[number]) => {
        const url = URL.createObjectURL(new Blob([TEMPLATE_FILES[t.file]], { type: `${t.type};charset=utf-8` }))
        triggerBrowserDownload(url, t.file)
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
    }

    const onDrop = (e: DragEvent) => {
        e.preventDefault()
        setDragging(false)
        void addFiles(Array.from(e.dataTransfer.files))
    }

    const csvLoaded = !json && (thingsCsv || connectionsCsv)
    const props = thingsCsv ? propertyColumns(thingsCsv.table.headers, thingCols) : []
    const loadedFiles: { key: string; fileName: string; what: string; icon: typeof FileJson; onRemove: () => void }[] = [
        ...(json ? [{ key: 'json', fileName: json.fileName, what: `${plural(json.data.things.length, 'thing')} · ${plural(json.data.connections.length, 'connection')}`, icon: FileJson, onRemove: () => setJson(null) }] : []),
        ...(thingsCsv ? [{ key: 'things', fileName: thingsCsv.fileName, what: `Things · ${plural(thingsCsv.table.rows.length, 'row')}`, icon: FileSpreadsheet, onRemove: () => setThingsCsv(null) }] : []),
        ...(connectionsCsv ? [{ key: 'connections', fileName: connectionsCsv.fileName, what: `Connections · ${plural(connectionsCsv.table.rows.length, 'row')}`, icon: FileSpreadsheet, onRemove: () => setConnectionsCsv(null) }] : []),
    ]

    return createPortal(
        <>
            <Backdrop open onClick={onClose} zClassName="z-[60]" />
            <div className="fixed inset-0 z-[61] flex items-center justify-center p-3 sm:p-6 pointer-events-none">
                <div
                    ref={ref}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={ids.title}
                    tabIndex={-1}
                    className="pointer-events-auto flex max-h-full w-full max-w-2xl flex-col rounded-3xl border border-glass-border bg-canvas-elevated shadow-2xl outline-none"
                >
                    <div className="flex items-start gap-3 p-5 pb-3 sm:p-6 sm:pb-4">
                        <span className="w-10 h-10 rounded-2xl bg-gradient-to-br from-sky-500 to-violet-500 text-white flex items-center justify-center shadow-md shadow-sky-500/20 shrink-0">
                            <UploadCloud className="w-5 h-5" aria-hidden />
                        </span>
                        <div className="min-w-0 flex-1">
                            <h2 id={ids.title} className="font-display text-lg font-bold text-ink">Bring your own data</h2>
                            <p className="text-sm text-ink-secondary">
                                A graph of your own things and how they connect. Your files are read here, in your browser — nothing is sent until you create it.
                            </p>
                        </div>
                        <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40">
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-4 sm:px-6 custom-scrollbar">
                        {full && (
                            <p className="flex items-start gap-1.5 rounded-xl bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700 dark:text-amber-300">
                                <CircleAlert className="mt-px w-3.5 h-3.5 shrink-0" aria-hidden />
                                You’ve used all your graphs — delete one you’re done with to make room for this one.
                            </p>
                        )}

                        <Step n={1} title="Start from a template" hint="Fill it in with your own rows, or try it as it is.">
                            <ul aria-label="Templates" className="grid gap-2 sm:grid-cols-3">
                                {TEMPLATES.map(t => (
                                    <li key={t.file}>
                                        <button
                                            type="button"
                                            onClick={() => download(t)}
                                            className="group flex w-full items-center gap-2.5 rounded-2xl border border-glass-border bg-canvas/60 px-3 py-2.5 text-left transition hover:border-violet-500/40 hover:shadow-md hover:shadow-violet-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40"
                                        >
                                            <span className="flex w-8 h-8 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-600 dark:text-violet-300">
                                                {t.file.endsWith('.json') ? <FileJson className="w-4 h-4" aria-hidden /> : <FileSpreadsheet className="w-4 h-4" aria-hidden />}
                                            </span>
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate text-xs font-semibold text-ink">{t.file}</span>
                                                <span className="block text-[11px] text-ink-muted">{t.what}</span>
                                            </span>
                                            <Download className="w-3.5 h-3.5 shrink-0 text-ink-muted group-hover:text-violet-500" aria-hidden />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </Step>

                        <Step n={2} title="Add your files" hint="Things and connections as two CSV files, or both in one JSON file.">
                            <div
                                onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
                                onDragLeave={() => setDragging(false)}
                                onDrop={onDrop}
                                className={cn(
                                    'flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-4 py-6 text-center transition',
                                    dragging ? 'border-violet-500 bg-violet-500/[0.06]' : 'border-black/15 dark:border-white/15 bg-canvas/40',
                                )}
                            >
                                <UploadCloud className={cn('w-7 h-7', dragging ? 'text-violet-500' : 'text-ink-muted')} aria-hidden />
                                <p className="text-sm font-semibold text-ink">Drop your CSV or JSON files here</p>
                                <label
                                    htmlFor={ids.input}
                                    className="inline-flex h-8 cursor-pointer items-center rounded-xl border border-glass-border bg-canvas-elevated px-3 text-xs font-semibold text-ink shadow-sm hover:bg-black/[0.04] dark:hover:bg-white/[0.06] focus-within:ring-2 focus-within:ring-violet-500/40"
                                >
                                    or choose them
                                    <input
                                        id={ids.input}
                                        type="file"
                                        multiple
                                        accept=".csv,.json,.txt,text/csv,application/json"
                                        aria-label="Choose files"
                                        className="sr-only"
                                        onChange={(e) => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = '' }}
                                    />
                                </label>
                                <p className="text-[11px] text-ink-muted">
                                    Up to {n(OWN_DATA_LIMITS.things)} things, {n(OWN_DATA_LIMITS.connections)} connections and {OWN_DATA_LIMITS.types} types.
                                </p>
                            </div>
                            {fileErrors.length > 0 && (
                                <div role="alert" className="mt-2 space-y-1 rounded-xl bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                                    {fileErrors.map(e => <p key={e}>{e}</p>)}
                                </div>
                            )}
                            {loadedFiles.length > 0 && (
                                <ul aria-label="Your files" className="mt-2 space-y-1.5">
                                    {loadedFiles.map(f => (
                                        <li key={f.key} className="flex items-center gap-2.5 rounded-xl border border-glass-border bg-canvas/60 px-3 py-2">
                                            <f.icon className="w-4 h-4 shrink-0 text-violet-500" aria-hidden />
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate text-xs font-semibold text-ink">{f.fileName}</span>
                                                <span className="block text-[11px] text-ink-muted">{f.what}</span>
                                            </span>
                                            {f.key !== 'json' && (
                                                <button type="button" onClick={swap} title="Read it as the other kind of file"
                                                    aria-label={`Read ${f.fileName} as ${f.key === 'things' ? 'connections' : 'things'}`}
                                                    className="rounded-lg p-1.5 text-ink-muted hover:bg-violet-500/10 hover:text-violet-700 dark:hover:text-violet-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40">
                                                    <ArrowLeftRight className="w-3.5 h-3.5" aria-hidden />
                                                </button>
                                            )}
                                            <button type="button" onClick={() => { f.onRemove(); setServer(null) }} aria-label={`Remove ${f.fileName}`}
                                                className="rounded-lg p-1.5 text-ink-muted hover:bg-black/5 hover:text-ink dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40">
                                                <X className="w-3.5 h-3.5" aria-hidden />
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </Step>

                        {csvLoaded && (
                            <Step n={3} title="Match your columns" hint="Guessed from the headers — change any that’s wrong.">
                                <div className="grid gap-3 sm:grid-cols-2">
                                    {thingsCsv && (
                                        <fieldset className="rounded-2xl border border-black/[0.07] bg-canvas/60 p-3 dark:border-white/10">
                                            <legend className="px-1 text-xs font-semibold text-ink">Things <span className="font-normal text-ink-muted">· {thingsCsv.fileName}</span></legend>
                                            <div className="grid grid-cols-2 gap-2">
                                                {THING_FIELDS.map(f => (
                                                    <ColumnSelect key={f.field} label={f.label} aria={f.aria} required={f.required}
                                                        headers={thingsCsv.table.headers} value={thingCols[f.field]}
                                                        onChange={(v) => { setThingCols(c => ({ ...c, [f.field]: v })); setServer(null) }} />
                                                ))}
                                            </div>
                                            <p className="mt-2 text-[11px] text-ink-muted">
                                                {props.length
                                                    ? <>Other columns become properties: <span className="font-medium text-ink-secondary">{props.join(', ')}</span></>
                                                    : 'Every column is matched — none are left to become properties.'}
                                            </p>
                                        </fieldset>
                                    )}
                                    {connectionsCsv && (
                                        <fieldset className="rounded-2xl border border-black/[0.07] bg-canvas/60 p-3 dark:border-white/10">
                                            <legend className="px-1 text-xs font-semibold text-ink">Connections <span className="font-normal text-ink-muted">· {connectionsCsv.fileName}</span></legend>
                                            <div className="grid grid-cols-2 gap-2">
                                                {CONNECTION_FIELDS.map(f => (
                                                    <ColumnSelect key={f.field} label={f.label} aria={f.aria} required
                                                        headers={connectionsCsv.table.headers} value={connectionCols[f.field]}
                                                        onChange={(v) => { setConnectionCols(c => ({ ...c, [f.field]: v })); setServer(null) }} />
                                                ))}
                                            </div>
                                            <p className="mt-2 text-[11px] text-ink-muted">From and To name things by their key.</p>
                                        </fieldset>
                                    )}
                                </div>
                            </Step>
                        )}

                        {loaded && (
                            <section aria-label="Preview" aria-live="polite" className="rounded-2xl border border-violet-500/20 bg-gradient-to-br from-violet-500/[0.06] via-transparent to-fuchsia-500/[0.05] p-4">
                                <p className="flex items-center gap-1.5 text-xs font-semibold text-ink-secondary">
                                    <Sparkles className="w-3.5 h-3.5 text-fuchsia-500" aria-hidden /> What you’ll get
                                </p>
                                <div className="mt-2 grid grid-cols-3 gap-2">
                                    <Stat value={things.length} label={things.length === 1 ? 'thing' : 'things'} />
                                    <Stat value={connections.length} label={connections.length === 1 ? 'connection' : 'connections'} />
                                    <Stat value={summary.thingTypes.length + summary.connectionTypes.length} label="types" />
                                </div>
                                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                                    <TypeList label="Things by type" rows={summary.thingTypes} tone="bg-violet-500" />
                                    <TypeList label="Connections by type" rows={summary.connectionTypes} tone="bg-fuchsia-500" />
                                </div>
                                <p className="mt-3 text-[11px] text-ink-muted">
                                    Each type becomes part of this graph’s own data model. You get a Context View and a Graph view, ready to explore.
                                </p>
                            </section>
                        )}

                        {loaded && (toFix.length > 0 || check.issues.length > 0) && (
                            <section aria-label="Rows to fix" className="rounded-2xl border border-rose-500/25 bg-rose-500/[0.05] p-4">
                                <p className="flex items-center gap-1.5 text-xs font-semibold text-rose-700 dark:text-rose-300">
                                    <CircleAlert className="w-3.5 h-3.5" aria-hidden />
                                    {server?.rows.length
                                        ? `The Playground couldn’t take ${plural(server.rows.length, 'row')} — fix them and try again`
                                        : toFix.length ? `${plural(toFix.length, 'row')} to fix before you create it` : 'Before you create it'}
                                </p>
                                <ul className="mt-2 space-y-1 text-xs">
                                    {check.issues.map(i => <li key={i} className="text-ink">{i}</li>)}
                                    {toFix.slice(0, SHOWN).map(e => (
                                        <li key={`${e.section}:${e.index}:${e.field}:${e.message}`} className="flex flex-wrap gap-x-1.5">
                                            <span className="font-semibold text-ink">{where(e)}</span>
                                            <span className="text-ink-muted">· {e.field}:</span>
                                            <span className="text-ink-secondary">{e.message}</span>
                                        </li>
                                    ))}
                                </ul>
                                {toFix.length > SHOWN && <p className="mt-1 text-[11px] text-ink-muted">…and {n(toFix.length - SHOWN)} more.</p>}
                            </section>
                        )}

                        <Step n={csvLoaded ? 4 : 3} title="Name it">
                            <div className="space-y-3">
                                <label htmlFor={ids.name} className="block">
                                    <span className="text-xs font-semibold text-ink-secondary">Name</span>
                                    <input id={ids.name} value={name} maxLength={OWN_DATA_LIMITS.name} required
                                        onChange={(e) => { setName(e.target.value); setNameEdited(true) }}
                                        placeholder="e.g. Coffee shop sales" className={cn(FIELD, 'mt-1')} />
                                </label>
                                <label htmlFor={ids.description} className="block">
                                    <span className="text-xs font-semibold text-ink-secondary">Description <span className="font-normal text-ink-muted">· optional</span></span>
                                    <textarea id={ids.description} value={description} maxLength={OWN_DATA_LIMITS.description} rows={2}
                                        onChange={(e) => setDescription(e.target.value)}
                                        placeholder="What it shows, and where the data comes from" className={cn(FIELD, 'mt-1 resize-none')} />
                                </label>
                            </div>
                        </Step>

                        {server?.message && (
                            <p role="alert" className="flex items-start gap-1.5 rounded-xl bg-rose-500/10 px-3 py-2 text-xs font-medium text-rose-700 dark:text-rose-300">
                                <CircleAlert className="mt-px w-3.5 h-3.5 shrink-0" aria-hidden /> {server.message}
                            </p>
                        )}
                    </div>

                    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-glass-border px-5 py-4 sm:px-6">
                        <p className="mr-auto w-full text-[11px] text-ink-muted sm:w-auto">
                            Counts as one of your graphs{quotaLeft !== undefined && quotaLeft > 0 ? ` · ${quotaLeft} left` : ''}
                        </p>
                        <button type="button" onClick={onClose}
                            className="h-9 rounded-xl px-3.5 text-sm font-semibold text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40">
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={submit}
                            disabled={!ready || create.isPending}
                            aria-busy={create.isPending || undefined}
                            className="inline-flex h-9 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold text-white bg-gradient-to-r from-violet-500 to-fuchsia-500 shadow-md shadow-violet-500/25 hover:brightness-110 disabled:opacity-50 disabled:shadow-none disabled:hover:brightness-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50"
                        >
                            {create.isPending && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
                            {create.isPending ? 'Creating…' : 'Create graph'}
                        </button>
                    </div>
                </div>
            </div>
        </>,
        document.body,
    )
}

function Step({ n: num, title, hint, children }: { n: number; title: string; hint?: string; children: React.ReactNode }) {
    return (
        <section>
            <div className="mb-2 flex items-start gap-2">
                <span className="mt-px inline-flex w-5 h-5 shrink-0 items-center justify-center rounded-full bg-violet-500/10 text-[11px] font-bold text-violet-600 dark:text-violet-300" aria-hidden>{num}</span>
                <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-ink">{title}</h3>
                    {hint && <p className="text-[11px] text-ink-muted">{hint}</p>}
                </div>
            </div>
            {children}
        </section>
    )
}

function ColumnSelect({ label, aria, required, headers, value, onChange }: {
    label: string
    aria: string
    required?: boolean
    headers: string[]
    value: string | null
    onChange: (column: string | null) => void
}) {
    // Named by `aria` alone: "Name" and "Description" are also the graph's own fields below.
    return (
        <div className="min-w-0">
            <span className="text-[11px] font-semibold text-ink-secondary" aria-hidden>
                {label}{required && <span className="text-rose-500"> *</span>}
            </span>
            <select aria-label={aria} aria-required={required || undefined} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}
                className={cn(FIELD, 'mt-0.5 py-1.5 text-xs')}>
                <option value="">{required ? 'Choose a column…' : 'None'}</option>
                {headers.filter(Boolean).map(h => <option key={h} value={h}>{h}</option>)}
            </select>
        </div>
    )
}

function Stat({ value, label }: { value: number; label: string }) {
    return (
        <p className="rounded-xl border border-black/[0.07] bg-canvas-elevated px-3 py-2 dark:border-white/10">
            <span className="block text-lg font-bold tabular-nums leading-tight text-ink">{n(value)}</span>{' '}
            <span className="block text-[11px] text-ink-muted">{label}</span>
        </p>
    )
}

function TypeList({ label, rows, tone }: { label: string; rows: [string, number][]; tone: string }) {
    const top = rows[0]?.[1] ?? 0
    return (
        <div className="min-w-0">
            <p className="mb-1 text-[11px] font-semibold text-ink-secondary">{label}</p>
            {rows.length === 0 ? (
                <p className="text-[11px] text-ink-muted">None yet</p>
            ) : (
                <ul aria-label={label} className="space-y-1">
                    {rows.slice(0, 6).map(([type, count]) => (
                        <li key={type} className="flex items-center gap-2 text-xs">
                            <span className="min-w-0 flex-1 truncate text-ink">{type}</span>
                            <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]" aria-hidden>
                                <span className={cn('block h-full rounded-full', tone)} style={{ width: `${Math.max(8, (count / top) * 100)}%` }} />
                            </span>
                            <span className="w-10 shrink-0 text-right font-semibold tabular-nums text-ink-secondary">{n(count)}</span>
                        </li>
                    ))}
                    {rows.length > 6 && <li className="text-[11px] text-ink-muted">and {rows.length - 6} more</li>}
                </ul>
            )}
        </div>
    )
}
