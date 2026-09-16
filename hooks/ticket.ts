// bw-peek: everything about a Beadwork ticket that needs no engine. Ids, the registry's prefixes,
// the mentions in a reply, `bw show --json` parsed into a Ticket, its digest, and the small text
// helpers the drawings use. No `$` here, so `bun test` covers it directly.

export type Comment = { text: string; at: string }

export type Ticket = {
  id: string
  title: string
  description: string
  status: string
  type: string
  priority: number
  labels: string[]
  assignee: string
  created: string
  updatedAt: string
  closedAt?: string
  closeReason?: string
  due?: string
  deferUntil?: string
  parent?: string
  blockedBy: string[]
  blocks: string[]
  comments: Comment[]
}

// what one `bw show` came back as
export type Lookup =
  | { kind: 'ticket'; id: string; ticket: Ticket; at: number }
  | { kind: 'ambiguous'; id: string; candidates: string[]; at: number }
  | { kind: 'missing'; id: string; at: number }
  | { kind: 'error'; id: string; message: string; at: number }

// the local part of an id: `c50`, `wxh.5`, `1pp.4.1.1.6.2`. Typed, one character is enough
// (`think-1` asks bw for the ambiguous list); found in prose, two, so `adf-c` in a sentence is not
// a mention.
const LOCAL_TYPED = '[a-z0-9]{1,8}(?:\\.\\d+)*'
const LOCAL_MENTIONED = '[a-z0-9]{2,8}(?:\\.\\d+)*'
// a prefix as bw allows one: letters, digits, `_` and `-`, starting with a letter
const PREFIX = '[a-z][a-z0-9_-]{0,23}'
const FULL_ID_RE = new RegExp(`^(${PREFIX})-(${LOCAL_TYPED})$`)
const LOCAL_ONLY_RE = new RegExp(`^${LOCAL_TYPED}$`)

export function isTicketId(text: string): boolean {
  return FULL_ID_RE.test(text)
}

export function idParts(id: string): { prefix: string; local: string } | undefined {
  const m = FULL_ID_RE.exec(id)
  if (m === null) return undefined
  return { prefix: m[1] as string, local: m[2] as string }
}

