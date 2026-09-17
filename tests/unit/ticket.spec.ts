import { describe, expect, test } from 'bun:test'
import type { Row } from '../../hooks/ticket.ts'
import {
  ago,
  findMentions,
  idParts,
  isTicketId,
  mentionMatcher,
  normalizeId,
  parentOf,
  parseDate,
  parseChildren,
  parseListIds,
  parseRegistry,
  parseRegistryPaths,
  parseShow,
  parseTicket,
  relativeDays,
  firstRows,
  layoutRows,
  piecesOf,
  prefixOf,
  rowText,
  sortIds,
  statusOf,
} from '../../hooks/ticket.ts'

const T0 = new Date('2026-09-16T10:00:00').getTime()
const DAY = 86_400_000

const SHOWN = {
  assignee: '',
  blocked_by: [],
  blocks: ['adf-lxh'],
  closed_at: '2026-09-16T14:40:16Z',
  close_reason: 'Shipped on main at 392b2a60',
  created: '2026-09-16T13:16:44Z',
  description: 'Ready-for: implement\n\nDeliverable: a plugin.',
  id: 'adf-c50',
  labels: ['slug:live-activity-function-hooks'],
  comments: [{ text: 'Committed a7507330 on branch live-activity', timestamp: '2026-09-16T13:44:53Z' }],
  priority: 1,
  status: 'closed',
  title: 'live-activity: function-hooks plugin',
  type: 'feature',
  updated_at: '2026-09-16T14:40:16Z',
}

describe('ids', () => {
  test('recognises bw ids, with dotted children', () => {
    expect(isTicketId('adf-c50')).toBe(true)
    expect(isTicketId('adf-wxh.5')).toBe(true)
    expect(isTicketId('think-1pp.4.1.1.6.2')).toBe(true)
    expect(isTicketId('spire-cl-a3f8')).toBe(true)
    // a typed partial is an id to ask bw about (it answers with the ambiguous list)
    expect(isTicketId('think-1')).toBe(true)
    expect(isTicketId('adf-')).toBe(false)
    expect(isTicketId('c50')).toBe(false)
  })

  test('splits prefix and local part, longest prefix wins', () => {
    expect(idParts('adf-c50')).toEqual({ prefix: 'adf', local: 'c50' })
    expect(idParts('spire-cl-a3f8')).toEqual({ prefix: 'spire-cl', local: 'a3f8' })
    expect(idParts('nope')).toBeUndefined()
  })

  test('parent is the id before the last dot', () => {
    expect(parentOf('adf-wxh.5')).toBe('adf-wxh')
    expect(parentOf('think-1pp.4.1')).toBe('think-1pp.4')
    expect(parentOf('adf-c50')).toBeUndefined()
  })

  test('sorts numerically inside a family', () => {
    expect(sortIds(['adf-1pp.10', 'adf-1pp.2', 'adf-1pp', 'adf-1av'])).toEqual(['adf-1av', 'adf-1pp', 'adf-1pp.2', 'adf-1pp.10'])
  })
})

describe('normalizeId', () => {
  test('takes the id as typed, in any case, with wrapping punctuation', () => {
    expect(normalizeId('adf-c50')).toBe('adf-c50')
    expect(normalizeId('  ADF-C50. ')).toBe('adf-c50')
    expect(normalizeId('`adf-c50`')).toBe('adf-c50')
    expect(normalizeId('(think-1pp.4),')).toBe('think-1pp.4')
    expect(normalizeId('[adf-c50]')).toBe('adf-c50')
  })

  test('finds the id inside a pasted command or sentence', () => {
    expect(normalizeId('bw show adf-c50 --json')).toBe('adf-c50')
    expect(normalizeId('see adf-zu6 and adf-ana', 'adf')).toBe('adf-zu6')
  })

  test('a bare local part takes the default prefix, and only with one', () => {
    expect(normalizeId('c50', 'adf')).toBe('adf-c50')
    expect(normalizeId('wxh.5', 'adf')).toBe('adf-wxh.5')
    expect(normalizeId('1pp', 'think')).toBe('think-1pp')
    expect(normalizeId('c50')).toBeUndefined()
  })

  test('a single word of letters with a default prefix is still tried, in a sentence it is not', () => {
    expect(normalizeId('abc', 'adf')).toBe('adf-abc')
    expect(normalizeId('show me abc', 'adf')).toBeUndefined()
  })

  test('nothing id-shaped is undefined', () => {
    expect(normalizeId('')).toBeUndefined()
    expect(normalizeId('hello there', 'adf')).toBeUndefined()
    expect(normalizeId('--json')).toBeUndefined()
  })
})

