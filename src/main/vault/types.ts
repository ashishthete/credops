/** The slice of Electron's clipboard the stores use (async since Electron 44); tests pass a fake. */
export interface ClipboardLike {
  writeText(text: string): Promise<void> | void
  readText(): Promise<string> | string
}
