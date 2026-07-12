import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { Backdrop } from '@/components/ui/Backdrop'
import { DataSourceProfile } from './DataSourceProfile'

export function DataSourceProfileDrawer({ catalogId, isOpen, onClose }: {
  catalogId: string | null
  isOpen: boolean
  onClose: () => void
}) {
  return createPortal(
    <>
      <Backdrop open={isOpen && !!catalogId} onClick={onClose} />

      <AnimatePresence>
        {isOpen && catalogId && (
          <motion.div
            role="dialog" aria-label="Data source profile"
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 400, damping: 40 }}
            className="fixed right-0 top-0 z-50 h-full w-full max-w-2xl overflow-y-auto bg-canvas border-l border-glass-border shadow-2xl"
          >
            <div className="sticky top-0 z-10 flex items-center justify-end p-3 bg-canvas/80 backdrop-blur">
              <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-5 pb-8">
              <DataSourceProfile catalogId={catalogId} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>,
    document.body,
  )
}
