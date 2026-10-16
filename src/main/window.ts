import type { BrowserWindowConstructorOptions } from 'electron'

export function windowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    title: 'OpsDeck',
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0d12',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  }
}
