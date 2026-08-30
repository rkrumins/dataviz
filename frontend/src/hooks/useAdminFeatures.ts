/**
 * Admin Features page: data loading, save, reset, and modal state.
 * Keeps AdminFeatures component thin and logic testable.
 *
 * It says what happened through the app's ONE notification stack. It used to
 * own a second pop-up of its own in the same bottom-right corner — which could
 * overlap the real one, swallowed clicks over whatever was beneath it, and had
 * missed every fix the shared stack has had since.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { featuresService, FeaturesConcurrencyError, type FeaturesResponse } from '@/services/featuresService'
import { useAppNotifications } from '@/components/ui/notifications'
import { useFeaturesStore } from '@/store/features'

export const SEARCH_MIN_FEATURES = 10

export function useAdminFeatures() {
  const [data, setData] = useState<FeaturesResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const [resetLoading, setResetLoading] = useState(false)
  const [defaultsHintDismissed, setDefaultsHintDismissed] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const resetModalRef = useRef<HTMLDivElement>(null)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const { notify } = useAppNotifications()

  const load = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await featuresService.get()
      setData(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load features')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  /** True when the save landed. The page says WHAT changed — it is the only
   *  place that knows the feature's name and how to put it back. */
  const handleChange = useCallback(
    async (key: string, value: unknown) => {
      if (!data) return false
      const next = { ...data.values, [key]: value }
      setData({ ...data, values: next })
      setSavingKey(key)
      try {
        const res = await featuresService.update({
          ...next,
          version: data.version,
        } as Record<string, unknown> & { version: number })
        setData(res)
        // Tell the RUNNING APP, not just this page. Without this the admin flips a switch, the
        // database and the API agree it is off, the server starts refusing the writes — and the
        // admin's own tab keeps offering the buttons until they hard-refresh. They are then
        // looking at a UI they have personally disabled, which reads as "the toggle is broken".
        useFeaturesStore.getState().setValues(res.values)
        return true
      } catch (err) {
        if (err instanceof FeaturesConcurrencyError) {
          await load()
          notify('error', 'Someone else saved. Reloaded.')
          return false
        }
        const msg = err instanceof Error ? err.message : 'Could not save. Please try again.'
        setError(msg)
        notify('error', msg)
        setData({ ...data, values: data.values })
        return false
      } finally {
        setSavingKey(null)
      }
    },
    [data, load, notify]
  )

  useEffect(() => {
    if (!resetConfirmOpen) return
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !resetLoading) setResetConfirmOpen(false)
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [resetConfirmOpen, resetLoading])

  const handleReset = useCallback(async () => {
    setResetLoading(true)
    setError(null)
    try {
      const res = await featuresService.reset(data?.version ?? 0)
      setData(res)
      useFeaturesStore.getState().setValues(res.values)   // same reason as handleChange
      setResetConfirmOpen(false)
      notify('success', 'Saved')
    } catch (err) {
      if (err instanceof FeaturesConcurrencyError) {
        await load()
        notify('error', 'Someone else saved. Reloaded.')
        setResetConfirmOpen(false)
        return
      }
      setError(err instanceof Error ? err.message : 'Could not reset. Please try again.')
    } finally {
      setResetLoading(false)
    }
  }, [data?.version, load, notify])

  const updateNotice = useCallback(
    async (notice: { enabled?: boolean; title?: string; message?: string }) => {
      if (!data) return
      try {
        const res = await featuresService.update({
          ...data.values,
          version: data.version,
          experimentalNotice: notice,
        } as Record<string, unknown> & { version: number })
        setData(res)
        notify('success', 'Saved')
      } catch (err) {
        if (err instanceof FeaturesConcurrencyError) {
          await load()
          notify('error', 'Someone else saved. Reloaded.')
          return
        }
        notify('error', err instanceof Error ? err.message : 'Could not save notice.')
      }
    },
    [data, load, notify]
  )

  return {
    data,
    isLoading,
    error,
    load,
    handleChange,
    savingKey,
    resetConfirmOpen,
    setResetConfirmOpen,
    handleReset,
    resetLoading,
    defaultsHintDismissed,
    setDefaultsHintDismissed,
    searchQuery,
    setSearchQuery,
    resetModalRef,
    cancelButtonRef,
    updateNotice,
  }
}
