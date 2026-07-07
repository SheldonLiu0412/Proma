import type { BrowserWindowConstructorOptions } from 'electron'

interface PromaPreloadWebPreferencesOptions {
  partition?: string
}

type WebPreferences = NonNullable<BrowserWindowConstructorOptions['webPreferences']>

export function createPromaPreloadWebPreferences(
  preloadPath: string,
  options: PromaPreloadWebPreferencesOptions = {},
): WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    ...options,
  }
}
