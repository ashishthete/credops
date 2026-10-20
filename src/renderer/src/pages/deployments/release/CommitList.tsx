import type { CommitInfo, PreflightReport } from '../../../../../shared/deploy'
import type { PickerGroup } from '../../../deploy/picker'
import { plural } from '../../../ui/common'
import { relativeTime } from '../../../ui/time'

/** Each list shows at most this many; the rest is counted. */
const SHOWN = 10

interface Section {
  key: string
  name: string
  commits: CommitInfo[]
  /** Commits not listed: past SHOWN, plus the ones git didn't return when the list may run further back. */
  more: number
}

/** What is new per selected service; a whole checkout without services is listed under the checkout. */
export function commitSections(groups: PickerGroup[], report: PreflightReport): Section[] {
  return groups.flatMap((g): Section[] => {
    const info = report.commits[g.checkout.id]
    if (!info) return []
    if (!g.services.length) {
      if (!g.whole) return []
      const list = info.commits
      return [{ key: g.checkout.id, name: g.checkout.name, commits: list.slice(0, SHOWN), more: Math.max(0, list.length - SHOWN) + info.truncated }]
    }
    return g.services
      .filter((s) => g.selected.has(s.id))
      .map((s) => {
        const since = report.serviceCommits[s.id]
        const list = info.commits.slice(0, since?.count ?? info.commits.length)
        const unknown = !since || !since.known
        return { key: s.id, name: s.name, commits: list.slice(0, SHOWN), more: Math.max(0, list.length - SHOWN) + (unknown ? info.truncated : 0) }
      })
  })
}

export function CommitList({ groups, report }: { groups: PickerGroup[]; report: PreflightReport }) {
  const sections = commitSections(groups, report)
  const notes = groups.flatMap((g) => {
    const info = report.commits[g.checkout.id]
    if (!info || (!g.selected.size && !g.whole)) return []
    return [
      ...(info.firstDeploy ? [`${g.checkout.name}: first deploy, showing the latest ${info.commits.length} commits`] : []),
      ...(info.hiddenPairs ? [`${g.checkout.name}: ${plural(info.hiddenPairs, 'revert pair')} hidden`] : []),
    ]
  })
  return (
    <section aria-label="Commits" className="flex flex-col gap-3">
      {sections.map((s) => (
        <div key={s.key} className="flex flex-col gap-1">
          <h4 className="text-[12px] font-semibold text-fg/90">
            {s.name} <span className="font-normal text-muted">{s.commits.length || s.more ? plural(s.commits.length + s.more, 'commit') : 'No new commits'}</span>
          </h4>
          <ul aria-label={s.name} className="flex flex-col gap-0.5">
            {s.commits.map((c) => (
              <li key={c.sha} className="flex min-w-0 items-baseline gap-2 text-[12px]">
                <span className="font-mono text-muted">{c.sha.slice(0, 7)}</span>
                <span className="min-w-0 flex-1 truncate text-fg/90">{c.subject}</span>
                <span className="shrink-0 text-muted">{c.author}</span>
                <span className="shrink-0 text-muted">{relativeTime(c.date)}</span>
              </li>
            ))}
          </ul>
          {s.more > 0 && <p className="text-[11.5px] text-muted">{`+${s.more} more`}</p>}
        </div>
      ))}
      {notes.map((n) => (
        <p key={n} className="text-[11.5px] text-muted">
          {n}
        </p>
      ))}
    </section>
  )
}
