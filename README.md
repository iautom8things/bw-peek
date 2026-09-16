# bw-peek

A Beadwork ticket viewer inside Claude Code. The agent names tickets by id
(`adf-c50`, `think-1pp`) and the person reading has no idea what they refer to
without opening another terminal and running `bw show`. This plugin puts the
ticket one keypress or one click away, in a pane beside the transcript.

Function hooks (Claude Code 2.1.270+) with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`
in the claude process's environment. Nothing here writes to bw.

## What it draws

**Under a reply.** Every assistant text block that mentions an id whose prefix
bw's registry knows (`~/.beadwork/registry.json`) gets one dim row beneath it:

```
⏺ The work is tracked in adf-c50 and think-1pp, and adf-zu6 blocks adf-lxh.
  ◈ [ adf-c50 ] [ think-1pp ] [ adf-zu6 ] [ adf-lxh ]
```

One button per distinct id, in order of first mention, capped (`+N more`). A
click opens the pane on that ticket. This is a render-side decoration: the
model's text is untouched, no rule asks it to format ids, and it costs no
tokens. Ids with unknown prefixes (`sha-256`, `utf-8`) draw nothing.

Bare ids count too, when they are tickets on the session repo's own board:
`c50`, `wxh.5`, `1jf.234` (three or four letters and digits, then any `.N`)
draw as `[ adf-c50 ]` and so on. The board's ids come from
`bw list --all --json | jq -r '.[].id'` (the JSON contract, one id per line,
about 4 KB for 500 tickets in 0.3 s), read at session start, re-read when a
reply is drawn and the list is older than two minutes, and right after a
`bw create`, `bw delete` or `bw import` runs through the Bash tool. Without jq
the plain `bw list --all` text listing is read instead. A bare id never reaches another board: it has no way to say which one it
means. A short stoplist of common three- and four-letter words (`the`, `and`,
`with`, `json`, ...) is skipped even if a ticket happens to spell one; that
ticket is still one `/bw adf-the` away.

**The pane.** Opened by a mention button, by `/bw <id>`, or by `/bw` alone with
the search box focused. Docked beside the transcript from 110 columns, inline
above the prompt below that. Escape closes it; `ctrl+x tab` focuses it.

```
◈ Beadwork  adf-c50                                        [ Refresh ]
ticket id, e.g. adf-c50 or c50 ⏎ open
──────────────────────────────────────────────────────────────────────
✓ closed  P1  feature  ⚑ slug:live-activity-function-hooks  created Sep 16 · closed Sep 16

live-activity: function-hooks plugin drawing live tasks, shells, monitors ...

blocks [ adf-lxh ]

↳ Shipped on main at 392b2a60 (v0.100.0) ...

Description  31 rows  [ Show all ]
  Ready-for: implement
  ...
  … 23 more rows

