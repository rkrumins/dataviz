/**
 * GraphSettingsSummary — on a data source's Versioning tab, the settings that matter most to its
 * owner: what readers see while new data loads, whether the graph stays in memory, what imports
 * find existing items by and whether a replace that would wipe most of the graph is stopped, and
 * which drafts people may make. Each with the value in force; where that is the value chosen, where
 * it was chosen (this graph, this workspace, the platform, the deployment or the default); where it
 * isn't, what was chosen, where, and why it isn't in force. Then how many values the graph sets
 * itself, and "Open settings" for every one of them, in the graph's settings drawer (loaded when
 * first asked for).
 *
 * Every value is the server's, from the graph's settings (`GET …/graphs/{id}/settings`), named by
 * the registry it serves; they aren't refreshed while the drawer is open, where they may be staged.
 * A fork has none of its own (409 `follows_root`): it says so, and what its imports match by, which
 * on a fork can differ from its root's. Under the identifier, the properties the graph's imports
 * match by and how far each one's index is caught up.
 */
import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react'
import { GitFork, RotateCw, SlidersHorizontal } from 'lucide-react'
import { formatCount } from '@/lib/units'
import { useUnsavedChangesWarning } from '@/hooks/useUnsavedChangesWarning'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { formatValue, sameValue } from '@/components/settings/format'
import { StatusBadge } from '@/components/settings/StatusBadge'
import type { ResolvedSetting, Setting } from '@/components/settings/types'
import { identifierLabel } from '@/features/import-export/identifier'
import { useImportSettings } from '@/features/import-export/useImportSettings'
import type { ImportSettingSource, ImportSettings } from '@/services/importExportApiService'
import { settingsError, useSettingsSchema, useSettingsValues, type SettingsPlace } from '@/services/settingsService'
import { SUMMARY_KEYS } from '../model/settingWords'
import { SourceChip } from './SettingSource'

/** On a fork, where its imports' identifier came from, as the import settings say it: its root's own is `data_source`. */
const FORK_IMPORT_SOURCE_WORDS: Record<ImportSettingSource, string> = {
    data_source: 'The graph it follows', workspace: 'This workspace', platform: 'The platform', fork: 'This fork',
}

const loadDrawer = () => import('@/components/admin/AdminVersionedGraphs/GraphSettingsDrawer')
const GraphSettingsDrawer = lazy(() => loadDrawer().then((m) => ({ default: m.GraphSettingsDrawer })))

/** The properties a graph's imports match by, and how far each one's index is caught up. */
function MatchingProperties({ imports }: { imports: ImportSettings }) {
    const props = imports.matchingProperties
    return (
        <p className="text-[11.5px] leading-relaxed text-ink-secondary">
            {props.length === 0
                ? 'No property indexed for matching yet.'
                : <>Indexed for matching: {props.map((p, i) => (
                    <span key={p.name}>
                        {i > 0 && ', '}<span className="font-mono text-ink">{p.name}</span>
                        {' '}({p.status === 'building' ? 'indexing' : p.current ? 'up to date' : 'catches up on the next import'})
                    </span>
                ))}.</>}
            {' '}{formatCount(props.length, 'property')} of {formatCount(imports.maxMatchingProperties)} at most.
        </p>
    )
}

/**
 * One setting: its name and the value in force. Chosen where it came from, it says where; held
 * back, it says what was chosen and where, and why it isn't in force.
 */
function Item({ setting: s, resolved: r, children }: { setting: Setting; resolved: ResolvedSetting; children?: ReactNode }) {
    const choice = s.kind === 'choice' ? s.choices.find((c) => c.id === r.effective) : undefined
    // A choice's short line, where it says more than its title ("Coldline": "Loaded only when needed").
    const more = choice && !choice.title.toLowerCase().includes(choice.short.toLowerCase()) ? choice.short : null
    const chosen = r.declared !== null && !sameValue(r.declared, r.effective) ? formatValue(s, r.declared) : null
    const why = r.status !== 'in_effect' ? r.why[0]?.text : undefined
    return (
        <div className="min-w-0">
            <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-secondary">{s.label}</dt>
            <dd className="mt-1 space-y-1">
                <p className="text-[13px] font-semibold leading-snug text-ink">
                    {formatValue(s, r.effective)}
                    {more && <span className="font-normal text-ink-secondary"> · {more}</span>}
                </p>
                <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-secondary">
                    {chosen && <span>Chosen: {chosen}</span>}
                    <SourceChip source={r.source} />
                    {r.status !== 'in_effect' && <StatusBadge status={r.status} />}
                </div>
                {why && <p className="text-[11.5px] leading-snug text-amber-800 dark:text-amber-300">{why}</p>}
                {children}
            </dd>
        </div>
    )
}

