/**
 * Admin Features page: data loading, save, reset, toasts, and modal state.
 * Keeps AdminFeatures component thin and logic testable.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { featuresService, type FeaturesResponse } from '@/services/featuresService'

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
        const res = await featuresService.update(next as Record<string, unknown>)
        setData(res)
        setToastVisible(true)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Could not save. Please try again.'
        setError(msg)
        setErrorToastMessage(msg)
        setErrorToastVisible(true)
        setData({ ...data, values: data.values })
      } finally {
        setSavingKey(null)
      }
    },
    [data]
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
      const res = await featuresService.reset()
      setData(res)
      setResetConfirmOpen(false)
      setToastVisible(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset. Please try again.')
    } finally {
      setResetLoading(false)
    }
  }, [])

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
  }
}