describe('registry and mentions', () => {
  // as `bw registry list --json` prints it
  const registry = JSON.stringify([
    { path: '/a', prefix: 'adf' },
    { path: '/b', prefix: 'think' },
    { path: '/c', prefix: 'spire-cl' },
    { path: '/d' },
    { path: '/e', prefix: 'Bad Prefix!' },
    { path: '/b2', prefix: 'think' },
  ])

  test('reads the prefixes out of bw registry list --json, sorted, each once, ignoring repos without one', () => {
    expect(parseRegistry(registry)).toEqual(['adf', 'spire-cl', 'think'])
    expect(parseRegistry('not json')).toEqual([])
    expect(parseRegistry('[]')).toEqual([])
    expect(parseRegistry('{}')).toEqual([])
    expect(parseRegistry('No registered repositories\n')).toEqual([])
  })

  test('finds each distinct mention once, in order, case folded', () => {
    const m = mentionMatcher(['adf', 'think', 'spire-cl'])
    const text = 'Closed adf-c50 (see ADF-C50 again) after think-1pp.4 landed; spire-cl-a3f8 blocks adf-zu6.'
    expect(findMentions(text, m)).toEqual(['adf-c50', 'think-1pp.4', 'spire-cl-a3f8', 'adf-zu6'])
  })

  test('ignores hyphenated words with unknown prefixes and ids glued to other text', () => {
    const m = mentionMatcher(['adf'])
    expect(findMentions('sha-256 and utf-8 and x-adf-c50 and adf-c50_x and adf-c50-x and adf-c', m)).toEqual([])
    expect(findMentions('issues/adf-c50.json', m)).toEqual(['adf-c50'])
    expect(findMentions('`adf-c50`, adf-wxh.5.', m)).toEqual(['adf-c50', 'adf-wxh.5'])
  })

  test('with no prefixes nothing matches', () => {
    expect(mentionMatcher([])).toBeUndefined()
    expect(findMentions('adf-c50', undefined)).toEqual([])
  })

  test('bare local parts count when they are tickets on the session board, never on another', () => {
    const m = mentionMatcher(['adf', 'think'])
    const known = { prefix: 'adf', ids: new Set(['adf-c50', 'adf-wxh.5', 'adf-1jf.234', 'adf-the', 'adf-zu6']) }
    const text = 'Start with c50, then wxh.5 and 1jf.234; the rest (abc, 999, 1pp) are not tickets here, and think-1pp is another board.'
    expect(findMentions(text, m, known)).toEqual(['adf-c50', 'adf-wxh.5', 'adf-1jf.234', 'think-1pp'])
    // a bare id and its full form are one button, in order of first mention
    expect(findMentions('zu6 then adf-zu6 then c50', m, known)).toEqual(['adf-zu6', 'adf-c50'])
    // without a board there are no bare mentions
    expect(findMentions('c50 and wxh.5', m)).toEqual([])
  })

  test('bare ids stop at word edges, paths, versions and common words', () => {
    const known = { prefix: 'adf', ids: new Set(['adf-c50', 'adf-draw', 'adf-the', 'adf-tsx', 'adf-2731', 'adf-1jf.2']) }
    expect(findMentions('hooks/draw.tsx and v2.1.2731 and c50.json and _c50 and c50x', undefined, known)).toEqual([])
    expect(findMentions('the board', undefined, known)).toEqual([])
    expect(findMentions('C50, (c50) and `1jf.2`.', undefined, known)).toEqual(['adf-c50', 'adf-1jf.2'])
  })

  test('parseListIds reads every id of the prefix off the bw list page', () => {
    const page = [
      '✓ adf-org P0 [BUG] worktree.mk guard lines [blocks: adf-od4]',
      '○ adf-wxh.5 P2 S5 follow-up',
      '○ think-1pp P2 another board',
      '○ ADF-Zu6 P1 case folded',
    ].join('\n')
    expect([...parseListIds(page, 'adf')].sort()).toEqual(['adf-od4', 'adf-org', 'adf-wxh.5', 'adf-zu6'])
    expect(parseListIds(page, 'spire-cl').size).toBe(0)
  })

  test('the longest prefix wins over a shorter one it starts with', () => {
    const m = mentionMatcher(['spire', 'spire-cl'])
    expect(findMentions('spire-cl-a3f8 and spire-b2', m)).toEqual(['spire-cl-a3f8', 'spire-b2'])
  })
})

