/* @jsx h */
import type { EngineInterface, Register } from 'claude-code'
import { drawMentions, drawPane, type Actions, type View } from './draw.tsx'
import { findMentions, isTicketId, type Known, mentionMatcher, normalizeId, parseListIds, parseRegistry, parseShow, type Lookup } from './ticket.ts'

// bw-peek: a Beadwork ticket pane inside the session.
//
// The agent names tickets by id (adf-c50, think-1pp) and the person reading has no idea what they
// refer to. This plugin answers that without leaving the terminal:
// - /bw <id> opens a pane on the ticket; /bw alone opens it with the search box focused.
// - Under every reply that mentions an id whose prefix bw's registry knows, or a bare local part
//   (`c50`, `wxh.5`) that is a ticket on this repo's own board, one dim row of [ id ] buttons; a
//   press opens the pane on that ticket. This is a render-side decoration: no prompt text, no
//   CLAUDE.md rule, no tokens. The board's ids come from `bw list --all --json | jq -r '.[].id'`
//   once, refreshed when stale or after a `bw create` / `bw delete` runs through the Bash tool.
// - The pane runs `bw show <id> --json` through $.process.run (cross-repo, via ~/.beadwork's
//   registry) and draws the digest, the title, the description and the comments.
//
// Nothing here writes to bw. Recent lookups live in $.store across sessions.

const PANE_ID = 'bw'
// v2: only ids bw answered with a ticket; v1 kept every search, misses and all
const RECENT_KEY = 'recent-v2'
const RECENT_CAP = 10
// a ticket shown again within this window is not re-fetched; Refresh always is
const FRESH_MS = 30_000
const SHOW_TIMEOUT_MS = 20_000
// the board's id list is re-read when a reply is drawn and it is older than this
const KNOWN_STALE_MS = 2 * 60_000
const LIST_TIMEOUT_MS = 20_000
// the board's ids: the JSON contract through jq (one id per line, a few KB), and when that pipeline
// cannot run (no jq, no sh) the text listing, whose lines carry the id near the front. The JSON
// itself is not read into the plugin: every description and comment rides along, 4 MB for 500
// tickets, and $.process.run cuts output at a limit
const LIST_ARGV: readonly string[] = ['sh', '-c', 'bw list --all --json | jq -r ".[].id"']
const LIST_TEXT_ARGV: readonly string[] = ['bw', 'list', '--all']

let ready: Promise<void> | undefined
let matcher: RegExp | undefined
let defaultPrefix: string | undefined
let recent: string[] = []
let current: string | undefined
const lookups: Record<string, Lookup> = {}
const pending = new Set<string>()
let paneOpen = false
let descriptionExpanded = false
let openComments = new Set<number>()
let search = ''
let commandRegistered: Promise<void> | undefined

let known: Known | undefined
let knownAt = 0
let knownRefresh: Promise<void> | undefined

let mentionButtons = true
let bareMentions = true
let mentionCap = 6
let collapsedRows = 8
let digestChars = 50

function log($: EngineInterface, text: string): void {
  $.ui.log(`bw-peek: ${text}`)
}

// once per module load (session start, and again after a hot reload): the registry's prefixes,
// this repo's prefix, the recent list
function ensureReady($: EngineInterface): Promise<void> {
  ready ??= (async () => {
    const prefixes: string[] = []
    try {
      const home = await $.env.get('HOME')
      if (home !== undefined && home !== '') {
        const r = await $.process.run(['cat', `${home}/.beadwork/registry.json`], { timeoutMs: 5000 })
        if (r.exitCode === 0) prefixes.push(...parseRegistry(r.stdout))
        else log($, `registry unreadable (exit ${r.exitCode}): ${r.stderr.trim()}`)
      }
    } catch (err) {
      log($, `registry read failed: ${err}`)
    }
    try {
      const r = await $.process.run(['bw', 'config', 'get', 'prefix'], { timeoutMs: 8000 })
      const p = r.stdout.trim().toLowerCase()
      if (r.exitCode === 0 && /^[a-z][a-z0-9_-]{0,23}$/.test(p)) {
        defaultPrefix = p
        if (!prefixes.includes(p)) prefixes.push(p)
      }
    } catch (err) {
      log($, `bw config get prefix failed: ${err}`)
    }
    matcher = mentionMatcher(prefixes)
    try {
      const saved = await $.store.get(RECENT_KEY)
      if (Array.isArray(saved)) recent = saved.filter((x): x is string => typeof x === 'string' && isTicketId(x)).slice(0, RECENT_CAP)
    } catch (err) {
      log($, `store read failed: ${err}`)
    }
  })()
  return ready
}

