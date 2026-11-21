/**
 * Administration → AI — the assistant's model connections, what it may send
 * them, what it can look things up in, the vocabulary people taught it, and
 * how it is used.
 *
 * The chrome is SSO's (and the rest of the section's): gradient tile and
 * `text-3xl` heading with the page actions on the right, a row of stat tiles,
 * then `border-b-2` tabs. The tiles read the same React Query caches the tabs
 * do, so each list is fetched once.
 *
 * Gated in the route by the `ai` admin section (system:admin) and the
 * `aiAssistantEnabled` switch.
 */
import { useState } from 'react'
import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query'
import {
    BarChart3, BookA, BookOpenText, Plug, Plus, RefreshCw, SlidersHorizontal, Sparkles,
} from 'lucide-react'
import { PageContainer } from '@/components/layout/PageContainer'
import { DocsLink } from '@/components/help/DocsLink'
import { Button } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { aiAdminService, AI_ADMIN_KEYS } from '@/services/aiAdminService'
import { SsoCard } from '@/components/admin/sso/ui/SsoCard'
import { AiStatTiles, type AiStats, type AiTab } from './AiStatTiles'
import { ConnectionsTab } from './connections/ConnectionsTab'
import { AssistantTab } from './assistant/AssistantTab'
import { KnowledgeTab } from './knowledge/KnowledgeTab'
import { VocabularyTab } from './vocabulary/VocabularyTab'
import { UsageTab } from './usage/UsageTab'

const TABS: { id: AiTab; label: string; icon: typeof Plug }[] = [
    { id: 'connections', label: 'Connections', icon: Plug },
    { id: 'assistant', label: 'Assistant', icon: SlidersHorizontal },
    { id: 'knowledge', label: 'Knowledge', icon: BookOpenText },
    { id: 'vocabulary', label: 'Business vocabulary', icon: BookA },
    { id: 'usage', label: 'Usage', icon: BarChart3 },
]

export function AdminAi() {
    const [tab, setTab] = useState<AiTab>('connections')
    const [adding, setAdding] = useState(false)
    const qc = useQueryClient()
    const refreshing = useIsFetching({ queryKey: AI_ADMIN_KEYS.all }) > 0

    const connectionsQ = useQuery({ queryKey: AI_ADMIN_KEYS.connections, queryFn: aiAdminService.listConnections })
    const settingsQ = useQuery({ queryKey: AI_ADMIN_KEYS.settings, queryFn: aiAdminService.getSettings })
    const usageQ = useQuery({ queryKey: AI_ADMIN_KEYS.usage, queryFn: () => aiAdminService.usage(30) })
    const knowledgeQ = useQuery({ queryKey: AI_ADMIN_KEYS.knowledge, queryFn: aiAdminService.knowledge })

    const stats: AiStats = {
        connections: connectionsQ.data ? connectionsQ.data.filter(c => c.enabled).length : null,
        questions: usageQ.data ? usageQ.data.days.reduce((n, d) => n + d.requests, 0) : null,
        unhelpful: usageQ.data ? usageQ.data.feedback.down : null,
        collectionsReady: knowledgeQ.data ? knowledgeQ.data.collections.filter(c => c.status === 'ready').length : null,
    }
    const notAnswering = settingsQ.data && !settingsQ.data.chatConnectionId

    return (
        <PageContainer gutter="shell" className="py-8 animate-in fade-in duration-500">
            <header className="flex items-start justify-between gap-4 mb-8">
                <div className="flex items-center gap-3 min-w-0">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-md shadow-violet-500/20 shrink-0">
                        <Sparkles className="w-6 h-6 text-white" />
                    </div>
                    <div className="min-w-0">
                        <h1 className="text-3xl font-bold tracking-tight text-ink">AI assistant</h1>
                        <p className="text-sm text-ink-muted mt-1">
                            Connect a language model, decide what it may see, and follow how people use it.
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <button
                        onClick={() => { setTab('connections'); setAdding(true) }}
                        className="px-4 py-2 rounded-xl font-medium text-sm text-white bg-accent-lineage hover:brightness-110 transition-colors duration-150 flex items-center gap-2 shadow-sm shadow-accent-lineage/20"
                    >
                        <Plus className="w-4 h-4" />
                        Add a connection
                    </button>
                    <button
                        onClick={() => { void qc.invalidateQueries({ queryKey: AI_ADMIN_KEYS.all }) }}
                        disabled={refreshing}
                        className="px-4 py-2 border border-glass-border bg-canvas-elevated hover:bg-black/5 dark:hover:bg-white/5 rounded-xl font-medium text-sm text-ink transition-colors flex items-center gap-2 disabled:opacity-50"
                    >
                        <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} />
                        Refresh
                    </button>
                    <DocsLink slug="ai-assistant" variant="icon" />
                </div>
            </header>

            <AiStatTiles stats={stats} onSelect={setTab} />

            {notAnswering && (
                <SsoCard
                    tone="info"
                    icon={Sparkles}
                    title="The assistant is not answering yet"
                    blurb={connectionsQ.data?.length
                        ? 'Choose the connection that answers questions under Assistant. Until then nothing is sent to any model.'
                        : 'Add a connection to a model, then choose it under Assistant. Until then nothing is sent to any model.'}
                    actions={connectionsQ.data?.length
                        ? <Button size="sm" variant="secondary" onClick={() => setTab('assistant')}>Choose a connection</Button>
                        : <Button size="sm" variant="secondary" leftIcon={Plus} onClick={() => { setTab('connections'); setAdding(true) }}>Add a connection</Button>}
                    className="mb-6"
                />
            )}

            <nav className="flex items-center gap-1 border-b border-glass-border mb-6 overflow-x-auto">
                {TABS.map(({ id, label, icon: Icon }) => {
                    const active = tab === id
                    return (
                        <button
                            key={id}
                            onClick={() => setTab(id)}
                            aria-current={active ? 'page' : undefined}
                            className={cn(
                                'flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-colors duration-150 border-b-2 whitespace-nowrap',
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

            {tab === 'connections' && <ConnectionsTab adding={adding} onAddingChange={setAdding} />}
            {tab === 'assistant' && <AssistantTab />}
            {tab === 'knowledge' && <KnowledgeTab />}
            {tab === 'vocabulary' && <VocabularyTab />}
            {tab === 'usage' && <UsageTab />}
        </PageContainer>
    )
}

export default AdminAi
