import { useCallback, useEffect, useRef, useState } from 'react'

/** Copy text and say so for a beat. A denied clipboard is a no-op, never an error. */
export function useCopy(): [copied: boolean, copy: (text: string) => void] {
    const [copied, setCopied] = useState(false)
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
    useEffect(() => () => clearTimeout(timer.current), [])
    const copy = useCallback((text: string) => {
        navigator.clipboard?.writeText(text).then(() => {
            setCopied(true)
            clearTimeout(timer.current)
            timer.current = setTimeout(() => setCopied(false), 1400)
        }, () => {})
    }, [])
    return [copied, copy]
}