// the ids on this repo's board, for bare mentions; one run at a time, the old set drawn meanwhile
function refreshKnown($: EngineInterface): Promise<void> {
  if (defaultPrefix === undefined || !bareMentions) return Promise.resolve()
  const prefix = defaultPrefix
  knownRefresh ??= (async () => {
    try {
      let r = await $.process.run(LIST_ARGV, { timeoutMs: LIST_TIMEOUT_MS })
      if (r.exitCode !== 0 || r.stdout.trim() === '') {
        log($, `id pipeline failed (exit ${r.exitCode}): ${r.stderr.trim() || 'no output'}; reading the text listing`)
        r = await $.process.run(LIST_TEXT_ARGV, { timeoutMs: LIST_TIMEOUT_MS })
      }
      if (r.exitCode === 0) {
        const ids = parseListIds(r.stdout, prefix)
        const before = known
        const changed = before === undefined || ids.size !== before.ids.size || [...ids].some(id => !before.ids.has(id))
        known = { prefix, ids }
        if (changed) $.ui.invalidate('ui.render')
      } else log($, `bw list --all failed (exit ${r.exitCode}): ${r.stderr.trim()}`)
    } catch (err) {
      log($, `bw list --all failed: ${err}`)
    } finally {
      knownAt = await $.clock.now()
      knownRefresh = undefined
    }
  })()
  return knownRefresh
}

// never blocks a drawing on bw: a missing or stale list is fetched in the background and the reply
// redraws (the refresh invalidates) once it lands
async function knownIfFresh($: EngineInterface): Promise<Known | undefined> {
  if (defaultPrefix === undefined || !bareMentions) return undefined
  if (known === undefined || (await $.clock.now()) - knownAt > KNOWN_STALE_MS) fire($, 'bw list', refreshKnown($))
  return known
}

function ensureCommand($: EngineInterface): Promise<void> {
  commandRegistered ??= $.command
    .register({ name: 'bw', description: 'Open a Beadwork ticket in a pane (adf-c50, think-1pp, or a bare id for this repo)', argumentHint: '[ticket-id]', immediate: true })
    .then(() => undefined)
    .catch(err => {
      commandRegistered = undefined
      log($, `command.register failed: ${err}`)
    })
  return commandRegistered
}

// recent is a trail of tickets, never of searches: an id joins once bw answered with a ticket and
// leaves the moment a lookup says it is not one
function remember($: EngineInterface, id: string): void {
  recent = [id, ...recent.filter(r => r !== id)].slice(0, RECENT_CAP)
  $.store.set(RECENT_KEY, recent).catch(err => log($, `store write failed: ${err}`))
}

function forget($: EngineInterface, id: string): void {
  if (!recent.includes(id)) return
  recent = recent.filter(r => r !== id)
  $.store.set(RECENT_KEY, recent).catch(err => log($, `store write failed: ${err}`))
}

function noteLookup($: EngineInterface, id: string): void {
  const l = lookups[id]
  if (l === undefined) return
  if (l.kind === 'ticket') remember($, id)
  else forget($, id)
}

async function openPane($: EngineInterface): Promise<void> {
  paneOpen = true
  try {
    await $.ui.open({ id: PANE_ID, title: 'Beadwork', focus: true, closeOnEscape: true, rows: 24 })
  } catch (err) {
    paneOpen = false
    log($, `pane open failed: ${err}`)
    $.ui.toast(`could not open the pane: ${err}`, { timeoutMs: 4000 })
  }
  $.ui.invalidate('ui.render')
}

function closePane($: EngineInterface): void {
  paneOpen = false
  $.ui.close({ id: PANE_ID }).catch(err => log($, `pane close failed: ${err}`))
}

async function fetch($: EngineInterface, id: string): Promise<void> {
  if (pending.has(id)) return
  pending.add(id)
  $.ui.invalidate('ui.render')
  const at = await $.clock.now()
  try {
    const r = await $.process.run(['bw', 'show', id, '--json'], { timeoutMs: SHOW_TIMEOUT_MS })
    lookups[id] = parseShow(id, r, at)
  } catch (err) {
    lookups[id] = { kind: 'error', id, message: `bw show ${id} failed: ${err}`, at }
  } finally {
    pending.delete(id)
    $.ui.invalidate('ui.render')
  }
}

// the pane on a ticket: opened if closed, fetched unless fresh, remembered
async function show($: EngineInterface, id: string, force = false): Promise<void> {
  await ensureReady($)
  if (current !== id) {
    descriptionExpanded = false
    openComments = new Set()
  }
  current = id
  await openPane($)
  const have = lookups[id]
  if (force || have === undefined || (await $.clock.now()) - have.at >= FRESH_MS) await fetch($, id)
  noteLookup($, id)
}

