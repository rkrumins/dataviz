/**
 * The rail's header: who is answering, the persona switch (Ask about data · Help), what the next
 * question is about (the context chip — removable), the conversation history, and a new chat.
 */
import { useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { BookOpen, Database, Eye, FileText, History, MessagesSquare, Plus, SquarePen, Trash2, X } from 'lucide-react'
import { HoverTip } from '@/components/ui/HoverTip'
import { IconButton } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Segmented'
import { Skeleton } from '@/components/ui/Skeleton'
import { keyboardScopeProps } from '@/lib/keyboardScope'
import { queryClient } from '@/lib/queryClient'
import { formatShortcut } from '@/lib/platform'
import { timeAgo } from '@/lib/timeAgo'
import { cn } from '@/lib/utils'
import { AI_CONCEPTS_KEY, useConcepts, useConversations } from '../api/aiQueries'
import { aiService } from '../api/aiService'
import type { AssistantPersona } from '../api/types'
import { deleteConversation, openConversation, startNewChat } from '../lib/chatController'
import { pageName, type AssistantPageContext } from '../lib/useAssistantContext'
import { useAssistantStore } from '../store/assistantStore'
import { AssistantAvatar } from './MessageView'

const PERSONAS = [
    { value: 'data' as const, label: 'Ask about data', icon: Database },
    { value: 'help' as const, label: 'Help', icon: BookOpen },
]

export function AssistantHeader({ page, connectionName, personas, onClose }: {
    page: AssistantPageContext
    connectionName?: string | null
    /** Which personas an administrator has turned on. */
    personas?: { data: boolean; help: boolean }
    onClose: () => void
}) {
    const persona = useAssistantStore((s) => s.persona)
    const setPersona = useAssistantStore((s) => s.setPersona)
    const options = PERSONAS.map((p) => ({ ...p, disabled: personas ? personas[p.value] === false : false }))

    return (
        <div className="relative shrink-0 border-b border-glass-border">
            {/* The product's signature accent, as a hairline over the top edge. */}
            <div aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-accent-lineage to-violet-600" />
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-accent-lineage/5 to-transparent" />
            <div className="relative flex items-center gap-2.5 px-3.5 pb-2.5 pt-3.5">
                <AssistantAvatar />
                <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-semibold leading-tight text-ink">Assistant</h2>
                    <p className="truncate text-xs text-ink-muted">{connectionName ? `Answers by ${connectionName}` : 'Answers from your data and the guide'}</p>
                </div>
                <IconButton icon={SquarePen} label="New chat" size="sm" onClick={startNewChat} />
                <HistoryMenu dataSourceId={page.detached ? undefined : page.context.dataSourceId} />
                <IconButton icon={X} label="Close the assistant" size="sm" shortcut={formatShortcut('mod+j')} onClick={onClose} />
            </div>
            <div className="relative flex flex-col gap-2 px-3.5 pb-3">
                <Segmented<AssistantPersona> label="Who to ask" options={options} value={persona} onChange={setPersona} className="w-full [&>button]:flex-1 [&>button]:justify-center" />
                <ContextChip page={page} />
            </div>
        </div>
    )
}

/** What the next question is about — the view (and what is selected on it), or the page. */
function ContextChip({ page }: { page: AssistantPageContext }) {
    const detach = useAssistantStore((s) => s.detachContext)
    const attach = useAssistantStore((s) => s.attachContext)
    const name = page.view ? page.view.name ?? 'This view' : pageName(page.context.route ?? '')
    if (!name && !page.focus) return null

    if (page.detached) {
        return (
            <button type="button" onClick={attach}
                    className="inline-flex items-center gap-1 self-start rounded-full border border-dashed border-glass-border px-2.5 py-1 text-xs text-ink-muted transition-colors hover:border-accent-lineage/40 hover:text-accent-lineage focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                <Plus className="h-3 w-3" aria-hidden /> Ask about this page
            </button>
        )
    }

    const Glyph = page.view ? Eye : FileText
    const detail = page.selectedCount > 1 ? `${page.selectedCount} selected`
        : page.focus?.name ?? (page.selectedCount === 1 ? '1 selected' : null)
    return (
        <div className="flex min-w-0 items-center gap-1.5 self-start rounded-full border border-accent-lineage/25 bg-accent-lineage/5 py-0.5 pl-2.5 pr-1 text-xs">
            <Glyph className="h-3.5 w-3.5 shrink-0 text-accent-lineage" aria-hidden />
            <span className="min-w-0 truncate text-ink-secondary">
                {page.view ? 'View ' : ''}<span className="font-semibold text-ink">{name}</span>
                {detail && <span className="text-ink-muted"> · {detail}</span>}
            </span>
            <HoverTip label="Leave this out of the question" detail="The assistant then answers without knowing where you are">
                <button type="button" onClick={() => detach(page.pageKey)} aria-label="Remove this page from the question"
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-black/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 dark:hover:bg-white/10">
                    <X className="h-3 w-3" aria-hidden />
                </button>
            </HoverTip>
        </div>
    )
}

/**
 * The person's conversations, newest first — open one, or delete it — and the readings they asked
 * the assistant to remember for this data source, each of their own forgettable.
 */
function HistoryMenu({ dataSourceId }: { dataSourceId?: string }) {
    const [open, setOpen] = useState(false)
    const current = useAssistantStore((s) => s.conversationId)
    const { data, isLoading, isError } = useConversations(open)
    const items = data?.items ?? []
    const concepts = useConcepts(dataSourceId, open)

    return (
        <Popover.Root open={open} onOpenChange={setOpen}>
            <HoverTip label="Your conversations" detail="And the readings you asked it to remember" className="inline-flex">
                <Popover.Trigger asChild>
                    <button type="button" aria-label="Your conversations"
                            className={cn('inline-flex h-7 w-7 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-black/[0.05] hover:text-ink',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 dark:hover:bg-white/10',
                                open && 'bg-black/[0.06] text-ink dark:bg-white/10')}>
                        <History className="h-3.5 w-3.5" aria-hidden />
                    </button>
                </Popover.Trigger>
            </HoverTip>
            <Popover.Portal>
                <Popover.Content align="end" sideOffset={6} collisionPadding={12} aria-label="Your conversations"
                                 data-floating-layer="" {...keyboardScopeProps('ai-chat')}
                                 className="z-[70] flex max-h-[min(28rem,70vh)] w-[min(20rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl border border-glass-border bg-canvas-elevated shadow-2xl shadow-black/25">
                    <div className="border-b border-glass-border px-3 py-2 text-2xs font-semibold uppercase tracking-wider text-ink-muted">
                        Your conversations
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar p-1">
                        {isLoading && (
                            <div className="space-y-2 p-2">
                                <Skeleton className="h-4 w-4/5" /><Skeleton className="h-4 w-3/5" /><Skeleton className="h-4 w-2/3" />
                            </div>
                        )}
                        {isError && <p className="p-3 text-xs text-ink-muted">Your conversations couldn’t be loaded. Try again in a moment.</p>}
                        {!isLoading && !isError && items.length === 0 && (
                            <p className="flex items-center gap-2 p-3 text-xs text-ink-muted">
                                <MessagesSquare className="h-4 w-4" aria-hidden /> No conversations yet — what you ask is kept here.
                            </p>
                        )}
                        <ul>
                            {items.map((c) => (
                                <li key={c.id} className={cn('group flex items-center gap-1 rounded-lg pr-1 transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]',
                                    c.id === current && 'bg-accent-lineage/5')}>
                                    <button type="button"
                                            onClick={() => { setOpen(false); if (c.id !== current) void openConversation(c.id) }}
                                            aria-current={c.id === current ? 'true' : undefined}
                                            className="flex min-w-0 flex-1 items-start gap-2 rounded-lg px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                                        {c.persona === 'help'
                                            ? <BookOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden />
                                            : <Database className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-lineage" aria-hidden />}
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-sm text-ink">{c.title || 'Untitled conversation'}</span>
                                            <span className="block text-xs text-ink-muted">
                                                {timeAgo(c.updatedAt)} · {c.messageCount} {c.messageCount === 1 ? 'message' : 'messages'}
                                            </span>
                                        </span>
                                    </button>
                                    <IconButton icon={Trash2} label={`Delete “${c.title || 'Untitled conversation'}”`} size="sm" variant="danger" tip={false}
                                                onClick={() => void deleteConversation(c.id)}
                                                className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100" />
                                </li>
                            ))}
                        </ul>
                        {(concepts.data?.items ?? []).length > 0 && (
                            <>
                                <div className="mt-1 border-t border-glass-border px-2 pb-1 pt-2.5 text-2xs font-semibold uppercase tracking-wider text-ink-muted">
                                    Remembered readings
                                </div>
                                <ul>
                                    {concepts.data!.items.map((c) => (
                                        <li key={c.id} className="flex items-center gap-1 rounded-lg px-2 py-1.5 pr-1">
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate text-sm text-ink">
                                                    “{c.concept}” <span className="text-ink-muted">means</span> {c.label}
                                                </span>
                                                <span className="block text-xs text-ink-muted">
                                                    {c.scope === 'workspace' ? 'Everyone’s, set by an administrator' : 'Yours'}
                                                    {c.uses > 0 ? ` · used ${c.uses} ${c.uses === 1 ? 'time' : 'times'}` : ''}
                                                </span>
                                            </span>
                                            {c.scope === 'personal' && (
                                                <IconButton icon={X} label={`Forget what “${c.concept}” means`} size="sm" variant="danger" tip={false}
                                                            onClick={() => void aiService.deleteConcept(c.id).then(
                                                                () => queryClient.invalidateQueries({ queryKey: AI_CONCEPTS_KEY }), () => {})} />
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            </>
                        )}
                    </div>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    )
}
