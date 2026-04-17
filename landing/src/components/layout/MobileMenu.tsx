import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/Button'

interface MobileMenuProps {
  open: boolean
  onClose: () => void
  links: { label: string; href: string }[]
  activeId: string
}

export function MobileMenu({ open, onClose, links, activeId }: MobileMenuProps) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 lg:hidden"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-canvas/80 backdrop-blur-md" onClick={onClose} />
          <motion.nav
            className="absolute top-0 right-0 w-72 h-full bg-canvas-elevated shadow-glass-lg p-6 flex flex-col"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          >
            <button onClick={onClose} className="self-end p-2 text-ink-secondary hover:text-ink">
              <X size={20} />
            </button>
            <div className="flex flex-col gap-2 mt-8">
              {links.map(({ label, href }) => (
                <a
                  key={href}
                  href={href}
                  onClick={onClose}
                  className={`px-4 py-3 rounded-xl text-sm font-medium transition-colors ${
                    activeId === href.slice(1)
                      ? 'text-accent-lineage bg-accent-lineage/10'
                      : 'text-ink-secondary hover:text-ink hover:bg-canvas-elevated'
                  }`}
                >
                  {label}
                </a>
              ))}
            </div>
            <div className="mt-auto pt-6 border-t border-[var(--nx-border-subtle)]">
              <Button href="#contact" className="w-full justify-center">
                Request a Demo
              </Button>
            </div>
          </motion.nav>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
