import type { FastifyInstance } from 'fastify'
import { hashToken } from '../auth/sessions'
import type { makeAuth } from '../auth/plugin'
import type { LiveBus } from '../live/bus'

/** A reader that falls this far behind is dropped instead of buffering without bound. */
const MAX_BACKLOG_BYTES = 1_000_000

export function registerLive(app: FastifyInstance, deps: { live: LiveBus; auth: ReturnType<typeof makeAuth>; now: () => Date }): void {
  const { live, auth, now } = deps
  app.get('/api/v1/live', { onRequest: auth.requireUser }, (req, reply) => {
    const raw = reply.raw
    reply.hijack()
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    raw.write(': live\n\n')
    const off = live.subscribe(
      req.user.oid,
      (frame) => {
        if (raw.destroyed || raw.writableEnded || raw.writableLength > MAX_BACKLOG_BYTES) throw new Error('stream not writable')
        raw.write(frame)
      },
      // Hard close: a graceful end() would wait for a client that is not reading.
      () => raw.destroy(),
      hashToken(req.sessionToken),
      req.sessionExpiresAt,
    )
    // An idle stream still ends at the session's deadline.
    const wait = Math.max(0, req.sessionExpiresAt - now().getTime())
    const timer = setTimeout(() => live.closeExpired(), Math.min(wait, 2 ** 31 - 1))
    timer.unref()
    raw.on('close', () => {
      clearTimeout(timer)
      off()
    })
  })
}