Comments (1)
  [ + ] Sep 16 9:44 AM Committed a7507330 on branch live-activity (workt…

recent [ think-1pp ] [ adf-zu6 ] [ forget ]
esc closes · type an id and press enter · /bw <id> from the prompt
```

- The digest row: status (`○ open`, `◐ in progress`, `⊘ blocked` for an open
  ticket with blockers, `✓ closed`, `❄ deferred`), priority colored by level,
  type, labels, assignee, `⏰ due <date> (in 4d)` in yellow or red once
  overdue, `❄ until <date>` with `(now due)` once the deferral has lapsed, and
  created / closed or updated.
- The title in bold, wrapped.
- Relations as buttons: `parent`, `blocked by`, `blocks`. A press opens that
  ticket; `recent` at the bottom is the trail back.
- The close reason, when the ticket has one.
- The description, collapsed to its first rows with `[ Show all ]` /
  `[ Collapse ]`. Rows are counted as drawn (word-wrapped at the pane's width),
  so a long paragraph is cut mid-way with an ellipsis rather than hidden whole.
- Comments, each as `[ + ]`, its time, and the first 50 characters. `[ + ]`
  opens the full text in a box; `[ − ]` folds it.

**Search.** The box takes a full id in any case, with wrapping punctuation or a
pasted `bw show adf-c50` around it; a bare local part (`c50`, `wxh.5`) takes
the prefix of the repo the session runs in (`bw config get prefix`). Every
prefix bw's registry knows resolves from any cwd, so `think-1pp` opens from the
`adf` repo. A partial id (`think-1`) draws bw's ambiguous list as buttons. A
missing ticket says so.

**Cost.** A redraw never waits on bw: the board list is read in the background
and the reply redraws when it lands. What the mention hook adds per redraw of an
assistant block, measured on 2.1.273 (`bun run tests/perf/mentions.bench.ts`
for the scan alone, `tests/perf/render.test.ts` for the hook through the engine
harness), against a 500-ticket board:

| reply | scan alone | whole hook per redraw |
| --- | --- | --- |
| 2 KB prose, no candidates | 0.23 ms | 0.43 ms |
| 5 KB, 100 bare candidates, 1 real | 0.35 ms | 0.73 ms |
| 5 KB, 100 candidates, 5 real | 0.35 ms | 0.71 ms |
| 5 KB, 100 candidates, 10 real | 0.33 ms | 0.56 ms |
| 50 KB, 1000 candidates, 100 real | 3.4 ms | 1.3 ms |

The share of real ids does not move the number; text length does (two regex
passes over the block, about 70 µs per KB). A set lookup per candidate is
nanoseconds. The one-time id list is about 0.3 s for 500 tickets and runs off
the render path.

**Freshness.** A ticket shown again within 30 seconds is not re-fetched;
`[ Refresh ]` always runs `bw show` again. The recent list (ten ids) lives in the
plugin store across sessions.

## Config

Set under `pluginConfigs["bw-peek@skills-dir"].options` in the user
`settings.json`, or from the config menu.

| field             | type    | default | meaning                                                      |
| ----------------- | ------- | ------- | ------------------------------------------------------------ |
| `mention_buttons` | boolean | `true`  | draw the `[ id ]` row under replies that mention tickets      |
| `bare_mentions`   | boolean | `true`  | also light up bare ids (`c50`) that are tickets on this board |
| `mention_cap`     | number  | `6`     | most ids drawn under one reply before `+N more` (1 to 20)     |
| `collapsed_rows`  | number  | `8`     | description rows shown before `[ Show all ]` (3 to 40)        |
| `digest_chars`    | number  | `50`    | characters of each comment before its `[ + ]` (20 to 200)     |

## How it works

| piece | mechanism |
| --- | --- |
| prefixes | `cat $HOME/.beadwork/registry.json` at session start (and after a hot reload), `repos.*.prefix`; the session repo's own prefix from `bw config get prefix` is added |
| mentions | `ui.render` on `AssistantMessage`: a regex over `e.props.text` built from those prefixes, longest first, word-bounded, plus bare `[a-z0-9]{3,4}(\.\d+)*` words looked up in the board's id set; the engine's own drawing is wrapped in a column with the button row beneath |
| the board | `sh -c 'bw list --all --json \| jq -r ".[].id"'`, ids of the session prefix read off the lines; the JSON itself never enters the plugin (4 MB with every description and comment inline for 500 tickets, and `$.process.run` cuts output at a limit). When the pipeline fails (no jq), the `bw list --all` text listing, whose lines carry the id near the front. Refreshed when stale or after a `tool.call` for Bash whose command runs `bw create`, `bw delete` or `bw import` |
| the pane | `$.ui.open({ id: 'bw', focus, closeOnEscape, rows: 24 })`, drawn by `ui.render` on `Pane`; `/bw` through `$.command.register` (`immediate`, so it works mid-turn) |
| a ticket | `$.process.run(['bw', 'show', id, '--json'])` from the session cwd, 20 s timeout; exit 1 with `ambiguous ID ... matches a, b` becomes the candidate list, `no issue found` the missing state |
| focus | after a submit the ring is put back on the search box with `$.ui.focus`, so the next id can be typed at once |

`hooks/ticket.ts` is the pure part (ids, mentions, JSON parsing, digest, time,
word wrap) under `bun test`; `hooks/draw.tsx` takes the resolved element table
and a `View` and never sees `$`; `hooks/register.tsx` holds the hooks and every
engine call.

## Develop

```sh
claude --plugin-dir llms/skills/bw-peek          # load from disk; edits hot-reload
claude plugin validate llms/skills/bw-peek       # what the module hooks and calls
cd llms/skills/bw-peek
bun test tests/unit                              # ids, mentions, parsing, digest, wrap
claude plugin test .                             # pane and mention row through the engine's $, bw mocked by argv; tests/perf bounds the redraw cost
bun run tests/perf/mentions.bench.ts             # µs per scan at 100 and 1000 candidates
bunx -p typescript tsc -p . && rm -f bun.lock package.json
```

Type checking needs the generated declarations: in a session with function
hooks on, run `/plugin-types .claude/types` from this folder (git-ignored).

Notes from the build, on 2.1.273:

- The mobile element table has no `Input`, so the pane hook passes there and
  the drawings type against `Elements['terminal'] | Elements['desktop']`.
- `Input`'s `submitLabel` (`⏎ open`) draws only while the field has the ring;
  it is the visible sign the pane has the keyboard. The first `ctrl+x tab` from
  the prompt lands there; a second moves on.
- A pressed button's work outlives the press. Every action goes through a
  `fire()` that catches its promise, else a session end mid-fetch surfaces as
  an unhandled rejection.
- In `claude plugin test`, `ui.focus` is an event answered with `{}`, not an
  op answered with `{ value }`; `$.store` is not on the test's `$`, so the
  recent list is seeded through `mock.store(on, entries)` instead.
