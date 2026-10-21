import type { ReleaseService } from '../deploy/release-service'
import type { NotificationDispatcher } from './dispatcher'

/**
 * Feeds the desktop notification dispatcher from this machine's own release service, and from nothing else.
 * It takes the local `ReleaseService` (not the routing `ReleaseApi`, whose `onEvent` also carries Hub releases):
 * the Hub notifies for team releases itself, so a Hub run must never reach the desktop dispatcher.
 * The class is nominal (private members), so the routing API does not typecheck here; see notify-isolation.test.ts.
 */
export function wireLocalNotify(release: ReleaseService, dispatcher: Pick<NotificationDispatcher, 'onRunEvent'>): () => void {
  return release.onEvent((batch) => {
    for (const e of batch) void dispatcher.onRunEvent(e)
  })
}