export function GraphSettingsSummary({ wsId, graphId, label }: {
    wsId: string
    graphId: string
    /** The data source's name, for the drawer's title. */
    label?: string
}) {
    const place: SettingsPlace = useMemo(() => ({ scope: 'graph', workspaceId: wsId, graphId }), [wsId, graphId])
    const [opened, setOpened] = useState(false)
    const [open, setOpen] = useState(false)
    // What the drawer has staged: a reload or a closed tab asks first (closing the drawer asks itself).
    const [staged, setStaged] = useState(0)
    useUnsavedChangesWarning(staged > 0)
    const schemaQ = useSettingsSchema()
    // The drawer reads the same values and may have changes staged over them: no refresh meanwhile.
    const valuesQ = useSettingsValues(place, { staged: () => open })
    const importsQ = useImportSettings(wsId, graphId)
    const openSettings = () => { setOpened(true); setOpen(true) }

    const error = valuesQ.error ? settingsError(valuesQ.error) : schemaQ.error ? settingsError(schemaQ.error) : null
    const fork = error?.type === 'follows_root'
    const byKey = useMemo(() => Object.fromEntries((schemaQ.data?.settings ?? []).map((s) => [s.key, s])), [schemaQ.data])
    const values = valuesQ.data?.values
    const own = values ? Object.values(values).filter((r) => r.trail.some((t) => t.scope === 'graph' && t.value !== null)).length : 0
    const imports = importsQ.data

    let body: ReactNode
    if (fork) {
        const ident = imports?.effective.identifier
        const from = imports?.effective.sources.identifier
        body = (
            <div className="space-y-3">
                <p className="flex items-start gap-2 text-[13px] leading-relaxed text-ink-secondary">
                    <GitFork aria-hidden className="mt-0.5 w-4 h-4 shrink-0 text-ink-secondary" />
                    <span>This graph is a fork, so it has no settings of its own: it follows those of the graph it was forked from. Open its settings to see them.</span>
                </p>
                {ident && from && (
                    <dl>
                        <div className="min-w-0">
                            <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-secondary">{byKey['imports.identifier']?.label ?? 'Match rows by'}</dt>
                            <dd className="mt-1 space-y-1">
                                <p className="text-[13px] font-semibold text-ink">{identifierLabel(ident)}</p>
                                <span className="inline-flex items-center gap-1 rounded-md bg-black/[0.05] px-1.5 py-px text-[11px] font-medium leading-4 text-ink-secondary dark:bg-white/[0.07]">
                                    <GitFork aria-hidden className="w-3 h-3 shrink-0" />
                                    <span><span className="sr-only">From </span>{FORK_IMPORT_SOURCE_WORDS[from]}</span>
                                </span>
                                {from === 'fork' && <p className="text-[11.5px] text-ink-secondary">A fork can’t match by a property yet, so its imports match by Entity ID.</p>}
                            </dd>
                        </div>
                    </dl>
                )}
            </div>
        )
    } else if (error) {
        body = (
            <div role="alert" className="flex flex-wrap items-center gap-3">
                <p className="min-w-0 flex-1 text-[12.5px] text-rose-700 dark:text-rose-300">Couldn’t read this graph’s settings: {error.message}</p>
                <Button size="sm" variant="secondary" leftIcon={RotateCw}
                    onClick={() => { void (valuesQ.error ? valuesQ.refetch() : schemaQ.refetch()) }}>
                    Try again
                </Button>
            </div>
        )
    } else if (!values || !schemaQ.data) {
        body = (
            <div aria-busy="true" aria-label="Loading this graph’s settings" className="grid gap-4 sm:grid-cols-2">
                {SUMMARY_KEYS.map((k) => <Skeleton key={k} className="h-14 rounded-lg" />)}
            </div>
        )
    } else {
        body = (
            <>
                <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                    {SUMMARY_KEYS.map((k) => byKey[k] && values[k] && (
                        <Item key={k} setting={byKey[k]} resolved={values[k]}>
                            {k === 'imports.identifier' && imports && <MatchingProperties imports={imports} />}
                        </Item>
                    ))}
                </dl>
                <p className="mt-4 border-t border-glass-border/60 pt-3 text-[12px] text-ink-secondary">
                    <span className="font-semibold text-ink">{own === 0 ? 'No value set for this graph' : `${formatCount(own, 'value')} set for this graph`}</span>
                    {' · '}Values it doesn’t set come from its workspace, then the platform.
                </p>
            </>
        )
    }

    return (
        <section aria-labelledby={`settings-summary-${graphId}`}>
            <div className="mb-2 flex items-center justify-between gap-2">
                <h4 id={`settings-summary-${graphId}`} className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary">
                    <SlidersHorizontal aria-hidden className="w-3.5 h-3.5" /> Settings
                </h4>
                <Button size="sm" variant="secondary" leftIcon={SlidersHorizontal} onClick={openSettings}
                    onPointerEnter={() => void loadDrawer()} onFocus={() => void loadDrawer()}>
                    Open settings
                </Button>
            </div>
            <div className="rounded-xl border border-glass-border bg-canvas-elevated/40 p-4">{body}</div>
            {opened && (
                <Suspense fallback={null}>
                    <GraphSettingsDrawer workspaceId={wsId} graphId={graphId} open={open} onOpenChange={setOpen} label={label} onStagedChange={setStaged} />
                </Suspense>
            )}
        </section>
    )
}
