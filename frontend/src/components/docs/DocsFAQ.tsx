import { useState } from 'react'
import { ChevronDown, HelpCircle } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import { faqEntries } from './docsConfig'
import { markdownComponents } from './MarkdownComponents'

export function DocsFAQ() {
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  // Group entries by category
  const categories = Array.from(new Set(faqEntries.map((e) => e.category)))
  const grouped = categories.map((cat) => ({
    category: cat,
    items: faqEntries.filter((e) => e.category === cat),
  }))

  // Compute global index for each item
  let globalIdx = 0
  const indexedGroups = grouped.map((group) => ({
    ...group,
    items: group.items.map((item) => ({ ...item, idx: globalIdx++ })),
  }))

  return (
    <div className="max-w-3xl mx-auto px-8 py-10">
      {/* Header */}
      <div className="flex items-center gap-3 mb-8">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
          <HelpCircle className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-ink">Frequently Asked Questions</h1>
          <p className="text-sm text-ink-muted">Everything you need to know about Synodic</p>
        </div>
      </div>

      {/* FAQ groups */}
      <div className="space-y-8">
        {indexedGroups.map((group) => (
          <div key={group.category}>
            <h2 className="text-xs font-bold uppercase tracking-wider text-ink-muted mb-3 px-1">
              {group.category}
            </h2>
            <div className="space-y-2">
              {group.items.map((item) => {
                const isOpen = openIndex === item.idx
                return (
                  <div
                    key={item.idx}
                    className={cn(
                      'rounded-xl border transition-all duration-200',
                      isOpen
                        ? 'border-indigo-500/20 bg-gradient-to-r from-indigo-500/5 to-violet-500/5'
                        : 'border-glass-border bg-canvas-elevated hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
                    )}
                  >
                    <button
                      onClick={() => setOpenIndex(isOpen ? null : item.idx)}
                      className="w-full flex items-center justify-between px-4 py-3.5 text-left"
                    >
                      <span className="text-sm font-semibold text-ink pr-4">
                        {item.question}
                      </span>
                      <ChevronDown
                        className={cn(
                          'w-4 h-4 text-ink-muted shrink-0 transition-transform duration-200',
                          isOpen && 'rotate-180',
                        )}
                      />
                    </button>
                    <AnimatePresence>
                      {isOpen && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2, ease: 'easeInOut' }}
                          className="overflow-hidden"
                        >
                          <div className="px-4 pb-4 prose-synodic text-sm">
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              components={markdownComponents}
                            >
                              {item.answer}
                            </ReactMarkdown>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Bottom padding */}
      <div className="h-20" />
    </div>
  )
}