async function submit($: EngineInterface, value: string): Promise<void> {
  await ensureReady($)
  const id = normalizeId(value, defaultPrefix)
  search = ''
  if (id === undefined) {
    $.ui.toast(value.trim() === '' ? 'type a ticket id first' : `“${value.trim()}” is not a ticket id`, { timeoutMs: 3000 })
    $.ui.invalidate('ui.render')
    return
  }
  await show($, id)
  // the redraw moves the ring off the field; put it back so the next id can be typed at once
  try {
    await $.ui.focus({ requestId: PANE_ID, key: 'search' })
  } catch (err) {
    log($, `focus failed: ${err}`)
  }
}

// a button's work runs past the press; a failure lands in the log, never as an unhandled rejection
function fire($: EngineInterface, what: string, p: Promise<unknown>): void {
  p.catch(err => {
    try {
      log($, `${what} failed: ${err}`)
    } catch {
      // the environment is gone (a reload or a session end); nothing left to tell
    }
  })
}

function actionsFor($: EngineInterface): Actions {
  return {
    open: id => fire($, `open ${id}`, show($, id)),
    submit: value => fire($, 'search', submit($, value)),
    input: value => {
      search = value
    },
    refresh: () => {
      if (current !== undefined) fire($, `refresh ${current}`, show($, current, true))
    },
    close: () => closePane($),
    toggleDescription: () => {
      descriptionExpanded = !descriptionExpanded
      $.ui.invalidate('ui.render')
    },
    toggleComment: i => {
      if (openComments.has(i)) openComments.delete(i)
      else openComments.add(i)
      $.ui.invalidate('ui.render')
    },
    forgetRecent: () => {
      recent = []
      $.store.delete(RECENT_KEY).catch(err => log($, `store delete failed: ${err}`))
      $.ui.invalidate('ui.render')
    },
  }
}

async function viewOf($: EngineInterface): Promise<View> {
  await ensureReady($)
  return {
    current,
    lookup: current === undefined ? undefined : lookups[current],
    pending: current !== undefined && pending.has(current),
    descriptionExpanded,
    openComments,
    recent,
    search,
    defaultPrefix,
    matcher,
    known: await knownIfFresh($),
    now: await $.clock.now(),
    collapsedRows,
    digestChars,
  }
}

function clampNumber(v: unknown, lo: number, hi: number, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : dflt
}

export const register: Register = (on, options) => {
  mentionButtons = options.mention_buttons !== false
  bareMentions = options.bare_mentions !== false
  mentionCap = clampNumber(options.mention_cap, 1, 20, 6)
  collapsedRows = clampNumber(options.collapsed_rows, 3, 40, 8)
  digestChars = clampNumber(options.digest_chars, 20, 200, 50)

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await ensureReady($)
    await ensureCommand($)
    fire($, 'bw list', refreshKnown($))
    return r
  })

  // a ticket made or removed through the Bash tool changes what a bare mention can mean
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    if (r.result !== undefined && /\bbw\s+(create|delete|import)\b/.test(e.command)) {
      await ensureReady($)
      fire($, 'bw list', refreshKnown($))
    }
    return r
  })

  on('command.run', { command: 'bw' }, async ($, e, next) => {
    await ensureReady($)
    const args = e.args.trim()
    if (args === 'close') {
      closePane($)
      return {}
    }
    if (args === '') {
      await openPane($)
      return {}
    }
    const id = normalizeId(args, defaultPrefix)
    if (id === undefined) {
      $.ui.toast(`“${args}” is not a ticket id`, { timeoutMs: 3000 })
      return {}
    }
    await show($, id)
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE_ID) paneOpen = false
    return next(e)
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    // the mobile table has no Input yet, so the search box cannot draw there
    if (e.surface === 'mobile') return next(e)
    paneOpen = true
    void ensureCommand($)
    const v = await viewOf($)
    const columns = Math.max(40, (e.props.bodyColumns ?? e.viewport?.columns ?? 100) - 1)
    return drawPane($.ui.resolve(e), v, columns, actionsFor($))
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!mentionButtons) return next(e)
    await ensureReady($)
    const ids = findMentions(e.props.text, matcher, await knownIfFresh($))
    if (ids.length === 0) return next(e)
    const drawn = await next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {drawn}
        {drawMentions($.ui.resolve(e), ids, mentionCap, actionsFor($))}
      </Box>
    )
  })
}
