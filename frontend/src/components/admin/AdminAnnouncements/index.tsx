/**
 * Admin Announcements page — CRUD management for global announcement banners.
 * Accessible at /admin/announcements (admin role required).
 */
import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Megaphone, Plus, Pencil, Trash2, X, Check, AlertCircle,
  Info, AlertTriangle, CheckCircle, ExternalLink, Loader2, Settings, PauseCircle,
} from 'lucide-react'
import {
  announcementService,
  type AnnouncementResponse,
  type AnnouncementCreateRequest,
  type AnnouncementUpdateRequest,
  type AnnouncementConfigResponse,
} from '@/services/announcementService'
import { useAnnouncementStore } from '@/store/announcements'

type BannerType = 'info' | 'warning' | 'success'

const BANNER_TYPE_OPTIONS: { value: BannerType; label: string; icon: typeof Info; color: string }[] = [
  { value: 'info', label: 'Info', icon: Info, color: 'text-indigo-500' },
  { value: 'warning', label: 'Warning', icon: AlertTriangle, color: 'text-amber-500' },
  { value: 'success', label: 'Success', icon: CheckCircle, color: 'text-emerald-500' },
]

const TYPE_BADGE_STYLES: Record<BannerType, string> = {
  info: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20',
  warning: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
  success: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
}

interface FormState {
  title: string
  message: string
  bannerType: BannerType
  isActive: boolean
  snoozeDurationMinutes: number
  ctaText: string
  ctaUrl: string
}

const EMPTY_FORM: FormState = {
  title: '',
  message: '',
  bannerType: 'info',
  isActive: true,
  snoozeDurationMinutes: 0,
  ctaText: '',
  ctaUrl: '',
}

function formFromAnnouncement(ann: AnnouncementResponse): FormState {
  return {
    title: ann.title,
    message: ann.message,
    bannerType: ann.bannerType,
    isActive: ann.isActive,
    snoozeDurationMinutes: ann.snoozeDurationMinutes,
    ctaText: ann.ctaText ?? '',
    ctaUrl: ann.ctaUrl ?? '',
  }
}

/** Trigger the global banner store to re-fetch so changes appear instantly. */
function refreshBanner() {
  useAnnouncementStore.getState().fetchActive()
}

