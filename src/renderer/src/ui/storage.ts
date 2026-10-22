// localStorage can be missing or throw (private windows, blocked site data); layout prefs just fall back.

export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Not persisted; the preference lasts until the next restart.
  }
}
