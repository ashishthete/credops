// Imported by the renderer: no node or electron imports.

/** `code` lets callers tell a missing confirmation or a refusal from a failure; IPC carries the message only. */
export class DeployError extends Error {
  constructor(
    readonly code: 'CONFIRM_REQUIRED' | 'DENIED' | 'BUSY' | 'INVALID_STATE' | 'VALIDATION',
    message: string,
  ) {
    super(message)
    this.name = 'DeployError'
  }
}
