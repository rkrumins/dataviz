/**
 * useSharedIntersectionObserver — single IntersectionObserver shared
 * across all consumers with the same observer options.
 *
 * Why: ``RegistryAssets`` mounts up to a few hundred ``AssetRow``
 * children, each previously creating its own IntersectionObserver.
 * The browser handles many observers fine, but it's wasteful and
 * harder to reason about lifecycle. One observer per option-set
 * gives us identical visibility semantics with O(1) observers
 * regardless of how many rows are visible.
 *
 * Usage:
 *
 *     const ref = useRef<HTMLDivElement>(null)
 *     const isVisible = useSharedIntersectionObserver(ref, { rootMargin: '200px' })
 *
 * The hook returns a boolean that flips to ``true`` when the element
 * intersects and stays true thereafter (single-fire visibility,
 * matching ``RegistryAssets``'s lazy-load semantics — once a row has
 * loaded its stats we don't unload them when scrolled away).
 */
import { useEffect, useRef, useState } from 'react'

interface ObserverEntry {
    observer: IntersectionObserver
    callbacks: WeakMap<Element, (entry: IntersectionObserverEntry) => void>
    refCount: number
}

const _registry = new Map<string, ObserverEntry>()

function _optionsKey(options: IntersectionObserverInit): string {
    return JSON.stringify({
        root: (options.root as Element)?.id ?? null,
        rootMargin: options.rootMargin ?? '0px',
        threshold: options.threshold ?? 0,
    })
}

function _getOrCreate(options: IntersectionObserverInit): ObserverEntry {
    const key = _optionsKey(options)
    let entry = _registry.get(key)
    if (!entry) {
        const callbacks = new WeakMap<Element, (e: IntersectionObserverEntry) => void>()
        const observer = new IntersectionObserver((entries) => {
            for (const e of entries) {
                callbacks.get(e.target)?.(e)
            }
        }, options)
        entry = { observer, callbacks, refCount: 0 }
        _registry.set(key, entry)
    }
    return entry
}

function _release(options: IntersectionObserverInit): void {
    const key = _optionsKey(options)
    const entry = _registry.get(key)
    if (!entry) return
    entry.refCount -= 1
    if (entry.refCount <= 0) {
        entry.observer.disconnect()
        _registry.delete(key)
    }
}

/**
 * Observe ``ref.current`` with a shared IntersectionObserver. Returns
 * a boolean that flips to ``true`` on first intersection and stays
 * true (single-fire). Callers needing toggle-on-scroll-away semantics
 * should use a different hook — this one is tuned for lazy-load.
 */
export function useSharedIntersectionObserver(
    ref: React.RefObject<Element | null>,
    options: IntersectionObserverInit = {},
): boolean {
    const [isVisible, setIsVisible] = useState(false)
    // Track latest options across renders without re-subscribing on
    // every render (callers usually pass a fresh object literal).
    const optsRef = useRef(options)
    optsRef.current = options

    useEffect(() => {
        const elem = ref.current
        if (!elem || isVisible) return

        const entry = _getOrCreate(optsRef.current)
        entry.refCount += 1
        entry.callbacks.set(elem, (e) => {
            if (e.isIntersecting) {
                setIsVisible(true)
                // Drop the callback so the shared observer stops
                // delivering events for this element. The observer
                // itself stays alive while other consumers use it.
                entry.callbacks.delete(elem)
                entry.observer.unobserve(elem)
            }
        })
        entry.observer.observe(elem)

        return () => {
            entry.callbacks.delete(elem)
            entry.observer.unobserve(elem)
            _release(optsRef.current)
        }
        // We deliberately re-run only when ref identity or visibility
        // changes — the options dict is read via optsRef.current so
        // callers passing inline literals don't thrash the observer.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ref, isVisible])

    return isVisible
}
