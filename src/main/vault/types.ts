/** The slice of Electron's clipboard the stores use; tests pass a fake. */
export interface ClipboardLike {
  writeText(text: string): void
  readText(): string
}
