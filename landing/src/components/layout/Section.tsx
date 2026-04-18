import { motion } from 'framer-motion'
import { useReducedMotion } from '@/hooks/useReducedMotion'

interface SectionProps {
  id: string
  children: React.ReactNode
  className?: string
  alt?: boolean
}

export function Section({ id, children, className = '', alt = false }: SectionProps) {
  const reduced = useReducedMotion()

  return (
    <section
      id={id}
      className={`py-24 lg:py-32 ${alt ? 'section-alt' : ''} ${className}`}
    >
      <motion.div
        className="max-w-7xl mx-auto px-6 lg:px-8"
        initial={reduced ? false : { opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-80px' }}
        transition={{ duration: reduced ? 0 : 0.6, ease: 'easeOut' }}
      >
        {children}
      </motion.div>
    </section>
  )
}
