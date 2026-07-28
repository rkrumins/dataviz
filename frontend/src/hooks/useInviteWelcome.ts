/**
 * The first thing an invited user sees.
 *
 * Redemption drops them straight into the app — which, for somebody who
 * has never been here, is a cold dashboard full of things they have no
 * context for. The Getting Started hub already exists and already tailors
 * its tracks to what the person can actually do, so the whole job is
 * opening it once, on arrival, and never again.
 *
 * The signal is a `?welcome=invite` param on the redirect. It is stripped
 * immediately so a refresh, a bookmark, or a shared URL does not reopen
 * the panel — a welcome that keeps welcoming you is an annoyance.
 */
import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useHelpPanelStore } from '@/store/helpPanel'

export const INVITE_WELCOME_PARAM = 'welcome'
export const INVITE_WELCOME_VALUE = 'invite'

export function useInviteWelcome(): void {
    const location = useLocation()
    const navigate = useNavigate()
    const openGettingStarted = useHelpPanelStore(s => s.openGettingStarted)
    // StrictMode runs effects twice in development; opening the panel is
    // idempotent but stripping the param twice would push two history
    // entries, putting the welcome URL back one Back press away.
    const handled = useRef(false)

    useEffect(() => {
        if (handled.current) return

        const params = new URLSearchParams(location.search)
        if (params.get(INVITE_WELCOME_PARAM) !== INVITE_WELCOME_VALUE) return

        handled.current = true
        openGettingStarted()

        params.delete(INVITE_WELCOME_PARAM)
        const query = params.toString()
        navigate(
            { pathname: location.pathname, search: query ? `?${query}` : '' },
            { replace: true },
        )
    }, [location.search, location.pathname, navigate, openGettingStarted])
}
