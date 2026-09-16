/* @jsx h */
import type { Elements, RenderElement } from 'claude-code'
import {
  ago,
  firstRows,
  type Known,
  layoutRows,
  type Lookup,
  oneLine,
  parseDate,
  plural,
  PRIORITY_COLOR,
  relativeDays,
  type Row,
  shortDate,
  shortDateTime,
  statusOf,
  type Ticket,
} from './ticket.ts'

// bw-peek: the two drawings. The pane is the ticket viewer: a search box, then the digest, the
// title, the description (collapsed past a few rows) and the comments (a digest each, expandable).
// The mention row sits under a reply that names tickets: one button per id. Both are pure functions
// of a View, with the actions handed in as closures, so this file never touches the engine.

// the element table of a surface that has an Input (the terminal and the desktop; mobile has none
// yet, and the pane hook passes there)
export type Els = Elements['terminal'] | Elements['desktop']
// any surface's table: what the mention row, Box, Text and Button only, takes
export type AnyEls = Elements[keyof Elements]

export type Actions = {
  open: (id: string) => void
  submit: (value: string) => void
  input: (value: string) => void
  refresh: () => void
  close: () => void
  toggleDescription: () => void
  toggleComment: (index: number) => void
  forgetRecent: () => void
}

export type View = {
  // the id the pane shows, and what bw said about it (absent while the first fetch runs)
  current?: string
  lookup?: Lookup
  // a fetch for `current` is in flight
  pending: boolean
  descriptionExpanded: boolean
  openComments: ReadonlySet<number>
  recent: readonly string[]
  // the search field's text, as the person has typed it
  search: string
  defaultPrefix?: string
  // what makes an id in a description or comment a button: the registry's prefixes, this board's ids
  matcher?: RegExp
  known?: Known
  now: number
  collapsedRows: number
  digestChars: number
}

const MAX_CANDIDATES = 40
const RECENT_SHOWN = 8

// ---- small pieces ---------------------------------------------------------------------------------

function idButton(els: AnyEls, id: string, actions: Actions, keyPrefix: string, dim = true): RenderElement {
  const { Box, Button } = els
  return (
    <Box key={`${keyPrefix}-${id}`} marginRight={1}>
      <Button key={`${keyPrefix}-${id}`} label={id} dimColor={dim} onPress={() => actions.open(id)} />
    </Box>
  )
}

function divider(els: Els, columns: number): RenderElement {
  const { Text } = els
  return <Text dimColor>{'─'.repeat(Math.max(0, columns))}</Text>
}

function sectionTitle(els: Els, title: string, note: string, control: RenderElement | null): RenderElement {
  const { Box, Text } = els
  return (
    <Box flexDirection="row" marginTop={1}>
      <Text bold>{title}</Text>
      <Text dimColor>{note === '' ? '' : `  ${note}`}</Text>
      {control === null ? null : <Box marginLeft={2}>{control}</Box>}
    </Box>
  )
}

// ---- the header -----------------------------------------------------------------------------------

function header(els: Els, v: View, columns: number, actions: Actions): RenderElement {
  const { Box, Text, Button, Input } = els
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" width={columns}>
        <Box flexShrink={0} marginRight={2}>
          <Text bold color="cyan">◈ Beadwork</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text bold wrap="truncate-end">{v.current ?? ''}</Text>
        </Box>
        {v.current === undefined ? null : (
          <Box flexShrink={0} marginLeft={2}>
            <Button key="refresh" label={v.pending ? '…' : 'Refresh'} dimColor onPress={actions.refresh} />
          </Box>
        )}
      </Box>
      <Box width={columns}>
        <Input
          key="search"
          placeholder={v.defaultPrefix === undefined ? 'ticket id, e.g. adf-c50' : `ticket id, e.g. ${v.defaultPrefix}-c50 or c50`}
          value={v.search}
          submitLabel="open"
          autoFocus
          onInput={(value: string) => actions.input(value)}
          onSubmit={(value: string) => actions.submit(value)}
        />
      </Box>
      {divider(els, columns)}
    </Box>
  )
}

