/**
 * The assistant's bubble, bottom right on every page while the assistant is switched on and a
 * model is connected. It opens the rail — which pushes the page over rather than covering it —
 * and is gone while the rail is open.
 *
 * - **Where.** At the export tray's tier (`z-40`): under drawers, dialogs, notifications and the
 *   tour's offer. It sits above whatever docks in that corner — the canvas dock, a trace — and
 *   publishes its own height (`--assistant-launcher-height`) so the export tray and the
 *   notifications start above it, and the canvas's own corner furniture (the minimap, the legend)
 *   steps up out of its way. Withdrawn when it goes. Never taller than the screen leaves room for.
 * - **What it says.** Hovered or focused, it opens into a pill — "Ask about Supply chain ⌘J".
 *   A dot when an answer finished while the rail was closed; a quiet ring while one is still
 *   being written (still, under reduced motion).
 * - **No blur, no portal**: it is page chrome in the corner, not an overlay.
 */
import { useRef } from 'react'
import { Bot } from 'lucide-react'
import { HoverTip } from '@/components/ui/HoverTip'
import { Kbd } from '@/components/ui/Kbd'
import { useViewportReservation } from '@/components/canvas/context-view/useBandReservation'
import { isApplePlatform } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { useAiAvailable } from '../api/aiQueries'
import { useAssistantContext } from '../lib/useAssistantContext'
import { ASSISTANT_SHORTCUT } from '../lib/useAssistantShortcut'
import { useAssistantStore } from '../store/assistantStore'

/** Above the canvas dock and a trace; never so high it leaves the screen. */
const BOTTOM = 'min(calc(1.5rem + var(--canvas-dock-height, 0px) + var(--canvas-trace-height, 0px)), calc(100% - 8rem))'

export function AssistantLauncher() {
    const available = useAiAvailable()
    const open = useAssistantStore((s) => s.open)
    if (!available || open) return null
    return <Bubble />
}

function Bubble() {
    const ref = useRef<HTMLDivElement>(null)
    useViewportReservation(ref, '--assistant-launcher-height')
    const unread = useAssistantStore((s) => s.unread)
    const streaming = useAssistantStore((s) => {
        const last = s.turns[s.turns.length - 1]
        return last?.role === 'assistant' && last.status === 'streaming'
    })
    const page = useAssistantContext()
    const name = page.detached ? null : page.label

    return (
        <div ref={ref} className="fixed right-6 z-40" style={{ bottom: BOTTOM }}>
            <HoverTip
                className="flex"
                label={unread ? 'A new answer is ready' : streaming ? 'Still writing your answer' : 'Opens beside the page, so nothing is covered'}
                detail="It knows where you are, and reads only what you can see"
            >
                <button
                    type="button"
                    onClick={() => useAssistantStore.getState().openAssistant()}
                    aria-label={unread ? 'Open the assistant — a new answer is ready' : 'Open the assistant'}
                    aria-keyshortcuts={isApplePlatform() ? 'Meta+J' : 'Control+J'}
                    className={cn(
                        'group relative flex h-[52px] items-center rounded-full text-white',
                        'bg-gradient-to-br from-accent-lineage to-violet-600 shadow-lg shadow-accent-lineage/30',
                        // A hairline of light round the edge, so it reads as one object on a dark canvas too.
                        'before:pointer-events-none before:absolute before:inset-0 before:rounded-full before:ring-1 before:ring-inset before:ring-white/20',
                        'transition-shadow hover:shadow-xl hover:shadow-accent-lineage/40',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
                        'animate-in fade-in zoom-in-90 duration-200',
                    )}
                >
                    {/* The pill's words, opening leftward so the glyph stays under the pointer. */}
                    <span className="grid grid-cols-[0fr] transition-[grid-template-columns] duration-200 ease-out group-hover:grid-cols-[1fr] group-focus-visible:grid-cols-[1fr]">
                        <span className="min-w-0 overflow-hidden">
                            <span className="flex items-center gap-2 whitespace-nowrap pl-4 text-sm font-medium">
                                <span className="max-w-[14rem] truncate">{name ? `Ask about ${name}` : 'Ask the assistant'}</span>
                                <Kbd shortcut={ASSISTANT_SHORTCUT} tone="onAccent" />
                            </span>
                        </span>
                    </span>
                    <span className="flex h-[52px] w-[52px] shrink-0 items-center justify-center">
                        <Bot className="h-6 w-6" aria-hidden />
                    </span>
                    {unread && (
                        <span data-unread="" aria-hidden className="absolute right-0.5 top-0.5 h-3 w-3 rounded-full bg-rose-500 ring-2 ring-canvas" />
                    )}
                    {streaming && (
                        <span aria-hidden className="pointer-events-none absolute -inset-1 rounded-full ring-2 ring-accent-lineage/40 animate-pulse" />
                    )}
                </button>
            </HoverTip>
        </div>
    )
}
