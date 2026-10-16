export type Tone = 'info' | 'success' | 'warn' | 'error'

export const toneColor: Record<Tone, string> = {
  info: 'var(--accent)',
  success: 'var(--ok)',
  warn: 'var(--warn)',
  error: 'var(--err)',
}
