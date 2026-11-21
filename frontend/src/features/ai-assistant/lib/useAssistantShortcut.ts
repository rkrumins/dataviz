import { useEffect } from 'react'
import { hasPrimaryModifier } from '@/lib/platform'
import { useAssistantStore } from '../store/assistantStore'

/** The assistant's shortcut, as `formatShortcut` writes it. */
export const ASSISTANT_SHORTCUT = 'mod+j'

/**
 * ⌘J (Ctrl+J elsewhere) opens and closes the assistant, from anywhere — a field included: it is
 * a chord, so it never stands for a typed letter. Free of the app's other keys: ⌘K is the
 * command palette, ⌘/ the Business / Technical switch, and the canvas binds no ⌘J.
 */
export function useAssistantShortcut(enabled: boolean): void {
    useEffect(() => {
        if (!enabled) return
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key.toLowerCase() !== 'j' || !hasPrimaryModifier(e) || e.altKey || e.shiftKey || e.repeat) return
            e.preventDefault()
            useAssistantStore.getState().toggleAssistant()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [enabled])
}
