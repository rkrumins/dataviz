/**
 * useAnnouncement — what a live region says, changed at most once every
 * ``everyMs``. A newer message waits its turn rather than cutting in, so a
 * screen reader hears where things settle, not every step on the way.
 * Nothing to say keeps the last thing said.
 */
import { useEffect, useRef, useState } from 'react'


export function useAnnouncement(message: string, everyMs = 1500): string {
    const [said, setSaid] = useState('')
    const lastAt = useRef(0)
    useEffect(() => {
        if (!message || message === said) return
        const t = setTimeout(() => {
            lastAt.current = Date.now()
            setSaid(message)
        }, Math.max(0, lastAt.current + everyMs - Date.now()))
        return () => clearTimeout(t)
    }, [message, said, everyMs])
    return said
}