// a laid-out text: one Box per row, ids as buttons in place. Keys carry the row and column so a text
// that names one ticket twice draws two working buttons.
function paragraph(els: Els, rows: Row[], keyPrefix: string, actions: Actions, color?: string): RenderElement {
  const { Box, Text, Button } = els
  return (
    <Box flexDirection="column">
      {rows.map((row, r) =>
        row.length === 0 ? (
          <Text key={`${keyPrefix}-r${r}`}> </Text>
        ) : (
          <Box key={`${keyPrefix}-r${r}`} flexDirection="row">
            {row.map((piece, c) =>
              piece.kind === 'id' ? (
                <Button key={`${keyPrefix}-${r}-${c}`} label={piece.id} onPress={() => actions.open(piece.id)} />
              ) : (
                <Text key={`${keyPrefix}-${r}-${c}`} color={color}>{piece.text}</Text>
              ),
            )}
          </Box>
        ),
      )}
    </Box>
  )
}

// ---- a ticket -------------------------------------------------------------------------------------

function digest(els: Els, t: Ticket, v: View, columns: number): RenderElement {
  const { Box, Text } = els
  const st = statusOf(t)
  const parts: RenderElement[] = []
  const part = (key: string, node: RenderElement) =>
    parts.push(
      <Box key={`d-${key}`} flexShrink={0} marginRight={2}>
        {node}
      </Box>,
    )

  part('status', <Text color={st.color} dimColor={st.dim} bold>{`${st.glyph} ${st.word}`}</Text>)
  part('prio', <Text color={PRIORITY_COLOR[t.priority] ?? 'white'} bold>{`P${t.priority}`}</Text>)
  part('type', <Text>{t.type}</Text>)
  if (t.labels.length > 0) part('labels', <Text color="magenta">{`⚑ ${t.labels.join(', ')}`}</Text>)
  if (t.assignee !== '') part('assignee', <Text color="blue">{`@${t.assignee}`}</Text>)

  const due = parseDate(t.due)
  if (due !== undefined) {
    const overdue = due < v.now && t.status !== 'closed'
    part('due', <Text color={overdue ? 'red' : 'yellow'} bold={overdue}>{`⏰ ${overdue ? 'overdue' : 'due'} ${shortDate(due, v.now)} (${relativeDays(due, v.now)})`}</Text>)
  }
  const defer = parseDate(t.deferUntil)
  if (defer !== undefined && t.status === 'deferred') {
    const dueNow = defer <= v.now
    part('defer', <Text color="cyan">{`❄ until ${shortDate(defer, v.now)}${dueNow ? ' (now due)' : ` (${relativeDays(defer, v.now)})`}`}</Text>)
  }

  const created = parseDate(t.created)
  const closed = parseDate(t.closedAt)
  const updated = parseDate(t.updatedAt)
  const when: string[] = []
  if (created !== undefined) when.push(`created ${shortDate(created, v.now)}`)
  if (closed !== undefined) when.push(`closed ${shortDate(closed, v.now)}`)
  else if (updated !== undefined && created !== undefined && updated - created > 60_000) when.push(`updated ${ago(updated, v.now)}`)
  if (when.length > 0) part('when', <Text dimColor>{when.join(' · ')}</Text>)

  return (
    <Box flexDirection="row" flexWrap="wrap" width={columns}>
      {parts}
    </Box>
  )
}

function relations(els: Els, t: Ticket, actions: Actions): RenderElement | null {
  const { Box, Text } = els
  const groups: RenderElement[] = []
  const group = (key: string, word: string, ids: readonly string[]) => {
    if (ids.length === 0) return
    groups.push(
      <Box key={`rel-${key}`} flexDirection="row" flexShrink={0} marginRight={2}>
        <Box marginRight={1}>
          <Text dimColor>{word}</Text>
        </Box>
        {ids.map(id => idButton(els, id, actions, `rel-${key}`))}
      </Box>,
    )
  }
  if (t.parent !== undefined) group('parent', 'parent', [t.parent])
  group('blockedby', t.blockedBy.length === 1 ? 'blocked by' : `blocked by ${t.blockedBy.length}:`, t.blockedBy)
  group('blocks', t.blocks.length === 1 ? 'blocks' : `blocks ${t.blocks.length}:`, t.blocks)
  if (groups.length === 0) return null
  return (
    <Box flexDirection="row" flexWrap="wrap">
      {groups}
    </Box>
  )
}

