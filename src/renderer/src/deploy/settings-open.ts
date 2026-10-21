/**
 * Whether each environment's Settings section is open, for this session: it opens by itself only the first time
 * an environment is shown, and after that keeps what it was (or what the user made it).
 */
const open = new Map<string, boolean>()

export const settingsOpen = (envId: string): boolean | undefined => open.get(envId)
export const rememberSettingsOpen = (envId: string, value: boolean): void => void open.set(envId, value)
export const resetSettingsOpen = (): void => open.clear()