describe('parseTicket', () => {
  test('maps bw show --json onto a Ticket', () => {
    const t = parseTicket(SHOWN)
    expect(t).toBeDefined()
    expect(t?.id).toBe('adf-c50')
    expect(t?.status).toBe('closed')
    expect(t?.closeReason).toBe('Shipped on main at 392b2a60')
    expect(t?.blocks).toEqual(['adf-lxh'])
    expect(t?.comments).toEqual([{ text: 'Committed a7507330 on branch live-activity', at: '2026-09-16T13:44:53Z' }])
    expect(t?.parent).toBeUndefined()
    expect(t?.due).toBeUndefined()
  })

  test('a child gets its parent from the id when bw omits it; a deferral and a due date come through', () => {
    const t = parseTicket({ ...SHOWN, id: 'adf-wxh.5', status: 'deferred', defer_until: '2026-05-31', due: '2026-10-01T00:00:00Z' })
    expect(t?.parent).toBe('adf-wxh')
    expect(t?.deferUntil).toBe('2026-05-31')
    expect(t?.due).toBe('2026-10-01T00:00:00Z')
    expect(parseTicket({ ...SHOWN, parent: 'adf-other' })?.parent).toBe('adf-other')
  })

  test('refuses anything without an id and title', () => {
    expect(parseTicket(null)).toBeUndefined()
    expect(parseTicket({ id: 'x' })).toBeUndefined()
    expect(parseTicket([])).toBeUndefined()
  })
})

describe('parseShow', () => {
  test('a ticket', () => {
    const l = parseShow('adf-c50', { exitCode: 0, stdout: JSON.stringify(SHOWN), stderr: '' }, T0)
    expect(l.kind).toBe('ticket')
    if (l.kind === 'ticket') expect(l.ticket.title).toBe('live-activity: function-hooks plugin')
  })

  test('an ambiguous id lists its candidates, sorted', () => {
    const stderr = 'error: ambiguous ID "think-1": matches think-1h7, think-1av, think-1pp.4, think-1pp.1, think-1pp\n'
    const l = parseShow('think-1', { exitCode: 1, stdout: '', stderr }, T0)
    expect(l.kind).toBe('ambiguous')
    if (l.kind === 'ambiguous') expect(l.candidates).toEqual(['think-1av', 'think-1h7', 'think-1pp', 'think-1pp.1', 'think-1pp.4'])
  })

  test('a missing ticket', () => {
    const l = parseShow('adf-zzz9', { exitCode: 1, stdout: '', stderr: 'error: no issue found matching "adf-zzz9"\n' }, T0)
    expect(l.kind).toBe('missing')
  })

  test('anything else is an error carrying bw\'s words', () => {
    const l = parseShow('adf-c50', { exitCode: 1, stdout: '', stderr: 'error: not a git repository\n' }, T0)
    expect(l.kind).toBe('error')
    if (l.kind === 'error') expect(l.message).toContain('not a git repository')
    const bad = parseShow('adf-c50', { exitCode: 0, stdout: 'not json', stderr: '' }, T0)
    expect(bad.kind).toBe('error')
  })
})

describe('status', () => {
  test('glyphs match bw prime; an open ticket with blockers is blocked', () => {
    const base = parseTicket(SHOWN)!
    expect(statusOf({ ...base, status: 'open', blockedBy: [] }).glyph).toBe('○')
    expect(statusOf({ ...base, status: 'open', blockedBy: ['adf-x'] })).toMatchObject({ glyph: '⊘', word: 'blocked' })
    expect(statusOf({ ...base, status: 'in_progress' })).toMatchObject({ glyph: '◐', word: 'in progress' })
    expect(statusOf({ ...base, status: 'closed' }).glyph).toBe('✓')
    expect(statusOf({ ...base, status: 'deferred' }).glyph).toBe('❄')
    expect(statusOf({ ...base, status: 'weird_state' })).toMatchObject({ glyph: '•', word: 'weird state' })
  })
})

describe('time', () => {
  test('parses RFC3339 and bare dates (local midnight)', () => {
    expect(parseDate('2026-09-16T13:16:44Z')).toBe(Date.parse('2026-09-16T13:16:44Z'))
    expect(parseDate('2026-05-31')).toBe(new Date(2026, 4, 31).getTime())
    expect(parseDate('')).toBeUndefined()
    expect(parseDate('yesterday-ish')).toBeUndefined()
    expect(parseDate(undefined)).toBeUndefined()
  })

  test('relative days', () => {
    expect(relativeDays(T0, T0)).toBe('today')
    expect(relativeDays(T0 + DAY, T0)).toBe('tomorrow')
    expect(relativeDays(T0 - DAY, T0)).toBe('yesterday')
    expect(relativeDays(T0 + 4 * DAY, T0)).toBe('in 4d')
    expect(relativeDays(T0 - 9 * DAY, T0)).toBe('9d ago')
  })

  test('ago', () => {
    expect(ago(T0 - 10_000, T0)).toBe('just now')
    expect(ago(T0 - 5 * 60_000, T0)).toBe('5m ago')
    expect(ago(T0 - 3 * 3_600_000, T0)).toBe('3h ago')
    expect(ago(T0 - 2 * DAY, T0)).toBe('2d ago')
  })
})