function description(els: Els, t: Ticket, v: View, columns: number, actions: Actions): RenderElement {
  const { Box, Text, Button } = els
  const body = t.description.trim()
  const width = Math.max(10, columns - 2)
  if (body === '') return sectionTitle(els, 'Description', '(none)', null)
  const rows = layoutRows(body, width, v.matcher, v.known)
  const collapsible = rows.length > v.collapsedRows
  const control = collapsible ? (
    <Button key="desc-toggle" label={v.descriptionExpanded ? 'Collapse' : `Show all`} dimColor onPress={actions.toggleDescription} />
  ) : null
  const cut = collapsible && !v.descriptionExpanded ? firstRows(rows, v.collapsedRows, width) : { shown: rows, hidden: 0 }
  return (
    <Box flexDirection="column">
      {sectionTitle(els, 'Description', plural(rows.length, 'row'), control)}
      <Box marginLeft={2} width={width} flexDirection="column">
        {paragraph(els, cut.shown, 'desc', actions)}
        {cut.hidden > 0 ? <Text dimColor>{`… ${plural(cut.hidden, 'more row')}`}</Text> : null}
      </Box>
    </Box>
  )
}

function comments(els: Els, t: Ticket, v: View, columns: number, actions: Actions): RenderElement {
  const { Box, Text, Button } = els
  if (t.comments.length === 0) return sectionTitle(els, 'Comments', '(none)', null)
  const width = Math.max(10, columns - 2)
  return (
    <Box flexDirection="column">
      {sectionTitle(els, `Comments (${t.comments.length})`, '', null)}
      {t.comments.map((c, i) => {
        const open = v.openComments.has(i)
        const at = parseDate(c.at)
        return (
          <Box key={`c-${i}`} flexDirection="column" marginLeft={2}>
            <Box flexDirection="row" width={width}>
              <Box flexShrink={0} marginRight={1}>
                <Button key={`c-toggle-${i}`} label={open ? '−' : '+'} dimColor onPress={() => actions.toggleComment(i)} />
              </Box>
              <Box flexShrink={0} marginRight={1}>
                <Text dimColor>{at === undefined ? '' : shortDateTime(at, v.now)}</Text>
              </Box>
              <Box flexShrink={1} flexGrow={1}>
                <Text wrap="truncate-end" dimColor={open}>{open ? '' : oneLine(c.text, v.digestChars)}</Text>
              </Box>
            </Box>
            {open ? (
              <Box marginLeft={6} width={Math.max(10, width - 6)} borderStyle="round" borderDimColor paddingX={1}>
                {paragraph(els, layoutRows(c.text.trim(), Math.max(4, width - 10), v.matcher, v.known), `c-${i}`, actions)}
              </Box>
            ) : null}
          </Box>
        )
      })}
    </Box>
  )
}

function ticketView(els: Els, t: Ticket, v: View, columns: number, actions: Actions): RenderElement {
  const { Box, Text } = els
  const rel = relations(els, t, actions)
  return (
    <Box flexDirection="column" marginTop={1}>
      {digest(els, t, v, columns)}
      <Box marginTop={1} width={columns}>
        <Text bold wrap="wrap">{t.title}</Text>
      </Box>
      {rel === null ? null : <Box marginTop={1}>{rel}</Box>}
      {t.closeReason === undefined ? null : (
        <Box marginTop={1} width={columns}>
          {paragraph(els, layoutRows(`↳ ${t.closeReason.trim()}`, columns, v.matcher, v.known), 'why', actions, 'green')}
        </Box>
      )}
      {description(els, t, v, columns, actions)}
      {comments(els, t, v, columns, actions)}
    </Box>
  )
}

