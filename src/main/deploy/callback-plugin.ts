/**
 * Source of `opsdeck_jsonl.py`, written to `<rundir>/callback_plugins/` at run time. It is the stdout callback:
 * every line on stdout is one JSON object, flushed after each write (events.ts reads them).
 *
 *   {event: 'task_start', name, tags}
 *   {event: 'ok'|'failed'|'skipped'|'unreachable', host, task, tags, rc, changed, attempts, stdout, stderr, msg, no_log, truncated, ignored}
 *   {event: 'rescued', host, count}      (from the stats; a rescued failure was already reported as 'failed')
 *   {event: 'stats', hosts}
 *   {event: 'warning', msg}              (deprecation warnings are dropped)
 *
 * stdout / stderr / msg are capped at 64 KiB each (`truncated` names what was cut) and are left out entirely
 * whenever no_log is set on the task or the result.
 */
export const CALLBACK_PLUGIN_SOURCE = `from __future__ import absolute_import, division, print_function

__metaclass__ = type

DOCUMENTATION = """
    name: opsdeck_jsonl
    type: stdout
    short_description: OpsDeck JSON-lines events
    description:
      - Writes one JSON object per line for OpsDeck. Output of no_log tasks is never written.
"""

import json
import sys

from ansible.plugins.callback import CallbackBase

CAP = 65536


def _cap(value):
    """Returns (text, cut) with text at most CAP bytes of UTF-8."""
    if value is None:
        return None, False
    if not isinstance(value, str):
        try:
            value = json.dumps(value, default=str)
        except Exception:
            value = str(value)
    raw = value.encode("utf-8", "replace")
    if len(raw) <= CAP:
        return value, False
    return raw[:CAP].decode("utf-8", "ignore"), True


class CallbackModule(CallbackBase):
    CALLBACK_VERSION = 2.0
    CALLBACK_TYPE = "stdout"
    CALLBACK_NAME = "opsdeck_jsonl"

    def __init__(self):
        super(CallbackModule, self).__init__()
        self._out = sys.stdout
        display = self._display
        display.warning = self._warning
        display.deprecated = self._drop

    def _emit(self, obj):
        self._out.write(json.dumps(obj) + "\\n")
        self._out.flush()

    def _drop(self, *args, **kwargs):
        return None

    def _warning(self, msg, *args, **kwargs):
        text, _ = _cap(str(msg))
        self._emit({"event": "warning", "msg": text})

    def _tags(self, task):
        return [str(t) for t in (task.tags or [])]

    def v2_playbook_on_task_start(self, task, is_conditional):
        self._emit({"event": "task_start", "name": task.get_name(), "tags": self._tags(task)})

    def _result(self, kind, result, **extra):
        res = result._result
        task = result._task
        no_log = bool(task.no_log) or bool(res.get("_ansible_no_log"))
        obj = {
            "event": kind,
            "host": result._host.get_name(),
            "task": task.get_name(),
            "tags": self._tags(task),
            "no_log": no_log,
            "rc": res.get("rc") if isinstance(res.get("rc"), int) else None,
            "changed": bool(res.get("changed")),
            "attempts": res.get("attempts") if isinstance(res.get("attempts"), int) else None,
        }
        cut = []
        if not no_log:
            for key in ("stdout", "stderr", "msg"):
                text, was_cut = _cap(res.get(key))
                if text:
                    obj[key] = text
                if was_cut:
                    cut.append(key)
        obj["truncated"] = cut
        obj.update(extra)
        self._emit(obj)

    def v2_runner_on_ok(self, result):
        self._result("ok", result)

    def v2_runner_on_failed(self, result, ignore_errors=False):
        self._result("failed", result, ignored=bool(ignore_errors))

    def v2_runner_on_skipped(self, result):
        self._result("skipped", result)

    def v2_runner_on_unreachable(self, result):
        self._result("unreachable", result)

    def v2_playbook_on_stats(self, stats):
        hosts = {}
        for host in sorted(stats.processed.keys()):
            summary = stats.summarize(host)
            hosts[host] = summary
            if summary.get("rescued"):
                self._emit({"event": "rescued", "host": host, "count": summary["rescued"]})
        self._emit({"event": "stats", "hosts": hosts})
`
