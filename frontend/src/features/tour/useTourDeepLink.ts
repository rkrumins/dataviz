/**
 * useTourDeepLink — start a tour from a URL.
 *
 * Any in-app link carrying ``?tour=<id>`` (from a guide article, an
 * announcement, an onboarding email) launches that tour. The param is consumed
 * immediately so a refresh or back-navigation doesn't re-trigger it, and the
 * Help drawer is closed first so the tour spotlight isn't fighting the drawer.
 *
 * Mounted where the tour overlay lives (AppLayout), so a deep-link that lands
 * on any authenticated route can actually render.
 */
import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTourStore } from './tourStore'
import { getTour } from './tours'
import { useFeature } from '@/store/features'
import { useHelpPanelStore } from '@/store/helpPanel'

export function useTourDeepLink() {
  const toursEnabled = useFeature('toursEnabled')
  const [params, setParams] = useSearchParams()

  useEffect(() => {
    const id = params.get('tour')
    if (!id) return

    // Fire once: drop the param (replace, so it leaves no history entry).
    if (toursEnabled && getTour(id)) {
      useHelpPanelStore.getState().closeHelp()
      useTourStore.getState().start(id)
    }
    const next = new URLSearchParams(params)
    next.delete('tour')
    setParams(next, { replace: true })
  }, [params, setParams, toursEnabled])
}
