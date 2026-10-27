import type { LogEntry } from "./types.ts";

/**
 * Turns the bounded retained `Job.logs` history into the small window that
 * goes out on a check_task/get_task response. Sequence numbers survive
 * retention, so cursors continue to refer to the original event stream. See
 * docs/decisions/2026-07-27-task-contract.md and the widget simplification
 * work that motivated this file: recurring payloads carry a status/current-
 * activity projection, not a full-session transcript.
 */

/** Initial window size when the caller has no cursor yet (mount/reconnect/remount). */
export const INITIAL_WINDOW_MAX = 8;
/** Delta window size once the caller already has a cursor. */
export const DELTA_WINDOW_MAX = 5;
/** Per-entry text cap — cosmetic activity lines, not the final response. */
export const EVENT_TEXT_MAX = 240;

function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Collapses a `tool` entry immediately followed by its matching non-error
 * `tool-result` into a single representative entry. Purely a projection-time
 * transform over whatever slice it's given — never mutates or trims the
 * caller's underlying storage. An error tool-result is never collapsed: that
 * result IS the evidence something went wrong and must stay visible.
 */
export function collapseToolPairs(entries: LogEntry[]): LogEntry[] {
  const out: LogEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const next = entries[i + 1];
    if (entry.type === "tool" && next && next.type === "tool-result" && !next.isError) {
      out.push({ ts: next.ts, type: "tool", text: entry.text || next.text, seq: next.seq });
      i += 1;
      continue;
    }
    out.push(entry);
  }
  return out;
}

function boundText(entries: LogEntry[], max: number): LogEntry[] {
  return entries.map((e) => (e.text.length > max ? { ...e, text: truncateText(e.text, max) } : e));
}

export type LogWindow = {
  /** The bounded, collapsed, text-truncated entries to send this call. */
  events: LogEntry[];
  /** Cursor to hand back to the caller — always the current head, even when
   *  `events` had to drop older entries to stay bounded (see DELTA_WINDOW_MAX). */
  cursor: number;
  /** Total original events recorded server-side, including evicted entries. */
  totalCount: number;
};

/**
 * Projects `logs` (ascending `seq`, potentially trimmed) into the window a
 * check_task/get_task response should carry.
 *
 * - `cursor` undefined or 0: "initial" read (mount/reconnect/remount) — the
 *   most recent `initialMax` collapsed entries.
 * - `cursor` a prior `logCursor`: "delta" read — entries with `seq > cursor`,
 *   collapsed, then capped to the most recent `deltaMax`. When more than
 *   `deltaMax` new entries landed since the last poll (a missed-poll burst),
 *   the older ones in that gap are intentionally dropped from `events` — the
 *   returned `cursor` still advances to the true head, so no entry is ever
 *   resent (no duplicate history) and the next call starts clean. This is
 *   safe because the dropped entries are cosmetic tool/lifecycle activity,
 *   never the terminal summary/artifacts, which ride outside this window.
 */
export function projectLogWindow(
  logs: LogEntry[],
  cursor: number | undefined,
  opts: { initialMax?: number; deltaMax?: number; textMax?: number } = {},
): LogWindow {
  const initialMax = opts.initialMax ?? INITIAL_WINDOW_MAX;
  const deltaMax = opts.deltaMax ?? DELTA_WINDOW_MAX;
  const textMax = opts.textMax ?? EVENT_TEXT_MAX;
  const head = logs.at(-1)?.seq ?? (logs.length || cursor || 0);
  const totalCount = head;
  const marker = logs[0]?.type === "truncation" ? logs[0] : undefined;
  const keepMarker = (entries: LogEntry[], max: number): LogEntry[] => {
    if (!marker || (cursor && (marker.seq ?? 0) <= cursor)) return entries.slice(-max);
    return [
      marker,
      ...entries.filter((entry) => entry !== marker).slice(-Math.max(0, max - 1)),
    ].slice(0, max);
  };

  if (!cursor) {
    const windowed = keepMarker(collapseToolPairs(logs), initialMax);
    return { events: boundText(windowed, textMax), cursor: head, totalCount };
  }

  const fresh = logs.filter((e) => (e.seq ?? 0) > cursor);
  const windowed = keepMarker(collapseToolPairs(fresh), deltaMax);
  return { events: boundText(windowed, textMax), cursor: head, totalCount };
}