// ---- the other outcomes ---------------------------------------------------------------------------

function ambiguous(els: Els, id: string, candidates: readonly string[], actions: Actions): RenderElement {
  const { Box, Text } = els
  const shown = candidates.slice(0, MAX_CANDIDATES)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text bold color="yellow">{id}</Text>
        <Text>{` matches ${plural(candidates.length, 'ticket')}${candidates.length > shown.length ? ` (first ${shown.length} shown)` : ''}:`}</Text>
      </Text>
      <Box flexDirection="row" flexWrap="wrap" marginTop={1} marginLeft={2}>
        {shown.map(c => idButton(els, c, actions, 'cand', false))}
      </Box>
    </Box>
  )
}

function empty(els: Els, v: View): RenderElement {
  const { Box, Text } = els
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      <Text dimColor>Type a ticket id in the box and press Enter, or press an id under a reply.</Text>
      <Text dimColor>{`Full ids work across every repo bw knows (adf-c50, think-1pp)${v.defaultPrefix === undefined ? '.' : `; a bare c50 means ${v.defaultPrefix}-c50 here.`}`}</Text>
    </Box>
  )
}

function body(els: Els, v: View, columns: number, actions: Actions): RenderElement {
  const { Box, Text } = els
  const l = v.lookup
  if (v.current === undefined) return empty(els, v)
  if (l === undefined)
    return (
      <Box marginTop={1} marginLeft={2}>
        <Text dimColor>{v.pending ? `… asking bw about ${v.current}` : `nothing known about ${v.current} yet`}</Text>
      </Box>
    )
  switch (l.kind) {
    case 'ticket':
      return ticketView(els, l.ticket, v, columns, actions)
    case 'ambiguous':
      return ambiguous(els, l.id, l.candidates, actions)
    case 'missing':
      return (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Text color="red">{`✗ no ticket matches ${l.id}`}</Text>
          <Text dimColor>bw looks the prefix up in ~/.beadwork/registry.json; a repo joins it the first time bw runs there.</Text>
        </Box>
      )
    default:
      return (
        <Box marginTop={1} marginLeft={2} width={columns}>
          <Text color="red" wrap="wrap">{`✗ ${l.message}`}</Text>
        </Box>
      )
  }
}

function recentRow(els: Els, v: View, actions: Actions): RenderElement | null {
  const { Box, Text, Button } = els
  const ids = v.recent.filter(id => id !== v.current).slice(0, RECENT_SHOWN)
  if (ids.length === 0) return null
  return (
    <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
      <Box marginRight={1}>
        <Text dimColor>recent</Text>
      </Box>
      {ids.map(id => idButton(els, id, actions, 'recent'))}
      <Button key="forget" label="forget" dimColor onPress={actions.forgetRecent} />
    </Box>
  )
}

export function drawPane(els: Els, v: View, columns: number, actions: Actions): RenderElement {
  const { Box, Text } = els
  return (
    <Box flexDirection="column" width={columns}>
      {header(els, v, columns, actions)}
      {body(els, v, columns, actions)}
      {recentRow(els, v, actions)}
      <Box marginTop={1}>
        <Text dimColor>{'esc closes · type an id and press enter · /bw <id> from the prompt'}</Text>
      </Box>
    </Box>
  )
}

// ---- under a reply --------------------------------------------------------------------------------

// one row: ◈ [ adf-c50 ] [ adf-zu6 ] +3 more
export function drawMentions(els: AnyEls, ids: readonly string[], cap: number, actions: Actions): RenderElement {
  const { Box, Text } = els
  const shown = ids.slice(0, Math.max(1, cap))
  const more = ids.length - shown.length
  return (
    <Box flexDirection="row" flexWrap="wrap" marginLeft={2}>
      <Box marginRight={1}>
        <Text color="cyan" dimColor>◈</Text>
      </Box>
      {shown.map(id => idButton(els, id, actions, 'mention'))}
      {more > 0 ? <Text dimColor>{`+${more} more`}</Text> : null}
    </Box>
  )
}
