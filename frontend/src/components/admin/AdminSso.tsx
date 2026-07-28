/**
 * AdminSso — admin surface for the SSO configuration.
 *
 * A thin router over ``sso/tabs/``. Four tabs, each earning its place
 * against a job the operator actually has:
 *
 *   * Providers      — connect an IdP, rehearse it, publish it
 *   * Access mapping — turn their org chart into roles here
 *   * Diagnostics    — find a user, and read why a sign-in failed
 *   * Settings       — platform-wide sign-in posture
 *
 * The chrome deliberately matches Groups, Users, Permissions and Overview:
 * gradient tile and `text-3xl` heading with page actions on the right, a
 * row of stat tiles, then `border-b-2` tabs. This page had invented a
 * smaller header with no actions and no orientation row, which is most of
 * why it read as a different product from the section it sits in.
 *
 * The page owns the fetches the tiles need — providers, mappings and the
 * audit count — so each happens once here rather than once per tab, and
 * hands providers to the tab that would otherwise re-request them.
 *
 * Gated by RequirePermission perm="system:admin" in the route.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
    History, KeyRound, Plus, Power, RefreshCw, Settings, Waypoints,
} from 'lucide-react'

import { PageContainer } from '@/components/layout/PageContainer'
import { DocsLink } from '@/components/help/DocsLink'
import { usePermission } from '@/store/auth'
import { cn } from '@/lib/utils'
import { auditService } from '@/services/auditService'
import { ssoAdminService, type IdpProvider } from '@/services/ssoAdminService'
import { ProvidersTab } from './sso/tabs/ProvidersTab'
import { MappingsTab } from './sso/tabs/MappingsTab'
import { SettingsTab } from './sso/tabs/SettingsTab'
import { DiagnosticsTab } from './sso/tabs/DiagnosticsTab'
import { SsoStatTiles, type SsoStats } from './sso/SsoStatTiles'

type Tab = 'providers' | 'mappings' | 'diagnostics' | 'settings'

const TABS: { id: Tab; label: string; icon: typeof Power }[] = [
    { id: 'providers', label: 'Providers', icon: Power },
    { id: 'mappings', label: 'Access mapping', icon: Waypoints },
    { id: 'diagnostics', label: 'Diagnostics', icon: History },
    { id: 'settings', label: 'Settings', icon: Settings },
]

/** Live = what a person at the sign-in page can actually see. Mirrors
 *  `list_public_providers` server-side: enabled AND published. */
function liveCount(providers: IdpProvider[]): number {
    return providers.filter(p => p.enabled && p.lifecycle !== 'draft').length
}

export function AdminSso() {
    const [tab, setTab] = useState<Tab>('providers')
    const canReadAudit = usePermission('system:audit:read')

    const [providers, setProviders] = useState<IdpProvider[]>([])
    const [ruleCount, setRuleCount] = useState(0)
    const [failures, setFailures] = useState<number | null>(null)
    const [reloadToken, setReloadToken] = useState(0)
    const [refreshing, setRefreshing] = useState(false)
    const [wizardSignal, setWizardSignal] = useState(0)

    const loadStats = useCallback(async () => {
        setRefreshing(true)
        // allSettled, not all: each tile is independently non-fatal, so one
        // failed read shows a dash rather than blanking the row beside it.
        await Promise.allSettled([
            ssoAdminService.listProviders().then(setProviders),
            ssoAdminService.listGroupMappings().then(r => setRuleCount(r.length)),
            canReadAudit
                ? auditService.list({
                    category: 'sso',
                    fromTs: new Date(Date.now() - 24 * 3600_000).toISOString(),
                    limit: 100,
                }).then(r => setFailures(r.events.filter(
                    e => e.severity === 'critical' || e.severity === 'warning',
                ).length))
                : Promise.resolve(setFailures(null)),
        ])
        setRefreshing(false)
    }, [canReadAudit])

    useEffect(() => { void loadStats() }, [loadStats, reloadToken])

    const stats = useMemo<SsoStats>(() => ({
        live: liveCount(providers),
        drafts: providers.filter(p => p.lifecycle === 'draft').length,
        rules: ruleCount,
        failures24h: failures,
    }), [providers, ruleCount, failures])

    const refresh = useCallback(() => setReloadToken(t => t + 1), [])

    return (
        <PageContainer gutter="shell" className="py-8 animate-in fade-in duration-500">
            <header className="flex items-start justify-between gap-4 mb-8">
                <div className="flex items-center gap-3 min-w-0">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-md shadow-violet-500/20 shrink-0">
                        <KeyRound className="w-6 h-6 text-white" />
                    </div>
                    <div className="min-w-0">
                        <h1 className="text-3xl font-bold tracking-tight text-ink">
                            Single sign-on
                        </h1>
                        <p className="text-sm text-ink-muted mt-1">
                            Connect your company&apos;s identity provider, decide what
                            its groups grant here, and find out why a sign-in failed.
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <button
                        onClick={() => {
                            setTab('providers')
                            setWizardSignal(n => n + 1)
                        }}
                        className="px-4 py-2 rounded-xl font-medium text-sm text-white bg-accent-lineage hover:brightness-110 transition-colors duration-150 flex items-center gap-2 shadow-sm shadow-accent-lineage/20"
                    >
                        <Plus className="w-4 h-4" />
                        Connect a provider
                    </button>
                    <button
                        onClick={refresh}
                        disabled={refreshing}
                        className="px-4 py-2 border border-glass-border bg-canvas-elevated hover:bg-black/5 dark:hover:bg-white/5 rounded-xl font-medium text-sm text-ink transition-colors flex items-center gap-2 disabled:opacity-50"
                    >
                        <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} />
                        Refresh
                    </button>
                    <DocsLink slug="sso-setup" variant="icon" />
                </div>
            </header>

            <SsoStatTiles stats={stats} />

            <nav className="flex items-center gap-1 border-b border-glass-border mb-6">
                {TABS.map(({ id, label, icon: Icon }) => {
                    const active = tab === id
                    return (
                        <button
                            key={id}
                            onClick={() => setTab(id)}
                            aria-current={active ? 'page' : undefined}
                            className={cn(
                                'flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-colors duration-150 border-b-2',
                                active
                                    ? 'border-violet-500 text-violet-600 dark:text-violet-400'
                                    : 'border-transparent text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 rounded-t-xl',
                            )}
                        >
                            <Icon className="w-4 h-4" />
                            {label}
                        </button>
                    )
                })}
            </nav>

            {tab === 'providers' && (
                <ProvidersTab openWizardSignal={wizardSignal} onChanged={refresh} />
            )}
            {tab === 'mappings' && <MappingsTab onChanged={refresh} />}
            {tab === 'diagnostics' && <DiagnosticsTab />}
            {tab === 'settings' && <SettingsTab providers={providers} />}
        </PageContainer>
    )
}

export default AdminSso
