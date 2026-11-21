/**
 * AssistantRail — the AI assistant, as a right-hand rail beside the page.
 *
 * - **In the flow.** It sits after `<main>` in the app's row, so opening it pushes the page over
 *   rather than covering it, and folds away the same way. Nothing paints behind it, so it is
 *   opaque — no backdrop blur. It stays mounted while folded (hidden), so an answer keeps
 *   streaming and the conversation is there when it opens again.
 * - **Width.** Its left edge drags (or steps, from the keyboard) between `RAIL_MIN_WIDTH` and as
 *   wide as leaves the page `CANVAS_MIN_WIDTH`; the width is kept for the session.
 * - **Keys.** It is a keyboard scope (`ai-chat`): the canvas's shortcuts never see keys typed
 *   here — Backspace is a letter deleted, not the selected node. Esc closes it.
 * - **Focus.** Opening it puts the cursor in the composer; closing it gives focus back.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { EmptyState } from '@/components/ui/EmptyState'
import { ResizeHandle } from '@/components/canvas/search/panel/ResizeHandle'
import { useHostRect } from '@/components/canvas/search/studio/useHostRect'
import { CANVAS_MIN_WIDTH } from '@/components/panels/shell/drawerWidth'
import { keyboardScopeProps } from '@/lib/keyboardScope'
import { queryClient } from '@/lib/queryClient'
import { cn } from '@/lib/utils'
import { AI_STATUS_KEY, useAiStatus } from '../api/aiQueries'
import { aiErrorCode } from '../api/aiService'
import { sendMessage, startNewChat, stopStreaming } from '../lib/chatController'
import { markClarified } from '../lib/transcript'
import { useAssistantContext } from '../lib/useAssistantContext'
import { useAssistantStore } from '../store/assistantStore'
import { AssistantHeader } from './AssistantHeader'
import type { ClarificationChoice } from './blocks/ClarificationCard'
import { Composer, type ComposerHandle } from './Composer'
import { Transcript } from './Transcript'
import { Unavailable, type UnavailableReason } from './Unavailable'
import { Welcome } from './Welcome'

export const RAIL_MIN_WIDTH = 360
export const RAIL_MAX_WIDTH = 760
const RAIL_DEFAULT_WIDTH = 420

export function AssistantRail() {
    const open = useAssistantStore((s) => s.open)
    const persona = useAssistantStore((s) => s.persona)
    const turns = useAssistantStore((s) => s.turns)
    const loadingConversation = useAssistantStore((s) => s.loadingConversation)
    const pendingPrompt = useAssistantStore((s) => s.pendingContext?.prompt)
    const close = useAssistantStore((s) => s.closeAssistant)
    const page = useAssistantContext()
    const status = useAiStatus()
    const composer = useRef<ComposerHandle>(null)

    // ── Width: dragged at the left edge, never so wide the page drops below CANVAS_MIN_WIDTH ──
    const [aside, setAside] = useState<HTMLElement | null>(null)
    const mainRect = useHostRect(aside?.previousElementSibling ?? null)
    const railRect = useHostRect(aside)
    const storedWidth = useAssistantStore((s) => s.railWidth)
    const setStoredWidth = useAssistantStore((s) => s.setRailWidth)
    const [liveWidth, setLiveWidth] = useState<number | null>(null)
    const chosen = liveWidth ?? storedWidth ?? RAIL_DEFAULT_WIDTH
    // The page and the rail share the room; the page keeps CANVAS_MIN_WIDTH of it.
    const room = mainRect && mainRect.width > 0 ? mainRect.width + (railRect?.width ?? 0) - CANVAS_MIN_WIDTH : RAIL_MAX_WIDTH
    const maxWidth = Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_MAX_WIDTH, room))
    const width = Math.max(RAIL_MIN_WIDTH, Math.min(maxWidth, chosen))
    const commitWidth = useCallback((w: number) => { setStoredWidth(w); setLiveWidth(null) }, [setStoredWidth])

    // ── Focus: into the composer on open, back where it came from on close ──
    const returnFocus = useRef<HTMLElement | null>(null)
    useEffect(() => {
        if (open) {
            const active = document.activeElement
            if (active instanceof HTMLElement && !aside?.contains(active)) returnFocus.current = active
            composer.current?.focus()
            return
        }
        const back = returnFocus.current
        const active = document.activeElement
        if (back?.isConnected && (!active || active === document.body || aside?.contains(active))) back.focus({ preventScroll: true })
    }, [open, aside])

    // ── What it can answer ──
    const s = status.data
    const code = status.error ? aiErrorCode(status.error) : null
    const httpStatus = (status.error as { status?: number } | null)?.status
    const unavailable: UnavailableReason | null = status.isError
        ? (httpStatus === 403 || code === 'missing_permission' || code === 'feature_disabled' ? 'no_access' : 'unreachable')
        : s && !s.configured ? 'not_configured'
            : s && s.personas?.[persona] === false ? 'persona_off'
                : null
    const ready = !!s && unavailable === null

    const last = turns[turns.length - 1]
    const streaming = last?.role === 'assistant' && last.status === 'streaming'

    const ask = useCallback((message: string) => {
        void sendMessage({ message, persona, context: page.context })
    }, [persona, page.context])

    // A launcher's question ("What breaks if this changes?" from the drawer) is asked once, on open.
    useEffect(() => {
        if (!open || !pendingPrompt || !ready || streaming) return
        const t = setTimeout(() => {
            const prompt = useAssistantStore.getState().consumePrompt()
            if (prompt) ask(prompt)
        }, 0)
        return () => clearTimeout(t)
    }, [open, pendingPrompt, ready, streaming, ask])

    const retry = useCallback((assistantTurnId: string) => {
        const at = turns.findIndex((t) => t.id === assistantTurnId)
        const question = turns.slice(0, at).reverse().find((t) => t.role === 'user')
        if (question?.role === 'user' && question.text) ask(question.text)
    }, [turns, ask])

    const clarify = useCallback((turnId: string, clarificationId: string, choice: ClarificationChoice) => {
        void sendMessage({
            message: '', persona, context: page.context,
            clarification: { id: clarificationId, optionId: choice.optionId, remember: choice.remember, label: choice.label, turnId },
        })
    }, [persona, page.context])

    const other = useCallback((turnId: string, clarificationId: string, text: string) => {
        useAssistantStore.getState().updateTurn(turnId, (t) => markClarified(t, clarificationId))
        ask(text)
    }, [ask])

    return (
        <aside
            ref={setAside}
            data-panel="ai-assistant"
            aria-label="AI assistant"
            {...keyboardScopeProps('ai-chat')}
            onKeyDown={(e) => {
                // Not from a menu portaled out of it (its own Esc closes the menu).
                if (e.key === 'Escape' && !e.defaultPrevented && aside?.contains(e.target as Node)) {
                    e.preventDefault()
                    close()
                }
            }}
            style={{ width }}
            className={cn(
                'relative h-full flex-shrink-0 flex-col overflow-hidden',
                'border-l border-glass-border bg-canvas-elevated shadow-lg shadow-black/10',
                open ? 'flex' : 'hidden',
            )}
        >
            <AssistantHeader page={page} connectionName={s?.connectionName} personas={s?.personas} onClose={close} />

            <ErrorBoundary
                resetKeys={[turns]}
                fallback={() => (
                    <div className="flex min-h-0 flex-1 items-center justify-center px-4">
                        <EmptyState icon={AlertCircle} title="This conversation couldn’t be shown"
                                    description="Something in an answer was not in a shape this panel can draw."
                                    action={{ label: 'Start a new chat', onClick: startNewChat }} />
                    </div>
                )}
            >
            {status.isLoading ? (
                <div className="flex-1" aria-busy="true" />
            ) : unavailable ? (
                <Unavailable reason={unavailable} onRetry={() => void queryClient.invalidateQueries({ queryKey: AI_STATUS_KEY })} />
            ) : turns.length === 0 && !loadingConversation ? (
                <Welcome
                    persona={persona}
                    at={{ onView: !!page.view && !page.detached, selectedCount: page.detached ? 0 : page.selectedCount, focused: !page.detached && !!page.focus }}
                    onAsk={ask}
                />
            ) : (
                <Transcript
                    turns={turns}
                    loading={loadingConversation}
                    busy={streaming}
                    onAsk={ask}
                    onRetry={retry}
                    onClarify={clarify}
                    onOther={other}
                />
            )}
            </ErrorBoundary>

            <Composer
                ref={composer}
                onSend={ask}
                onStop={stopStreaming}
                onEscape={close}
                streaming={streaming}
                disabled={!ready || loadingConversation}
                placeholder={persona === 'help' ? 'Ask how to do something…' : page.view && !page.detached ? 'Ask about this view…' : 'Ask about your data…'}
                footer="Answers can be wrong — check the evidence."
            />

            <ResizeHandle
                edge="left"
                label="Resize the assistant"
                width={width}
                min={RAIL_MIN_WIDTH}
                max={maxWidth}
                onResize={setLiveWidth}
                onCommit={commitWidth}
            />
        </aside>
    )
}
