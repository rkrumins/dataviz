import { Sun, Moon } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useTheme } from '@/hooks/useTheme'

export function ThemeToggle() {
  const { resolved, toggle } = useTheme()

  return (
    <button
      onClick={toggle}
      className="relative p-2 rounded-lg text-ink-secondary hover:text-ink hover:bg-canvas-elevated transition-colors"
      aria-label={`Switch to ${resolved === 'dark' ? 'light' : 'dark'} mode`}
    >
      <AnimatePresence mode="wait" initial={false}>
        {resolved === 'dark' ? (
          <motion.div
            key="sun"
            initial={{ rotate: -90, opacity: 0 }}
            animate={{ rotate: 0, opacity: 1 }}
            exit={{ rotate: 90, opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <Sun size={18} />
          </motion.div>
        ) : (
          <motion.div
            key="moon"
            initial={{ rotate: 90, opacity: 0 }}
            animate={{ rotate: 0, opacity: 1 }}
            exit={{ rotate: -90, opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <Moon size={18} />
          </motion.div>
        )}
      </AnimatePresence>
    </button>
  )
}
