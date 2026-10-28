// Imported by the renderer: no node or electron imports.

/**
 * `code` lets callers tell a missing confirmation or a refusal from a failure; IPC carries it in front of the
 * message (shared/ipc-error). PLAYBOOK_CHANGED and REVIEW_EXPIRED are states the renderer answers by previewing
 * again; the Hub reports them, like INVALID_STATE, as a 409 conflict.
 */
export class DeployError extends Error {
  constructor(
    readonly code: 'CONFIRM_REQUIRED' | 'DENIED' | 'BUSY' | 'INVALID_STATE' | 'VALIDATION' | 'PLAYBOOK_CHANGED' | 'REVIEW_EXPIRED',
    message: string,
  ) {
    super(message)
    this.name = 'DeployError'
  }
}
