import { motion } from 'framer-motion'

interface CardProps {
  children: React.ReactNode
  className?: string
  accentColor?: string
  hover?: boolean
}

export function Card({ children, className = '', accentColor, hover = true }: CardProps) {
  return (
    <motion.div
      className={`glass-panel rounded-2xl p-6 ${className}`}
      style={accentColor ? { borderTop: `2px solid ${accentColor}` } : undefined}
      whileHover={hover ? { y: -4, boxShadow: '0 16px 48px rgba(0, 0, 0, 0.16)' } : undefined}
      transition={{ duration: 0.2 }}
    >
      {children}
    </motion.div>
  )
}
