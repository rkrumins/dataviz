/**
 * Everything about one key, beside the list: who it is and where it came
 * from, what it can reach right now, and how it has been used.
 *
 * The owner's page and the administrators' inventory open the same drawer;
 * the admin variant adds whose key it is. The page supplies the actions,
 * because what someone may do with a key depends on who is looking.
 *
 * Escape closes only the top layer: while a dialog is open over the drawer
 * (`layered`), the drawer stops listening, so one press closes the dialog
 * and the next the drawer.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
    Activity, ArrowRight, Ban, ExternalLink, KeySquare, MapPin, Network, ShieldCheck, Sparkles, X,
} from 'lucide-react'

import { Backdrop } from '@/components/ui/Backdrop'
import { CopyButton } from '@/components/ui/CopyButton'
import { DateTime } from '@/components/ui/DateTime'
import { PersonChip } from '@/components/ui/PersonChip'
import { Skeleton } from '@/components/ui/Skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { useModalA11y } from '@/hooks/useModalA11y'
import { MOTION } from '@/lib/motion'
import { cn } from '@/lib/utils'
import type { AdminApiKey, ApiKey, ApiKeyDetail, KeyRef } from '@/services/apiKeyService'
import { AccessMatrix } from './AccessMatrix'
import { KeyChips } from './KeyCard'
import { LifetimeBar } from './LifetimeBar'
import { UsagePanel } from './UsagePanel'
import { describeLastUsed, describeRevocation } from './apiKeyFormat'
import { KeyStatusBadge } from './parts'

type Tab = 'overview' | 'access' | 'usage'

export function KeyDetailDrawer({ apiKey, variant, load, layered = false, onClose, actions, onOpenKey }: {
    /** The key's list row, shown at once while the rest loads. Null: closed. */
    apiKey: ApiKey | AdminApiKey | null
    variant: 'owner' | 'admin'
    load: (id: string) => Promise<ApiKeyDetail>
    /** A dialog is open over the drawer: Escape is the dialog's. */
    layered?: boolean
    /** Stable (memoised): the drawer's keyboard handling re-binds when it changes. */
    onClose: () => void
    actions?: React.ReactNode
    /** Jump to the key this one replaced, or that replaced it. */
    onOpenKey?: (ref: KeyRef) => void
}) {
    const open = apiKey !== null
    const panelRef = useModalA11y(open && !layered, onClose)
    return createPortal(
        <>
            <Backdrop open={open} onClick={onClose} zClassName="z-[60]" className="bg-black/40" />
            <div className="fixed inset-0 z-[61] pointer-events-none">
                <AnimatePresence>
                    {apiKey && (
                        <motion.div
                            key="api-key-drawer"
                            ref={panelRef}
                            tabIndex={-1}
                            role="dialog"
                            aria-modal="true"
                            aria-label={`API key “${apiKey.name}”`}
                            initial={{ x: '100%' }}
                            animate={{ x: 0 }}
                            exit={{ x: '100%' }}
                            transition={MOTION.drawerSlide}
                            className="pointer-events-auto absolute right-0 top-0 h-full w-full max-w-xl bg-canvas-elevated border-l border-black/[0.08] dark:border-white/[0.08] shadow-2xl flex flex-col outline-none"
                        >
                            <DrawerBody
                                key={apiKey.id}
                                apiKey={apiKey}
                                variant={variant}
                                load={load}
                                onClose={onClose}
                                actions={actions}
                                onOpenKey={onOpenKey}
                            />
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </>,
        document.body,
    )
}

function DrawerBody({ apiKey, variant, load, onClose, actions, onOpenKey }: {
    apiKey: ApiKey | AdminApiKey
    variant: 'owner' | 'admin'
    load: (id: string) => Promise<ApiKeyDetail>
    onClose: () => void
    actions?: React.ReactNode
    onOpenKey?: (ref: KeyRef) => void
}) {
    const [tab, setTab] = useState<Tab>('overview')
    const [detail, setDetail] = useState<ApiKeyDetail | null>(null)
    const [failed, setFailed] = useState<string | null>(null)
    useEffect(() => {
        let live = true
        load(apiKey.id)
            .then((d) => { if (live) setDetail(d) })
            .catch((err: unknown) => { if (live) setFailed(err instanceof Error ? err.message : 'It could not be loaded.') })
        return () => { live = false }
    }, [apiKey.id, load])

    // A rename in place reaches the row, not the detail loaded before it.
    const key = detail ? { ...detail, name: apiKey.name, description: apiKey.description } : apiKey
    const owner = 'owner' in apiKey ? apiKey.owner : null

    return (
        <>
            <header className="px-5 sm:px-6 pt-5 pb-4 border-b border-black/[0.07] dark:border-white/[0.08] shrink-0">
                <div className="flex items-start gap-3.5">
                    <span className="w-11 h-11 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white flex items-center justify-center shrink-0 shadow-md shadow-indigo-500/20">
                        <KeySquare className="w-5 h-5" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">API key</p>
                        <h2 className="text-lg font-bold text-ink truncate">{key.name}</h2>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                            <KeyStatusBadge apiKey={key} />
                            <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
                                <code className="font-mono">{key.prefix}…</code>
                                <CopyButton value={key.prefix} label="Copy the key’s prefix" className="p-0.5" />
                            </span>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors shrink-0"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>
                {variant === 'admin' && owner && (
                    <div className="mt-4 flex items-center gap-3 p-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.04]">
                        <div className="min-w-0 flex-1">
                            <PersonChip id={owner.id} person={owner} size="md" showEmail caption="Acts as them" />
                        </div>
                        {/* What was done with it, and what happened to it — refusals included. */}
                        <a
                            href={`/admin/audit?act_key=${encodeURIComponent(key.id)}&act_days=365`}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/10 shrink-0"
                        >
                            Its activity <ExternalLink className="w-3 h-3" aria-hidden />
                        </a>
                    </div>
                )}
            </header>

            <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="flex-1 min-h-0 flex flex-col">
                <div className="px-5 sm:px-6 pt-4 shrink-0">
                    <TabsList>
                        <TabsTrigger value="overview" icon={Sparkles}>Overview</TabsTrigger>
                        <TabsTrigger value="access" icon={ShieldCheck}>Access</TabsTrigger>
                        <TabsTrigger value="usage" icon={Activity}>Usage</TabsTrigger>
                    </TabsList>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto px-5 sm:px-6 py-5">
                    {failed && !detail && (
                        <p role="alert" className="mb-4 p-3 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] text-xs text-rose-700 dark:text-rose-300">
                            {failed}
                        </p>
                    )}
                    <TabsContent value="overview">
                        <Overview apiKey={key} detail={detail} variant={variant} onOpenKey={onOpenKey} />
                    </TabsContent>
                    <TabsContent value="access">
                        <p className="text-xs text-ink-muted mb-4 leading-relaxed">
                            What it can do right now: {variant === 'owner' ? 'your' : 'its owner’s'} access today,
                            narrowed by the key. It changes as {variant === 'owner' ? 'yours' : 'theirs'} does.
                        </p>
                        {detail ? <AccessMatrix access={detail.effectiveAccess} /> : <Loading />}
                    </TabsContent>
                    <TabsContent value="usage">
                        {detail ? <UsagePanel days={detail.usageDays} /> : <Loading />}
                    </TabsContent>
                </div>
            </Tabs>

            {actions && (
                <footer className="flex flex-wrap items-center justify-end gap-2 px-5 sm:px-6 py-4 border-t border-black/[0.07] dark:border-white/[0.08] bg-black/[0.015] dark:bg-white/[0.02] shrink-0">
                    {actions}
                </footer>
            )}
        </>
    )
}

function Loading() {
    return (
        <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-10 rounded-xl" />
            <Skeleton className="h-10 rounded-xl" />
        </div>
    )
}

function Overview({ apiKey: key, detail, variant, onOpenKey }: {
    apiKey: ApiKey
    detail: ApiKeyDetail | null
    variant: 'owner' | 'admin'
    onOpenKey?: (ref: KeyRef) => void
}) {
    const used = describeLastUsed(key)
    return (
        <div className="space-y-6">
            {key.description && (
                <p className="text-sm text-ink-secondary leading-relaxed border-l-2 border-indigo-500/40 pl-3">
                    {key.description}
                </p>
            )}

            {key.revokedAt && (
                <div className="p-3.5 rounded-xl border border-black/[0.07] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.03]">
                    <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                        <Ban className="w-4 h-4 text-ink-muted" aria-hidden />
                        {describeRevocation(key, variant)} · <DateTime at={key.revokedAt} />
                    </p>
                    {key.revokedNote && (
                        <p className="mt-1.5 text-xs text-ink-secondary leading-relaxed">“{key.revokedNote}”</p>
                    )}
                </div>
            )}

            <Section title="Lifetime">
                <LifetimeBar apiKey={key} />
            </Section>

            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
                <Fact label="Created">
                    <DateTime at={key.createdAt} />
                    {key.createdIp && <span className="block text-[11px] text-ink-muted">from {key.createdIp}</span>}
                </Fact>
                <Fact label="Last used">
                    <DateTime at={key.lastUsedAt} empty="Never used" />
                    {used.where && (
                        <span className="flex items-center gap-1 text-[11px] text-ink-muted">
                            <MapPin className="w-3 h-3 shrink-0" aria-hidden /> {used.where}
                        </span>
                    )}
                </Fact>
            </dl>

            <Section title="What it may do">
                <KeyChips apiKey={key} />
            </Section>

            {key.allowedCidrs.length > 0 && (
                <Section title="Networks">
                    <ul className="flex flex-wrap gap-1.5">
                        {key.allowedCidrs.map((c) => (
                            <li key={c} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-mono bg-indigo-500/[0.07] text-indigo-700 dark:text-indigo-300 border border-indigo-500/20">
                                <Network className="w-3 h-3" aria-hidden /> {c}
                            </li>
                        ))}
                    </ul>
                    <p className="mt-2 text-[11px] text-ink-muted">Calls from anywhere else are refused.</p>
                </Section>
            )}

            {detail && (detail.replaces || detail.replacedBy) && (
                <Section title="Rotation">
                    <div className="space-y-2">
                        {detail.replaces && <KeyLink label="Replaces" target={detail.replaces} onOpen={onOpenKey} />}
                        {detail.replacedBy && <KeyLink label="Replaced by" target={detail.replacedBy} onOpen={onOpenKey} />}
                    </div>
                </Section>
            )}
        </div>
    )
}

function KeyLink({ label, target, onOpen }: { label: string; target: KeyRef; onOpen?: (ref: KeyRef) => void }) {
    const body = (
        <>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted w-20 shrink-0">{label}</span>
            <span className="min-w-0 flex-1 text-left">
                <span className="block text-sm font-medium text-ink truncate">{target.name}</span>
                <code className="text-[11px] font-mono text-ink-muted">{target.prefix}…</code>
            </span>
            {onOpen && <ArrowRight className="w-4 h-4 text-ink-muted shrink-0" aria-hidden />}
        </>
    )
    const cls = 'w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl border border-black/[0.07] dark:border-white/[0.08]'
    return onOpen ? (
        <button type="button" onClick={() => onOpen(target)} className={cn(cls, 'hover:border-indigo-500/40 transition-colors')}>
            {body}
        </button>
    ) : <div className={cls}>{body}</div>
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section>
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-2">{title}</h3>
            {children}
        </section>
    )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="min-w-0">
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-1">{label}</dt>
            <dd className="text-sm font-medium text-ink">{children}</dd>
        </div>
    )
}