// what the person typed, made into an id bw will take: case folded, wrapping punctuation and a
// `bw show` in front dropped, a bare local part given the session's prefix. undefined when nothing
// id-shaped is left.
export function normalizeId(raw: string, defaultPrefix?: string): string | undefined {
  const words = raw
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.replace(/^[`'"([{<*_]+|[`'"\])}>*_.,;:!?]+$/g, ''))
    .filter(w => w !== '')
  const full = words.find(w => FULL_ID_RE.test(w))
  if (full !== undefined) return full
  const local = words.find(w => LOCAL_ONLY_RE.test(w) && !/^[a-z]+$/.test(w))
  if (local !== undefined && defaultPrefix !== undefined) return `${defaultPrefix}-${local}`
  const anyLocal = words.find(w => LOCAL_ONLY_RE.test(w))
  if (anyLocal !== undefined && defaultPrefix !== undefined && words.length === 1) return `${defaultPrefix}-${anyLocal}`
  return undefined
}

// the id prefixes bw knows: ~/.beadwork/registry.json, `repos` keyed by path with a `prefix` each
export function parseRegistry(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as { repos?: Record<string, { prefix?: unknown }> }
    const repos = parsed.repos ?? {}
    const out = new Set<string>()
    for (const entry of Object.values(repos)) {
      const p = entry?.prefix
      if (typeof p === 'string' && new RegExp(`^${PREFIX}$`).test(p)) out.add(p)
    }
    return [...out].sort()
  } catch {
    return []
  }
}

// a matcher for ids with one of these prefixes, longest prefix first so `spire-cl-x1` is not read
// as `spire-...`; undefined with no prefixes, since a bare `[a-z]+-[a-z0-9]+` matches sha-256
export function mentionMatcher(prefixes: readonly string[]): RegExp | undefined {
  if (prefixes.length === 0) return undefined
  const alts = [...prefixes]
    .sort((a, b) => b.length - a.length)
    .map(p => p.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'))
    .join('|')
  return new RegExp(`(?<![a-z0-9_-])(?:${alts})-${LOCAL_MENTIONED}(?![a-z0-9_-])`, 'gi')
}

// the distinct ids a text mentions, in order of first mention
export function findMentions(text: string, matcher: RegExp | undefined): string[] {
  if (matcher === undefined) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of text.matchAll(matcher)) {
    const id = m[0].toLowerCase()
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

export function parseTicket(json: unknown): Ticket | undefined {
  if (typeof json !== 'object' || json === null) return undefined
  const j = json as Record<string, unknown>
  if (typeof j.id !== 'string' || typeof j.title !== 'string') return undefined
  const comments = Array.isArray(j.comments)
    ? j.comments
        .map(c => (typeof c === 'object' && c !== null ? (c as Record<string, unknown>) : {}))
        .map(c => ({ text: str(c.text), at: str(c.timestamp) || str(c.created) }))
        .filter(c => c.text !== '')
    : []
  return {
    id: j.id,
    title: j.title,
    description: str(j.description),
    status: str(j.status) || 'open',
    type: str(j.type) || 'task',
    priority: typeof j.priority === 'number' ? j.priority : 2,
    labels: strList(j.labels),
    assignee: str(j.assignee),
    created: str(j.created),
    updatedAt: str(j.updated_at),
    closedAt: optStr(j.closed_at),
    closeReason: optStr(j.close_reason),
    due: optStr(j.due),
    deferUntil: optStr(j.defer_until),
    parent: optStr(j.parent) ?? parentOf(j.id),
    blockedBy: strList(j.blocked_by),
    blocks: strList(j.blocks),
    comments,
  }
}

// adf-wxh.5 → adf-wxh; adf-c50 → undefined
export function parentOf(id: string): string | undefined {
  const i = id.lastIndexOf('.')
  return i > 0 ? id.slice(0, i) : undefined
}

// `bw show <id> --json` as it came back, into what the pane draws
export function parseShow(id: string, r: { exitCode: number; stdout: string; stderr: string }, at: number): Lookup {
  const err = `${r.stderr}\n${r.stdout}`.trim()
  if (r.exitCode === 0) {
    try {
      const t = parseTicket(JSON.parse(r.stdout))
      if (t !== undefined) return { kind: 'ticket', id, ticket: t, at }
    } catch {
      // fall through to the error below
    }
    return { kind: 'error', id, message: `bw show ${id} returned something other than a ticket: ${oneLine(err || r.stdout, 200)}`, at }
  }
  const amb = /ambiguous ID[^:]*:\s*matches\s+(.+)/is.exec(err)
  if (amb !== null) {
    const candidates = (amb[1] as string)
      .split(/[,\s]+/)
      .map(s => s.trim().toLowerCase())
      .filter(isTicketId)
    return { kind: 'ambiguous', id, candidates: sortIds([...new Set(candidates)]), at }
  }
  if (/no issue found/i.test(err)) return { kind: 'missing', id, at }
  return { kind: 'error', id, message: oneLine(err || `bw show exited ${r.exitCode}`, 300), at }
}

// adf-1pp before adf-1pp.2 before adf-1pp.10; digits by value
export function sortIds(ids: string[]): string[] {
  return [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

// ---- digest ---------------------------------------------------------------------------------------

export type StatusStyle = { glyph: string; word: string; color?: string; dim?: boolean }

export function statusOf(t: Ticket): StatusStyle {
  switch (t.status) {
    case 'closed':
      return { glyph: '✓', word: 'closed', color: 'green' }
    case 'in_progress':
      return { glyph: '◐', word: 'in progress', color: 'yellow' }
    case 'deferred':
      return { glyph: '❄', word: 'deferred', color: 'cyan' }
    case 'open':
      return t.blockedBy.length > 0 ? { glyph: '⊘', word: 'blocked', color: 'red' } : { glyph: '○', word: 'open', color: 'white' }
    default:
      return { glyph: '•', word: t.status.replace(/_/g, ' '), dim: true }
  }
}

export const PRIORITY_COLOR: Record<number, string> = { 0: 'redBright', 1: 'red', 2: 'yellow', 3: 'blue', 4: 'gray' }

// ---- time ----------------------------------------------------------------------------------------

const DAY = 86_400_000

// the ms of a bw date: RFC3339, or a bare YYYY-MM-DD read as local midnight
export function parseDate(text: string | undefined): number | undefined {
  if (text === undefined || text === '') return undefined
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (m !== null) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  const t = Date.parse(text)
  return Number.isNaN(t) ? undefined : t
}

// Sep 16, or May 31 2025 when the year is not this one
export function shortDate(ms: number, now: number): string {
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString([], sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

export function shortDateTime(ms: number, now: number): string {
  return `${shortDate(ms, now)} ${new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

// "in 3d", "4d ago", "today"; whole days
export function relativeDays(ms: number, now: number): string {
  const days = Math.round((ms - now) / DAY)
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days === -1) return 'yesterday'
  return days > 0 ? `in ${days}d` : `${-days}d ago`
}

// "2h ago", "3d ago", "just now"
export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return shortDate(ms, now)
}

// ---- text ----------------------------------------------------------------------------------------

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (max <= 1) return flat.slice(0, Math.max(0, max))
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

// a text as lines, trailing blank lines dropped
export function lines(text: string): string[] {
  const out = text.replace(/\r\n?/g, '\n').split('\n')
  while (out.length > 0 && (out[out.length - 1] as string).trim() === '') out.pop()
  return out
}

// the text as the rows it takes at a width: a greedy word wrap, words longer than the width split.
// The drawings hand Text these rows joined with newlines, so what is counted is what is drawn.
export function wrapRows(text: string, columns: number): string[] {
  const w = Math.max(1, columns)
  const out: string[] = []
  for (const line of lines(text)) {
    if (line.length <= w) {
      out.push(line)
      continue
    }
    let row = ''
    for (const word of line.split(' ')) {
      let rest = word
      while (rest.length > w) {
        if (row !== '') {
          out.push(row)
          row = ''
        }
        out.push(rest.slice(0, w))
        rest = rest.slice(w)
      }
      if (row === '') row = rest
      else if (row.length + 1 + rest.length <= w) row += ` ${rest}`
      else {
        out.push(row)
        row = rest
      }
    }
    out.push(row)
  }
  return out
}

// how many rows a text takes at a width; the pane's collapse threshold reads this
export function rowsAt(text: string, columns: number): number {
  return wrapRows(text, columns).length
}

// the first `rows` rows of a text at a width, an ellipsis on the last when more follow
export function firstRows(text: string, rows: number, columns: number): { shown: string; hidden: number } {
  const all = wrapRows(text, columns)
  if (all.length <= rows) return { shown: all.join('\n'), hidden: 0 }
  const kept = all.slice(0, Math.max(1, rows))
  const last = kept[kept.length - 1] as string
  kept[kept.length - 1] = last.length >= columns ? `${last.slice(0, Math.max(0, columns - 1))}…` : `${last}…`
  return { shown: kept.join('\n'), hidden: all.length - kept.length }
}
