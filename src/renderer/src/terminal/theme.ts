import type { ITheme } from '@xterm/xterm'

// Matches the app tokens in ui/tokens.css (xterm takes literal colours, not CSS variables).
export const terminalTheme: ITheme = {
  background: '#0b0d12',
  foreground: '#e6e8ee',
  cursor: '#5b8cff',
  cursorAccent: '#0b0d12',
  selectionBackground: 'rgb(91 140 255 / 0.35)',
  black: '#181c25',
  red: '#ef5b5b',
  green: '#2fbf71',
  yellow: '#f2a93b',
  blue: '#5b8cff',
  magenta: '#b985f5',
  cyan: '#4cc9d9',
  white: '#c9ced9',
  brightBlack: '#5d6579',
  brightRed: '#ff7a7a',
  brightGreen: '#52d98d',
  brightYellow: '#ffc361',
  brightBlue: '#82a8ff',
  brightMagenta: '#cfa5ff',
  brightCyan: '#7ae0ec',
  brightWhite: '#e6e8ee',
}
