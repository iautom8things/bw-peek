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

// a bare local part as the agent writes one without its prefix: `c50`, `wxh.5`, `1jf.234`. Three or
// four letters and digits, then any number of `.N`. Not preceded by a letter, digit, `_`, `.`, `-` or
// `/`, not followed by one of those, and not followed by `.` and a letter (`draw.tsx`).
const BARE_RE = /(?<![a-z0-9_./-])[a-z0-9]{3,4}(?:\.\d+)*(?![a-z0-9_-])(?!\.[a-z])/gi

// three- and four-letter words a base-36 id could spell; a ticket with one of these as its id is
// still reachable by its full id, but bare it would light up every reply
export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'the and for are but not you all can had her was one our out day get has him his how man new now old see two way who boy did its let put say she too use ' +
    'also back been best both call came come does done down each even ever fail find from give goes gone good have here home into just keep kind know last left ' +
    'life like line list live long look made make many mean more most much must name need next none once only open over part past read real said same seen ' +
    'send show side some soon sort step such sure take tell test than that them then they this time told took true turn type upon used user very want week ' +
    'well went were what when will with word work year your bash json main null void file path repo code diff node port host data text ' +
    'run add fix set top end log err api cli ssh git dev prod tmp bin lib src doc pkg app web dir cwd env var const'
  ).split(/\s+/),
)

// the ids of one board: every `<prefix>-<local>` on a page, whether the page is jq's one id per line
// or the text listing (one line per issue, the id near the front and any blocker ids after)
export function parseListIds(text: string, prefix: string): Set<string> {
  const esc = prefix.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
  const re = new RegExp(`(?<![a-z0-9_-])${esc}-[a-z0-9]{1,8}(?:\\.\\d+)*(?![a-z0-9_-])`, 'gi')
  const out = new Set<string>()
  for (const m of text.matchAll(re)) out.add(m[0].toLowerCase())
  return out
}

export type Known = { prefix: string; ids: ReadonlySet<string> }

