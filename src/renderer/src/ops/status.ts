import type { RunHostState } from '../../../shared/ops'

/** The host is working on the command: connecting or running it. */
export const isLive = (state: RunHostState) => state === 'connecting' || state === 'running'
/** The host finished without success: a non-zero exit or the timeout. */
export const isBad = (state: RunHostState) => state === 'failed' || state === 'timeout'