describe('layout with inline ids', () => {
  const m = mentionMatcher(['adf', 'think'])
  const known = { prefix: 'adf', ids: new Set(['adf-lxh', 'adf-zu6', 'adf-c50']) }

  test('piecesOf splits a line around full and bare ids, keeping the text as written', () => {
    expect(piecesOf('see `adf-lxh` and zu6.', m, known)).toEqual([
      { kind: 'text', text: 'see `' },
      { kind: 'id', id: 'adf-lxh', text: 'adf-lxh' },
      { kind: 'text', text: '` and ' },
      { kind: 'id', id: 'adf-zu6', text: 'zu6' },
      { kind: 'text', text: '.' },
    ])
    expect(piecesOf('ADF-C50 first', m, known)).toEqual([{ kind: 'id', id: 'adf-c50', text: 'ADF-C50' }, { kind: 'text', text: ' first' }])
    expect(piecesOf('nothing here', m, known)).toEqual([{ kind: 'text', text: 'nothing here' }])
  })

  test('wraps at words, an id is one token as wide as its button, blank lines stay', () => {
    const rows = layoutRows('the quick brown fox jumps', 10)
    expect(rows.map(rowText)).toEqual(['the quick', 'brown fox', 'jumps'])
    // "fix adf-lxh now": "fix " is 4 cells, the button 7 + 4 = 11, " now" 4 more
    const withId = layoutRows('fix adf-lxh now', 15, m, known)
    expect(withId.map(rowText)).toEqual(['fix adf-lxh', 'now'])
    expect(withId[0]?.[1]).toEqual({ kind: 'id', id: 'adf-lxh', text: 'adf-lxh' })
    expect(layoutRows('fix adf-lxh now', 14, m, known).map(rowText)).toEqual(['fix', 'adf-lxh', 'now'])
    expect(layoutRows('fix adf-lxh now', 19, m, known).map(rowText)).toEqual(['fix adf-lxh now'])
    expect(layoutRows('one\n\ntwo\n\n\n', 80).map(rowText)).toEqual(['one', '', 'two'])
    expect(layoutRows('', 80)).toEqual([])
  })

  test('a word wider than the row is split', () => {
    expect(layoutRows('a'.repeat(25), 10).map(rowText)).toEqual(['aaaaaaaaaa', 'aaaaaaaaaa', 'aaaaa'])
    expect(layoutRows('x ' + 'b'.repeat(12) + ' y', 10).map(rowText)).toEqual(['x bbbbbbbb', 'bbbb y'])
  })

  test('firstRows keeps whole rows and marks the cut with an ellipsis', () => {
    const rows = layoutRows('Ready-for: implement\n\n' + 'word '.repeat(60).trim(), 20)
    const cut = firstRows(rows, 4, 20)
    expect(cut.shown).toHaveLength(4)
    expect(rowText(cut.shown[3] as Row)).toMatch(/…$/)
    expect(cut.hidden).toBe(rows.length - 4)
    expect(firstRows(layoutRows('short', 20), 4, 20)).toEqual({ shown: [[{ kind: 'text', text: 'short' }]], hidden: 0 })
  })
})

describe('children', () => {
  const kid = (id: string, status = 'open') => ({ id, title: `title of ${id}`, status, priority: 1, blocked_by: [] })

  test('rows of bw list --parent become tickets in counting order, whole or slimmed', () => {
    const kids = parseChildren(JSON.stringify([kid('adf-utl.10'), kid('adf-utl.2', 'closed'), kid('adf-utl.1')]))
    expect(kids.map(k => k.id)).toEqual(['adf-utl.1', 'adf-utl.2', 'adf-utl.10'])
    expect(kids[1]?.status).toBe('closed')
    expect(kids[0]?.description).toBe('')
  })

  test('null (no children), an object, and noise are all no children', () => {
    expect(parseChildren('null')).toEqual([])
    expect(parseChildren('{"id":"adf-x"}')).toEqual([])
    expect(parseChildren('error: beadwork not initialized')).toEqual([])
    expect(parseChildren(JSON.stringify([{ nope: true }, kid('adf-a.1')])).map(k => k.id)).toEqual(['adf-a.1'])
  })

  test('the registry maps a prefix to its repo paths; an id takes its longest registered prefix', () => {
    const paths = parseRegistryPaths(JSON.stringify([{ path: '/a', prefix: 'adf' }, { path: '/b', prefix: 'think' }, { path: '/b2', prefix: 'think' }, { path: '/c', prefix: 'Bad Prefix' }]))
    expect(paths).toEqual({ adf: ['/a'], think: ['/b', '/b2'] })
    expect(parseRegistryPaths('not json')).toEqual({})
    expect(parseRegistryPaths('[]')).toEqual({})
    expect(prefixOf('spire-cl-0aa', ['spire', 'spire-cl'])).toBe('spire-cl')
    expect(prefixOf('adf-c50', ['think'])).toBeUndefined()
  })
})
