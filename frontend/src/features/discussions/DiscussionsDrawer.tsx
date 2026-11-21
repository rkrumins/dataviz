/**
 * DiscussionsDrawer — the questions about a view (or a data source), slid over from the right.
 *
 * The list (`DiscussionPanel`) or one thread (`ThreadView`), with Watch and Close in its header.
 * Esc steps back: out of the ask box, from a thread to the list, then closes; focus goes back to
 * whatever opened it. Full width on a phone.
 *
 * Mounted once in the app shell (`DiscussionsDrawerHost`) and opened through
 * `useDiscussionsDrawer`. House rules for a portaled overlay: the backdrop is always rendered and
 * only fades; the panel animates in and unmounts at once — never an exit animation, which is how
 * this app strands invisible click-blockers.
 */
import { useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { Bell, BellRing, MessageCircleQuestion, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MOTION } from '@/lib/motion'
import { Backdrop } from '@/components/ui/Backdrop'
import { HoverTip } from '@/components/ui/HoverTip'
import { useModalA11y } from '@/hooks/useModalA11y'
import { useConversationsEnabled, useThread, useWatch } from './useDiscussions'
import { showNodeOnCanvas, useDiscussionsDrawer, type DrawerTarget } from './drawerStore'
import { useAnchorStore } from './anchorStore'
import { DiscussionPanel } from './DiscussionPanel'
import { ThreadView } from './ThreadView'
import { subjectNoun } from './discussionText'

function WatchButton({ target }: { target: DrawerTarget }) {
    const { watching, ready, toggle, isPending } = useWatch(target.subject)
    const noun = subjectNoun(target.subject)
    return (
        <HoverTip className="inline-flex" label={watching ? `You hear about each new open question on ${noun}` : `Hear about each new open question on ${noun}`}
            detail={watching ? 'Click to stop' : 'In your Inbox, as they are asked'}>
            <button type="button" onClick={toggle} disabled={!ready || isPending} aria-pressed={watching}
                className={cn('inline-flex items-center gap-1.5 rounded-lg px-2.5 h-8 text-[12px] font-semibold transition-colors disabled:opacity-50',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                    watching ? 'bg-accent-lineage/10 text-accent-lineage hover:bg-accent-lineage/15' : 'text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5')}>
                {watching ? <BellRing className="w-3.5 h-3.5" aria-hidden /> : <Bell className="w-3.5 h-3.5" aria-hidden />}
                {watching ? 'Watching' : 'Watch'}
            </button>
        </HoverTip>
    )
}

export function DiscussionsDrawer({ target }: { target: DrawerTarget | null }) {
    const { close, showThread, setEntity, setCompose } = useDiscussionsDrawer.getState()
    const open = !!target
    // One callback for the drawer's whole life: the dialog hook re-arms (and re-focuses) when it changes.
    const stepBack = useCallback(() => {
        const t = useDiscussionsDrawer.getState().target
        if (t?.threadId) useDiscussionsDrawer.getState().showThread(null)
        else if (t?.compose) useDiscussionsDrawer.getState().setCompose(false)
        else useDiscussionsDrawer.getState().close()
    }, [])
    const panel = useModalA11y(open, stepBack)
    const thread = useThread(target?.threadId ?? null, { poll: false }).data
    const name = target?.subject.name || thread?.subject.name || null
    const onCanvas = useAnchorStore((s) => !!target && target.subject.type === 'view' && s.viewId === target.subject.id)

    return createPortal(
        <>
            <Backdrop open={open} onClick={close} zClassName="z-[70]" />
            {target && (
                <motion.aside
                    ref={panel}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="discussions-drawer-title"
                    tabIndex={-1}
                    initial={{ x: '100%' }}
                    animate={{ x: 0 }}
                    transition={MOTION.drawerSlide}
                    className="fixed right-0 top-0 bottom-0 z-[71] w-full sm:max-w-[34rem] bg-canvas-elevated border-l border-glass-border/70 shadow-2xl flex flex-col outline-none"
                >
                    <div className="flex items-center gap-3 px-5 py-3.5 border-b border-glass-border/70 shrink-0">
                        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-400/20 to-amber-500/10 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0 ring-1 ring-amber-500/20">
                            <MessageCircleQuestion className="w-4 h-4" aria-hidden />
                        </div>
                        <div className="min-w-0 flex-1">
                            <h2 id="discussions-drawer-title" className="text-sm font-bold text-ink truncate">Questions</h2>
                            {name && <p className="text-xs text-ink-muted truncate">{name}</p>}
                        </div>
                        <WatchButton target={target} />
                        <button type="button" onClick={close} aria-label="Close questions"
                            className="w-8 h-8 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                            <X className="w-4 h-4" aria-hidden />
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto custom-scrollbar">
                        {target.threadId ? (
                            <ThreadView key={target.threadId} threadId={target.threadId} focusMessageId={target.messageId}
                                onBack={() => showThread(null)} onDeleted={() => showThread(null)}
                                onShowOnCanvas={onCanvas ? showNodeOnCanvas : undefined} />
                        ) : (
                            <DiscussionPanel className="px-5 py-4" subject={target.subject}
                                entity={target.entity} onEntityChange={setEntity}
                                compose={target.compose} onComposeChange={setCompose} recipients={target.recipients}
                                onOpenThread={(id) => showThread(id)} />
                        )}
                    </div>
                </motion.aside>
            )}
        </>,
        document.body,
    )
}

/** The drawer, once for the whole app — nothing while the switch is off. */
export function DiscussionsDrawerHost() {
    const on = useConversationsEnabled()
    const target = useDiscussionsDrawer((s) => s.target)
    if (!on) return null
    return <DiscussionsDrawer target={target} />
}
