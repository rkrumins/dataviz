/**
 * useDocumentTitle — set the tab title to ``<segment> · <brand>``.
 *
 * Pages used to hardcode ``document.title = '… · Synodic'``; this hook
 * reads the live brand short-name so a rebrand updates every page title.
 * Pass the page segment; the brand suffix is appended automatically.
 * Pass ``null`` to use the brand name alone (no segment).
 */
import { useEffect } from 'react'
import { useBrand } from '@/store/branding'

export function useDocumentTitle(segment: string | null): void {
    const { shortName, appName } = useBrand()
    useEffect(() => {
        document.title = segment ? `${segment} · ${shortName}` : appName
    }, [segment, shortName, appName])
}
