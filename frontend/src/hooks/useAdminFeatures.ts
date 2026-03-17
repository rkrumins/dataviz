/**
 * Admin Features page: data loading, save, reset, toasts, and modal state.
 * Keeps AdminFeatures component thin and logic testable.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { featuresService, FeaturesConcurrencyError, type FeaturesResponse } from '@/services/featuresService'

export const SEARCH_MIN_FEATURES = 10

export function useAdminFeatures() {
  const [data, setData] = useState<FeaturesResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [toastVisible, setToastVisible] = useState(false)
  const [errorToastVisible, setErrorToastVisible] = useState(false)
  const [errorToastMessage, setErrorToastMessage] = useState('')
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const [resetLoading, setResetLoading] = useState(false)
  const [defaultsHintDismissed, setDefaultsHintDismissed] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const resetModalRef = useRef<HTMLDivElement>(null)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)

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

  const handleChange = useCallback(
    async (key: string, value: unknown) => {
      if (!data) return
      const next = { ...data.values, [key]: value }
      setData({ ...data, values: next })
      setSavingKey(key)
      try {
        const res = await featuresService.update({
          ...next,
          version: data.version,
        } as Record<string, unknown> & { version: number })
        setData(res)
        setToastVisible(true)
      } catch (err) {
        if (err instanceof FeaturesConcurrencyError) {
          await load()
          setErrorToastMessage('Someone else saved. Reloaded.')
          setErrorToastVisible(true)
          return
        }
        const msg = err instanceof Error ? err.message : 'Could not save. Please try again.'
        setError(msg)
        setErrorToastMessage(msg)
        setErrorToastVisible(true)
        setData({ ...data, values: data.values })
      } finally {
        setSavingKey(null)
      }
    },
    [data, load]
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
      setResetConfirmOpen(false)
      setToastVisible(true)
    } catch (err) {
      if (err instanceof FeaturesConcurrencyError) {
        await load()
        setErrorToastMessage('Someone else saved. Reloaded.')
        setErrorToastVisible(true)
        setResetConfirmOpen(false)
        return
      }
      setError(err instanceof Error ? err.message : 'Could not reset. Please try again.')
    } finally {
      setResetLoading(false)
    }
  }, [data?.version, load])

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
        setToastVisible(true)
      } catch (err) {
        if (err instanceof FeaturesConcurrencyError) {
          await load()
          setErrorToastMessage('Someone else saved. Reloaded.')
          setErrorToastVisible(true)
          return
        }
        const msg = err instanceof Error ? err.message : 'Could not save notice.'
        setErrorToastMessage(msg)
        setErrorToastVisible(true)
      }
    },
    [data, load]
  )

  return {
    data,
    isLoading,
    error,
    load,
    handleChange,
    savingKey,
    toastVisible,
    setToastVisible,
    errorToastVisible,
    setErrorToastVisible,
    errorToastMessage,
    setErrorToastMessage,
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
