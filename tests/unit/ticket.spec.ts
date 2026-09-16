import { describe, expect, test } from 'bun:test'
import {
  ago,
  findMentions,
  idParts,
  isTicketId,
  mentionMatcher,
  normalizeId,
  parentOf,
  parseDate,
  parseRegistry,
  parseShow,
  parseTicket,
  relativeDays,
  firstRows,
  rowsAt,
  sortIds,
  statusOf,
  wrapRows,
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
  const registry = JSON.stringify({
    schema_version: 1,
    repos: {
      '/a': { prefix: 'adf' },
      '/b': { prefix: 'think', aliases: ['plans'] },
      '/c': { prefix: 'spire-cl' },
      '/d': {},
      '/e': { prefix: 'Bad Prefix!' },
    },
  })

  test('reads the prefixes out of registry.json, sorted, ignoring repos without one', () => {
    expect(parseRegistry(registry)).toEqual(['adf', 'spire-cl', 'think'])
    expect(parseRegistry('not json')).toEqual([])
    expect(parseRegistry('{}')).toEqual([])
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

describe('wrapping', () => {
  test('wraps at words, splits words longer than the width, keeps blank lines', () => {
    expect(wrapRows('the quick brown fox jumps', 10)).toEqual(['the quick', 'brown fox', 'jumps'])
    expect(wrapRows('a'.repeat(25), 10)).toEqual(['aaaaaaaaaa', 'aaaaaaaaaa', 'aaaaa'])
    expect(wrapRows('one\n\ntwo\n\n\n', 80)).toEqual(['one', '', 'two'])
    expect(wrapRows('', 80)).toEqual([])
  })

  test('rowsAt counts what wrapRows makes', () => {
    expect(rowsAt('short', 80)).toBe(1)
    expect(rowsAt('a'.repeat(100), 40)).toBe(3)
    expect(rowsAt('one\n\ntwo\n\n\n', 80)).toBe(3)
  })

  test('firstRows keeps whole rows and marks the cut with an ellipsis', () => {
    const text = 'Ready-for: implement\n\n' + 'word '.repeat(60).trim()
    const cut = firstRows(text, 4, 20)
    expect(cut.shown.split('\n')).toHaveLength(4)
    expect(cut.shown.endsWith('…')).toBe(true)
    expect(cut.hidden).toBe(rowsAt(text, 20) - 4)
    expect(firstRows('short', 4, 20)).toEqual({ shown: 'short', hidden: 0 })
  })
})