// the distinct ids a text mentions, in order of first mention: full ids with a known prefix, and bare
// local parts that are tickets on the session's own board (never another board's; a bare id has no
// way to say which)
export function findMentions(text: string, matcher: RegExp | undefined, known?: Known): string[] {
  const hits: { at: number; id: string }[] = []
  if (matcher !== undefined) for (const m of text.matchAll(matcher)) hits.push({ at: m.index, id: m[0].toLowerCase() })
  if (known !== undefined && known.ids.size > 0)
    for (const m of text.matchAll(BARE_RE)) {
      const word = m[0].toLowerCase()
      if (STOPWORDS.has(word)) continue
      const id = `${known.prefix}-${word}`
      if (known.ids.has(id)) hits.push({ at: m.index, id })
    }
  hits.sort((a, b) => a.at - b.at)
  const seen = new Set<string>()
  const out: string[] = []
  for (const h of hits) {
    if (seen.has(h.id)) continue
    seen.add(h.id)
    out.push(h.id)
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

// ---- inline ids ----------------------------------------------------------------------------------

// a run of a line: plain text, or a ticket id drawn as a button (full id with a known prefix, or a
// bare local part that is a ticket on the session board). `text` is the id as written.
export type Piece = { kind: 'text'; text: string } | { kind: 'id'; id: string; text: string }
export type Row = Piece[]

// cells a Button takes on the terminal beyond its label: the engine's `[ ` and ` ]`
export const BUTTON_CHROME = 4

function hitsIn(text: string, matcher: RegExp | undefined, known: Known | undefined): { at: number; end: number; id: string }[] {
  const hits: { at: number; end: number; id: string }[] = []
  if (matcher !== undefined) for (const m of text.matchAll(matcher)) hits.push({ at: m.index, end: m.index + m[0].length, id: m[0].toLowerCase() })
  if (known !== undefined && known.ids.size > 0)
    for (const m of text.matchAll(BARE_RE)) {
      const word = m[0].toLowerCase()
      if (STOPWORDS.has(word)) continue
      const id = `${known.prefix}-${word}`
      if (known.ids.has(id)) hits.push({ at: m.index, end: m.index + m[0].length, id })
    }
  hits.sort((a, b) => a.at - b.at || b.end - a.end)
  // overlapping hits (a bare match inside a full id) keep the earlier, longer one
  const out: typeof hits = []
  for (const h of hits) if (out.length === 0 || h.at >= (out[out.length - 1] as { end: number }).end) out.push(h)
  return out
}

// one line as pieces, in order
export function piecesOf(line: string, matcher: RegExp | undefined, known: Known | undefined): Piece[] {
  const out: Piece[] = []
  let at = 0
  for (const h of hitsIn(line, matcher, known)) {
    if (h.at > at) out.push({ kind: 'text', text: line.slice(at, h.at) })
    out.push({ kind: 'id', id: h.id, text: line.slice(h.at, h.end) })
    at = h.end
  }
  if (at < line.length) out.push({ kind: 'text', text: line.slice(at) })
  return out
}

function widthOf(piece: Piece): number {
  return piece.kind === 'id' ? piece.id.length + BUTTON_CHROME : piece.text.length
}

// a text laid out as rows at a width: a greedy word wrap where an id is one unbreakable token as wide
// as its button, words longer than the width split, blank lines kept as empty rows. What is counted
// is what is drawn, so the collapse threshold and the ellipsis land on real rows.
export function layoutRows(text: string, width: number, matcher?: RegExp, known?: Known): Row[] {
  const w = Math.max(1, width)
  const rows: Row[] = []
  for (const line of lines(text)) {
    // tokens: words with their trailing space, ids atomic
    const tokens: Piece[] = []
    for (const piece of piecesOf(line, matcher, known)) {
      if (piece.kind === 'id') {
        tokens.push(piece)
        continue
      }
      for (const m of piece.text.matchAll(/\S+\s*|\s+/g)) tokens.push({ kind: 'text', text: m[0] })
    }
    let row: Row = []
    let used = 0
    const flush = () => {
      rows.push(merge(row))
      row = []
      used = 0
    }
    for (const t of tokens) {
      if (t.kind === 'text' && t.text.length > w) {
        // a word wider than the row: hard split
        let rest = t.text
        while (rest.length > 0) {
          const room = w - used
          if (room <= 0) flush()
          const take = rest.slice(0, w - used)
          row.push({ kind: 'text', text: take })
          used += take.length
          rest = rest.slice(take.length)
          if (used >= w && rest.length > 0) flush()
        }
        continue
      }
      // a trailing space may hang past the edge
      const need = t.kind === 'text' ? t.text.trimEnd().length : widthOf(t)
      if (row.length > 0 && used + need > w) flush()
      row.push(t)
      used += widthOf(t)
    }
    rows.push(merge(row))
  }
  return rows
}

// adjacent text pieces as one; a row's trailing spaces dropped
function merge(row: Row): Row {
  const out: Row = []
  for (const p of row) {
    const last = out[out.length - 1]
    if (p.kind === 'text' && last?.kind === 'text') last.text += p.text
    else out.push(p.kind === 'text' ? { ...p } : p)
  }
  const last = out[out.length - 1]
  if (last?.kind === 'text') {
    last.text = last.text.trimEnd()
    if (last.text === '') out.pop()
  }
  return out
}

// the first `count` rows, an ellipsis on the last when more follow
export function firstRows(rows: Row[], count: number, width: number): { shown: Row[]; hidden: number } {
  if (rows.length <= count) return { shown: rows, hidden: 0 }
  const shown = rows.slice(0, Math.max(1, count)).map(r => [...r])
  const last = shown[shown.length - 1] as Row
  const used = last.reduce((n, p) => n + widthOf(p), 0)
  const tail = last[last.length - 1]
  if (used < width) last.push({ kind: 'text', text: '…' })
  else if (tail?.kind === 'text' && tail.text.length > 0) last[last.length - 1] = { kind: 'text', text: `${tail.text.slice(0, -1)}…` }
  return { shown, hidden: rows.length - shown.length }
}

export function rowText(row: Row): string {
  return row.map(p => (p.kind === 'id' ? p.text : p.text)).join('')
}