export function AdminAnnouncements() {
  const [announcements, setAnnouncements] = useState<AnnouncementResponse[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Form state
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  // Delete confirmation
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)

  // Toast
  const [toast, setToast] = useState<{ message: string; variant: 'success' | 'error' } | null>(null)

  // Global config state
  const [config, setConfig] = useState<AnnouncementConfigResponse | null>(null)
  const [configOpen, setConfigOpen] = useState(false)
  const [configPoll, setConfigPoll] = useState(15)
  const [configSnooze, setConfigSnooze] = useState(30)
  const [configSaving, setConfigSaving] = useState(false)

  const load = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const data = await announcementService.listAll()
      setAnnouncements(data)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsLoading(false)
    }
  }, [])

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await announcementService.getAdminConfig()
      setConfig(cfg)
      setConfigPoll(cfg.pollIntervalSeconds)
      setConfigSnooze(cfg.defaultSnoozeMinutes)
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadConfig() }, [loadConfig])

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.variant === 'error' ? 4000 : 3000)
    return () => clearTimeout(t)
  }, [toast])

  const openCreate = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setFormOpen(true)
  }

  const openEdit = (ann: AnnouncementResponse) => {
    setEditingId(ann.id)
    setForm(formFromAnnouncement(ann))
    setFormOpen(true)
  }

  const closeForm = () => {
    setFormOpen(false)
    setEditingId(null)
  }

  const handleSave = async () => {
    if (!form.title.trim() || !form.message.trim()) return
    setSaving(true)
    try {
      const payload = {
        title: form.title.trim(),
        message: form.message.trim(),
        bannerType: form.bannerType,
        isActive: form.isActive,
        snoozeDurationMinutes: form.snoozeDurationMinutes,
        ctaText: form.ctaText.trim() || null,
        ctaUrl: form.ctaUrl.trim() || null,
      }
      if (editingId) {
        await announcementService.update(editingId, payload as AnnouncementUpdateRequest)
        setToast({ message: 'Announcement updated', variant: 'success' })
      } else {
        await announcementService.create(payload as AnnouncementCreateRequest)
        setToast({ message: 'Announcement created', variant: 'success' })
      }
      closeForm()
      await load()
      refreshBanner()
    } catch (err: any) {
      setToast({ message: err.message, variant: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const handleToggleActive = async (ann: AnnouncementResponse) => {
    try {
      await announcementService.update(ann.id, { isActive: !ann.isActive })
      await load()
      refreshBanner()
      setToast({ message: ann.isActive ? 'Announcement deactivated' : 'Announcement activated', variant: 'success' })
    } catch (err: any) {
      setToast({ message: err.message, variant: 'error' })
    }
  }

  const handleDelete = async () => {
    if (!deletingId) return
    setDeleteLoading(true)
    try {
      await announcementService.remove(deletingId)
      setDeletingId(null)
      setToast({ message: 'Announcement deleted', variant: 'success' })
      await load()
      refreshBanner()
    } catch (err: any) {
      setToast({ message: err.message, variant: 'error' })
    } finally {
      setDeleteLoading(false)
    }
  }

  const handleConfigSave = async () => {
    setConfigSaving(true)
    try {
      const updated = await announcementService.updateConfig({
        pollIntervalSeconds: Math.max(5, configPoll),
        defaultSnoozeMinutes: Math.max(0, configSnooze),
      })
      setConfig(updated)
      // Refresh the banner store so it picks up the new polling interval
      useAnnouncementStore.getState().fetchConfig()
      setToast({ message: 'Banner settings saved', variant: 'success' })
      setConfigOpen(false)
    } catch (err: any) {
      setToast({ message: err.message, variant: 'error' })
    } finally {
      setConfigSaving(false)
    }
  }

  const updateField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  return (
    <div className="max-w-6xl mx-auto p-8 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6 mb-10">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <Megaphone className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-ink">Announcements</h1>
            <p className="text-sm text-ink-muted mt-1">
              Manage global banners shown to all users across the application.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setConfigOpen((v) => !v)}
            className="p-2.5 rounded-xl border border-glass-border text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            aria-label="Banner Settings"
            title="Banner Settings"
          >
            <Settings className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={openCreate}
            className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium shadow-lg shadow-indigo-500/20 hover:shadow-indigo-500/30 transition-all flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            New Announcement
          </button>
        </div>
      </div>

      {/* Global Banner Settings */}
      <AnimatePresence>
        {configOpen && (
          <motion.div
            initial={{ opacity: 0, y: -8, height: 0 }}
            animate={{ opacity: 1, y: 0, height: 'auto' }}
            exit={{ opacity: 0, y: -8, height: 0 }}
            transition={{ duration: 0.2 }}
            className="mb-8 rounded-2xl border border-glass-border bg-canvas-elevated p-6 shadow-sm"
          >
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2">
                <Settings className="w-4 h-4 text-ink-muted" />
                <h2 className="text-lg font-semibold text-ink">Banner Settings</h2>
              </div>
              <button
                type="button"
                onClick={() => setConfigOpen(false)}
                className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-sm text-ink-muted mb-5">
              These settings apply globally to all announcement banners.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div>
                <label htmlFor="cfg-poll" className="block text-sm font-medium text-ink-secondary mb-1.5">
                  Polling Interval <span className="text-ink-muted text-xs">(seconds, min 5)</span>
                </label>
                <input
                  id="cfg-poll"
                  type="number"
                  min={5}
                  max={3600}
                  value={configPoll}
                  onChange={(e) => setConfigPoll(Math.max(5, parseInt(e.target.value) || 5))}
                  className="w-full px-3 py-2.5 rounded-xl border border-glass-border bg-canvas text-ink text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/30"
                />
                <p className="text-xs text-ink-muted mt-1">How frequently each user's browser checks for banner updates.</p>
              </div>
              <div>
                <label htmlFor="cfg-snooze" className="block text-sm font-medium text-ink-secondary mb-1.5">
                  Default Snooze Duration <span className="text-ink-muted text-xs">(minutes, 0 = no snooze)</span>
                </label>
                <input
                  id="cfg-snooze"
                  type="number"
                  min={0}
                  max={1440}
                  value={configSnooze}
                  onChange={(e) => setConfigSnooze(Math.max(0, parseInt(e.target.value) || 0))}
                  className="w-full px-3 py-2.5 rounded-xl border border-glass-border bg-canvas text-ink text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/30"
                />
                <p className="text-xs text-ink-muted mt-1">Default snooze duration for new announcements. Each announcement can override this.</p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 mt-5">
              <button
                type="button"
                onClick={() => setConfigOpen(false)}
                className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfigSave}
                disabled={configSaving}
                className="px-5 py-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium shadow-lg shadow-indigo-500/20 hover:shadow-indigo-500/30 transition-all disabled:opacity-50 flex items-center gap-2"
              >
                {configSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Save Settings
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mb-6 flex items-center gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400"
          >
            <AlertCircle className="w-5 h-5 shrink-0" />
            <p className="flex-1 text-sm">{error}</p>
            <button
              type="button"
              onClick={load}
              className="px-3 py-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-sm font-medium transition-colors"
            >
              Retry
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Create/Edit Form */}
      <AnimatePresence>
        {formOpen && (
          <motion.div
            initial={{ opacity: 0, y: -8, height: 0 }}
            animate={{ opacity: 1, y: 0, height: 'auto' }}
            exit={{ opacity: 0, y: -8, height: 0 }}
            transition={{ duration: 0.2 }}
            className="mb-8 rounded-2xl border border-glass-border bg-canvas-elevated p-6 shadow-sm"
          >
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold text-ink">
                {editingId ? 'Edit Announcement' : 'New Announcement'}
              </h2>
              <button
                type="button"
                onClick={closeForm}
                className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-5">
              {/* Title */}
              <div>
                <label htmlFor="ann-title" className="block text-sm font-medium text-ink-secondary mb-1.5">
                  Title <span className="text-red-400">*</span>
                </label>
                <input
                  id="ann-title"
                  type="text"
                  value={form.title}
                  onChange={(e) => updateField('title', e.target.value)}
                  placeholder="e.g. Preview Mode Active"
                  maxLength={200}
                  className="w-full px-3 py-2.5 rounded-xl border border-glass-border bg-canvas text-ink text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/30"
                />
              </div>

              {/* Message */}
              <div>
                <label htmlFor="ann-message" className="block text-sm font-medium text-ink-secondary mb-1.5">
                  Message <span className="text-red-400">*</span>
                </label>
                <textarea
                  id="ann-message"
                  value={form.message}
                  onChange={(e) => updateField('message', e.target.value)}
                  placeholder="Describe the announcement..."
                  maxLength={2000}
                  rows={3}
                  className="w-full px-3 py-2.5 rounded-xl border border-glass-border bg-canvas text-ink text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/30 resize-y"
                />
              </div>

              {/* Banner Type */}
              <div>
                <label className="block text-sm font-medium text-ink-secondary mb-2">Banner Type</label>
                <div className="flex gap-2">
                  {BANNER_TYPE_OPTIONS.map((opt) => {
                    const Icon = opt.icon
                    const isSelected = form.bannerType === opt.value
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => updateField('bannerType', opt.value)}
                        className={`flex items-center gap-2 px-4 py-2 rounded-xl border text-sm font-medium transition-all ${
                          isSelected
                            ? `${TYPE_BADGE_STYLES[opt.value]} border-current shadow-sm`
                            : 'border-glass-border text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5'
                        }`}
                      >
                        <Icon className={`w-4 h-4 ${isSelected ? opt.color : ''}`} />
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Visibility & Snooze — card-style group */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Active toggle card */}
                <button
                  type="button"
                  onClick={() => updateField('isActive', !form.isActive)}
                  className={`flex items-center gap-3 p-4 rounded-xl border transition-all text-left ${
                    form.isActive
                      ? 'border-emerald-500/30 bg-emerald-500/5'
                      : 'border-glass-border bg-canvas hover:bg-black/[0.02] dark:hover:bg-white/[0.02]'
                  }`}
                >
                  <div className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors ${
                    form.isActive ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-600'
                  }`}>
                    <span className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform mt-0.5 ${
                      form.isActive ? 'translate-x-5' : 'translate-x-0.5'
                    }`} />
                  </div>
                  <div>
                    <span className={`text-sm font-medium ${form.isActive ? 'text-emerald-700 dark:text-emerald-400' : 'text-ink'}`}>
                      {form.isActive ? 'Active' : 'Inactive'}
                    </span>
                    <p className="text-xs text-ink-muted mt-0.5">
                      {form.isActive ? 'Banner is visible to all users' : 'Banner is hidden from users'}
                    </p>
                  </div>
                </button>

                {/* Snooze duration card */}
                <div className={`flex items-center gap-3 p-4 rounded-xl border transition-all ${
                  form.snoozeDurationMinutes > 0
                    ? 'border-indigo-500/30 bg-indigo-500/5'
                    : 'border-glass-border bg-canvas'
                }`}>
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                    form.snoozeDurationMinutes > 0
                      ? 'bg-indigo-500/10 text-indigo-500'
                      : 'bg-gray-100 dark:bg-gray-800 text-ink-muted'
                  }`}>
                    <PauseCircle className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <label htmlFor="ann-snooze" className="text-sm font-medium text-ink">
                      Snooze Duration
                    </label>
                    <p className="text-xs text-ink-muted mt-0.5">
                      {form.snoozeDurationMinutes > 0
                        ? `Users can hide for ${form.snoozeDurationMinutes} min`
                        : 'Users cannot snooze this banner'}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      id="ann-snooze"
                      type="number"
                      min={0}
                      max={1440}
                      value={form.snoozeDurationMinutes}
                      onChange={(e) => updateField('snoozeDurationMinutes', Math.max(0, parseInt(e.target.value) || 0))}
                      className="w-20 px-2.5 py-1.5 rounded-lg border border-glass-border bg-canvas text-ink text-sm text-center focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/30"
                    />
                    <span className="text-xs text-ink-muted">min</span>
                  </div>
                </div>
              </div>

              {/* CTA */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="ann-cta-text" className="block text-sm font-medium text-ink-secondary mb-1.5">
                    Button Text <span className="text-ink-muted text-xs">(optional)</span>
                  </label>
                  <input
                    id="ann-cta-text"
                    type="text"
                    value={form.ctaText}
                    onChange={(e) => updateField('ctaText', e.target.value)}
                    placeholder="e.g. Learn More"
                    maxLength={100}
                    className="w-full px-3 py-2.5 rounded-xl border border-glass-border bg-canvas text-ink text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/30"
                  />
                </div>
                <div>
                  <label htmlFor="ann-cta-url" className="block text-sm font-medium text-ink-secondary mb-1.5">
                    Button URL <span className="text-ink-muted text-xs">(optional)</span>
                  </label>
                  <input
                    id="ann-cta-url"
                    type="url"
                    value={form.ctaUrl}
                    onChange={(e) => updateField('ctaUrl', e.target.value)}
                    placeholder="https://..."
                    className="w-full px-3 py-2.5 rounded-xl border border-glass-border bg-canvas text-ink text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/30"
                  />
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeForm}
                  className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving || !form.title.trim() || !form.message.trim()}
                  className="px-5 py-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium shadow-lg shadow-indigo-500/20 hover:shadow-indigo-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  {editingId ? 'Save Changes' : 'Create'}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
        </div>
      )}

      {/* Empty state */}
      {!isLoading && announcements.length === 0 && !error && (
        <div className="text-center py-20">
          <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 flex items-center justify-center mx-auto mb-4">
            <Megaphone className="w-8 h-8 text-indigo-500" />
          </div>
          <h2 className="text-lg font-semibold text-ink mb-1">No announcements yet</h2>
          <p className="text-sm text-ink-muted mb-6">Create your first announcement to display a global banner.</p>
          <button
            type="button"
            onClick={openCreate}
            className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium shadow-lg shadow-indigo-500/20 hover:shadow-indigo-500/30 transition-all inline-flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            New Announcement
          </button>
        </div>
      )}

      {/* Announcement list */}
      {!isLoading && announcements.length > 0 && (
        <div className="space-y-4">
          {announcements.map((ann) => {
            const typeStyle = TYPE_BADGE_STYLES[ann.bannerType] ?? TYPE_BADGE_STYLES.info
            return (
              <motion.div
                key={ann.id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className={`rounded-2xl border p-5 transition-all ${
                  ann.isActive
                    ? 'border-glass-border bg-canvas-elevated'
                    : 'border-glass-border/50 bg-canvas-elevated/50 opacity-60'
                }`}
              >
                <div className="flex items-start gap-4">
                  {/* Left: active indicator bar */}
                  <div className={`w-1 self-stretch rounded-full shrink-0 transition-colors ${
                    ann.isActive ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-600'
                  }`} />

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                      <h3 className="text-sm font-semibold text-ink">{ann.title}</h3>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${typeStyle}`}>
                        {ann.bannerType}
                      </span>
                      {ann.isActive ? (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                          Live
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-gray-500/10 text-gray-500 border border-gray-500/20">
                          Inactive
                        </span>
                      )}
                      {ann.snoozeDurationMinutes > 0 && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20">
                          <PauseCircle className="w-2.5 h-2.5" />
                          {ann.snoozeDurationMinutes}m snooze
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-ink-secondary line-clamp-2">{ann.message}</p>

                    {/* CTA preview */}
                    {ann.ctaText && ann.ctaUrl && (
                      <div className="flex items-center gap-1.5 mt-2 text-xs text-indigo-500">
                        <ExternalLink className="w-3 h-3" />
                        <span>{ann.ctaText}</span>
                        <span className="text-ink-muted truncate max-w-xs">— {ann.ctaUrl}</span>
                      </div>
                    )}

                    {/* Audit info */}
                    <div className="flex items-center gap-3 mt-3 text-[11px] text-ink-muted">
                      <span>Created {new Date(ann.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}</span>
                      {ann.createdBy && <span>by {ann.createdBy}</span>}
                      {ann.updatedBy && (
                        <>
                          <span className="text-ink-muted/40">|</span>
                          <span>Updated by {ann.updatedBy}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    {/* Active toggle — modern pill style */}
                    <button
                      type="button"
                      role="switch"
                      aria-checked={ann.isActive}
                      aria-label={ann.isActive ? 'Deactivate' : 'Activate'}
                      onClick={() => handleToggleActive(ann)}
                      className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-white dark:focus:ring-offset-gray-900 ${
                        ann.isActive
                          ? 'bg-emerald-500 focus:ring-emerald-500/50'
                          : 'bg-gray-300 dark:bg-gray-600 focus:ring-gray-400/50'
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-md transition-transform mt-1 ${
                          ann.isActive ? 'translate-x-6' : 'translate-x-1'
                        }`}
                        aria-hidden
                      />
                    </button>

                    <button
                      type="button"
                      onClick={() => openEdit(ann)}
                      className="p-2 rounded-xl text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                      aria-label="Edit"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>

                    <button
                      type="button"
                      onClick={() => setDeletingId(ann.id)}
                      className="p-2 rounded-xl text-ink-muted hover:text-red-500 hover:bg-red-500/5 transition-colors"
                      aria-label="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </motion.div>
            )
          })}
        </div>
      )}

      {/* Delete Confirmation */}
      <AnimatePresence>
        {deletingId && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm"
            onClick={() => !deleteLoading && setDeletingId(null)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-canvas-elevated rounded-2xl border border-glass-border shadow-2xl p-6 max-w-sm w-full mx-4"
            >
              <h3 className="text-lg font-semibold text-ink mb-2">Delete Announcement</h3>
              <p className="text-sm text-ink-secondary mb-6">
                This will permanently remove the announcement. This action cannot be undone.
              </p>
              <div className="flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setDeletingId(null)}
                  disabled={deleteLoading}
                  className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={deleteLoading}
                  className="px-4 py-2 rounded-xl bg-red-500 hover:bg-red-600 text-white text-sm font-medium shadow-lg shadow-red-500/20 transition-all disabled:opacity-50 flex items-center gap-2"
                >
                  {deleteLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  Delete
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className={`fixed bottom-6 right-6 z-[200] flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-medium shadow-lg border ${
              toast.variant === 'error'
                ? 'bg-red-500/10 border-red-500/20 text-red-600 dark:text-red-400'
                : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400'
            }`}
          >
            {toast.variant === 'error' ? <AlertCircle className="w-4 h-4" /> : <Check className="w-4 h-4" />}
            {toast.message}
            <button
              onClick={() => setToast(null)}
              className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}


