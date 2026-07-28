/**
 * AdminSso — admin surface for the SSO configuration.
 *
 * A thin router over ``sso/tabs/``. Four tabs, each earning its place
 * against a job the operator actually has:
 *
 *   * Providers    — connect an IdP, rehearse it, publish it
 *   * Access mapping — turn their org chart into roles here
 *   * Diagnostics  — find a user, and read why a sign-in failed
 *   * Settings     — platform-wide sign-in posture
 *
 * Gated by RequirePermission perm="system:admin" in the route.
 */
import { useState } from 'react'
import { History, KeyRound, Plus, Power, Settings } from 'lucide-react'

import { PageContainer } from '@/components/layout/PageContainer'
import { DocsLink } from '@/components/help/DocsLink'
import { ProvidersTab } from './sso/tabs/ProvidersTab'
import { MappingsTab } from './sso/tabs/MappingsTab'
import { SettingsTab } from './sso/tabs/SettingsTab'
import { DiagnosticsTab } from './sso/tabs/DiagnosticsTab'

type Tab = 'providers' | 'mappings' | 'diagnostics' | 'settings'

const TABS: { id: Tab; label: string; icon: typeof Power }[] = [
    { id: 'providers', label: 'Providers', icon: Power },
    { id: 'mappings', label: 'Access mapping', icon: Plus },
    { id: 'diagnostics', label: 'Diagnostics', icon: History },
    { id: 'settings', label: 'Settings', icon: Settings },
]

export function AdminSso() {
    const [tab, setTab] = useState<Tab>('providers')
    return (
        <PageContainer gutter="shell" className="py-8 space-y-6">
            <header className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-semibold flex items-center gap-2">
                        <KeyRound className="w-6 h-6 text-accent-lineage" />
                        Single sign-on
                    </h1>
                    <p className="mt-1 text-sm text-ink-muted max-w-2xl">
                        Connect your company&apos;s identity provider, decide what
                        its groups grant here, and find out why a sign-in failed.
                    </p>
                </div>
                <DocsLink slug="sso-setup" variant="icon" />
            </header>

            <nav className="flex gap-2 border-b border-white/10">
                {TABS.map(({ id, label, icon: Icon }) => (
                    <button
                        key={id}
                        onClick={() => setTab(id)}
                        aria-current={tab === id ? 'page' : undefined}
                        className={
                            tab === id
                                ? 'px-4 py-2 text-sm font-medium border-b-2 border-accent-lineage text-ink flex items-center gap-1.5'
                                : 'px-4 py-2 text-sm text-ink-muted hover:text-ink flex items-center gap-1.5'
                        }
                    >
                        <Icon className="w-3.5 h-3.5" />
                        {label}
                    </button>
                ))}
            </nav>

            {tab === 'providers' && <ProvidersTab />}
            {tab === 'mappings' && <MappingsTab />}
            {tab === 'diagnostics' && <DiagnosticsTab />}
            {tab === 'settings' && <SettingsTab />}
        </PageContainer>
    )
}

export default AdminSso
