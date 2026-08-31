# multicli — Project Record (PROJECT.md)

> A developer tool that runs multiple AI CLI agents (Claude Code, Gemini CLI, Qwen,
> Codex...) side by side in a single terminal environment, showing their quota/usage live.

**Status:** 🔄 Restarted (26 Aug 2026) — v1 was abandoned on 25 Aug 2026 ("didn't go at
all the way I imagined") and its folder deleted (no git remote, no copy survived).
This is **v2 / more detailed**, building on v1's architecture notes.
**Started:** 2026-08-26 · **Owner:** Murat

---

## 1. Vision / Purpose

A solution to the problem of the $20 Claude Code limit constraining projects: let Claude
handle the planning/architecture work, and hand off heavy execution to cheap/generous-quota
models (Qwen/MiniMax via OpenRouter, Gemini, Codex). As the practical infrastructure for
that, a tool that can manage **multiple AI CLI agents at once, with their quotas visible**.

Root cause: [[feedback_cost_delegation]] — the user stated this clearly on 1 Aug 2026.

---

## 2. v1 — Old Architecture (reference only, code gone/deleted)

The notes below are **historical reference only**; the code no longer exists and will be
rewritten from scratch.

**What it did:** A Node.js desktop tool that ran multiple AI CLI agents (claude, gemini,
qwen, codex — defined in `agents.json`, spawned via `cmd.exe /c <agent>`) side by side in
panels within a single Windows Terminal window, with a live 34-column usage/limit panel
on the right.

**Dependencies:** `node-pty` (real terminal spawning), `@xterm/headless` (a virtual
terminal buffer per agent).

**Architecture:**
- `index.js` — split the window based on agent count (sidebar + N panels), each panel had
  its own `node-pty` process + `xterm.Terminal(headless)` instance
- `limits.js` — extracted each agent's usage/limit summary by scanning local log files
  (`walk()`, max depth 4) without making any network requests
- Panel selection via F1-F8 (since Windows Terminal swallows Alt+number)
- `multicli-admin.cmd` — a launcher that started Windows Terminal with admin rights (had
  a desktop shortcut)

**Development order (git log, 6 commits):** basic multi-agent + limit panel → panel
selection (F1-F8) → jcode dropped, qwen+codex added, panel redesigned with colored cards
→ codex set up, gemini antigravity + qwen token sources added → real Anthropic quota API
integration (5-hour/weekly % remaining, reset time, extra credit) → launcher updated to
use Windows Terminal.

**Lessons learned from v1 (to watch for in v2):**
- A git remote was never set up → in v2 it must move to GitHub (private) early on, and
  also be confirmed to fall under the [[project_drive_backup]] nightly backup scope.
- "Didn't go at all the way I imagined" — the **exact reason for the dissatisfaction was
  never recorded**. When starting v2, the user should be asked: was it UX, performance,
  or the panel architecture that was the problem?

---

## 3. v2 — New Architecture (being detailed)

**Stack: Electron.** (K3 — see §4) v1 already used `node-pty` + `xterm.js`, which is
largely portable. Claude Desktop is also Electron — a good reference for the
theme/feel. Tauri was considered but would have required rewriting almost all of v1's JS
for pty integration + a custom title bar, so it was dropped.

*(The WezTerm install (see log) served a separate purpose — v2 has its own Electron
window and doesn't depend on WezTerm.)*

### 3.1 Window / Theme

A single window, **frameless custom title bar**, dark theme similar to Claude Desktop.

Top bar (left to right):
1. **Top left:** application menu (File, View, etc. — like a classic desktop app)
2. **A bit past the menu shortcuts, center:** live **quota/limit indicators**
   (styled like [[project_ai_limit_hq]] — color-coded bars/gauges; K5/the color spec
   could be inherited from there: ≥80 blue, 60-80 green, 40-60 yellow, 20-40 orange,
   <20 red)
3. **Far right:** window controls (minimize / maximize / close) — since the window is
   frameless, these are hand-drawn (not native in Electron, custom rendered)

**File menu → Projects:** the user can assign a **project folder**. The assigned folder
becomes where everything related to that project (config, session history, logs) is
stored — the natural counterpart to the "project folder" habit from projects like
TripMate/M669.

**Right edge — Limit Dock:** on the far right of the screen, a **small quota tracking
panel** in the style of [[project_ai_limit_hq]] (both at once — it lives alongside the
summary indicators in the top bar, this panel is the detailed view). Its visibility can
be **toggled from the View menu**. Its width can be adjusted by dragging (see §3.2
resizing).

### 3.2 Main Content — Agent Panels

- The screen is split into a **grid of panels** for agents: at least 3 columns, expanding
  up to 6-8 windows on larger screens.
- Each panel shows the **live output** of a CLI agent (claude, gemini, qwen, codex...) —
  via `node-pty` + `xterm.js` (headless/render), same as in v1.
- **Keyboard shortcut:** switch panels with **Ctrl+1..8** (by panel order).
- **Resizing:**
  - Dividers between agent panels can be **dragged** to resize (split-pane, like VS
    Code's terminal).
  - Double-clicking a panel (or a button/shortcut) makes it temporarily **fill the whole
    area** (maximize/restore) — to focus on a single agent.
  - The right-side limit dock's width can also be adjusted by dragging.

### 3.3 Session Memory (Session Resume)

The app should behave like Claude Code's `--continue`/`--resume`, **remembering recent
sessions**: when the window is reopened (or a project is selected), each panel's last
session should be automatically remembered/resumable.

✅ **Settled and implemented (K12 on 27 Aug, K16 on 29 Aug).** Per-agent resume flags live
in `agents.json` (`continueCommand`/`resumeCommand`); Claude (`-c`/`-r`) and Codex
(`resume --last`/`resume`) have them, gemini/qwen/opencode still have no known flag and
just start fresh.

On top of that, K16 restores the **workspace** itself: which panels were open, their
folders, canvas geometry and view mode are persisted, and on launch each panel is
respawned and relaunched with its continue flag, with its previous terminal output
replayed as dimmed history above the live session. That last part is what makes a
restored gemini/qwen panel still feel continuous despite having no resume flag of its own.

⚠️ This is **not** true process persistence — the PTYs die with the app (nodeterm gets
that from `tmux`, which has no Windows equivalent; see K16). The agent CLI reconstructs
its own conversation from its own session store, we only rebuild the window around it.

### 3.4 Feasibility Assessment (26 Aug 2026)

Overall a **highly feasible** design; the risk concentrates in two areas:

- **Easy/proven:** Electron+node-pty+xterm.js multi-panel (precedent: Hyper.js, and it
  already worked in v1), frameless custom title bar (precedent: VS Code/Discord), a
  single global input → `pty.write()` to the active panel (simpler than N separate
  inputs), green neon glow (pure CSS), Ctrl+1..8 shortcuts, split-pane resize,
  maximize/restore — all standard, low risk.
- **Medium risk — quota display:** v1's approach for Claude (local logs + real Anthropic
  API) is proven. CLI-side access to quota isn't standard for gemini/qwen/codex; some
  agents might only be able to show "tokens burned this session" instead of a real "%
  remaining" — equal-quality data can't be guaranteed for all of them.
- **Medium risk — session resume:** Claude Code's `--continue`/`--resume` is clear;
  other CLIs' resume mechanisms are different/unclear and each will need to be
  researched and added to the `agents.json` adapter (if one doesn't support it, that
  agent will just be marked "no resume").
- **Resource note:** keeping 6-8 agents alive at once means 6-8 separate (some heavy)
  Node processes in RAM simultaneously. [[project_nexus_core]] notes that the AIO
  already experiences RAM pressure — if this runs on this machine/NexusCore, starting
  with 3-4 panels and expanding is safer than targeting 6-8 from the start.

### 3.5 Quota Sources — Status (26 Aug 2026, researched + partially implemented)

| Agent | Local source | Status |
|-------|-------------|--------|
| **Claude** | `~/.claude/projects/**/*.jsonl` — every assistant message has `message.usage.{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens}` | ✅ **Working** — only input+output are summed (cache_read excluded, see why below) |
| **Gemini** | `~/.gemini/tmp/<project>/chats/session-*.jsonl` — every message has `tokens:{input,output,cached,total}` | ✅ **Working** — `tokens.total` is already a net value excluding cache, used directly |
| **Qwen** | `~/.qwen/tmp/**/logs.json` is always empty, `~/.qwen/projects/**/*.runtime.json` is just process metadata (pid/cwd, no tokens) | ❌ No local source found; `computeQwenUsage()` returns null, the UI shows "no local data" |
| **Codex** | `~/.codex/logs_2.sqlite` (Rust tracing/HTTP log, no tokens) BUT codex's internal "app-server" JSON-RPC daemon has a **real** `account/rateLimits/read` method (used by codex-tui, spotted in the logs via `node:sqlite`) | ❌ Still null for now — would need a JSON-RPC client wired up to `codex app-server`; not done this session |

**Important correction:** the first attempt summed input+output+cache_read for Claude,
which produced **111 million tokens** in a single session (meaningless) — because with
prompt caching, the same large context gets "re-read" on every turn
(`cache_read_input_tokens` alone can be 300K+ in a single message). Cache reads are
billed far cheaper and don't map onto rate-limit consumption with the same weight, so
now only the "fresh" input+output is summed (sane numbers, ~700K/5h). **We can't compute
a "% remaining"** because we don't know the plan cap (5-hour/weekly limit) from local
files alone — the dock shows the raw token count + message count, and the bar's fill
(`QUOTA_VISUAL_CAP=1M`) is an arbitrary visual reference, not a real percentage.

Implementation: in `main.js`, `computeClaudeUsage()`/`computeGeminiUsage()` scan the
files and sum over a rolling 5-hour window, returned via the `quotas:get` IPC call; in
the renderer, `refreshQuotas()` polls every 45 seconds and updates both the title-bar
mini indicators and the right-side dock cards. No network requests are made at all
(purely local file reading).

### 3.6 Remaining Open Decisions / Next Small Details

- ~~Session recall/picker~~ **DONE for Claude and Codex (27 Aug 2026)** — see K12.
  Gemini/Qwen still have no known continue/resume flag, so they only ever start a plain
  new session for now; worth revisiting if/when one is found.
- Real `account/rateLimits/read` JSON-RPC integration for Codex (§3.5) — would give
  real, persistent % data, but requires writing a JSON-RPC client.
- Still no readable local source for Qwen — whether a telemetry flag is needed hasn't
  been investigated.
- **Packaging order is settled**: the small details above, then electron-builder/NSIS
  (K9).
- **Added 29 Aug 2026 (K15-K18), pending an interactive check at the keyboard:** canvas
  drag/zoom feel, the board re-flowing live, a full workspace restore across a restart,
  and what a restored `claude -c` panel does when there's no prior session to continue.
- Possible follow-ups from the nodeterm review that were *not* taken: git staging/commit
  UI in-panel, GitHub Issues on the board. Remote access (mobile/browser) *was* taken —
  see §3.7 (K22, 30 Aug 2026).

### 3.7 Remote Access (K22, 30 Aug 2026)

**What it's for:** control the *same* running panels — same live pty sessions, same
folders, same conversations — from another PC or phone, over Tailscale (or plain LAN),
instead of only from the desktop window. Broad scope, per Murat: not just viewing/typing
into existing panels, but opening new ones and switching projects too — full parity with
the desktop app, because it's genuinely the same renderer.js talking to the same
main.js, just over a different transport.

**Starting it:** View → Start Remote Access… (host-only; also the item's label toggles to
"Stop Remote Access" once running). This generates a random per-install token (stored in
the config file, `crypto.randomBytes(18).toString('base64url')`) the first time, starts
the HTTP+WS server (`remote.js`, port 4173 by default), shows a `dialog.showMessageBox`
with the candidate URLs, copies the primary one to the clipboard, and opens it in the
system's default browser via `shell.openExternal` — landing in a **new window**, per
Murat's explicit ask ("uzak erişimi yeni pencerede başlatacak şekilde geliştirelim").

**Transport:** a plain HTTP server (static files) + WebSocket server (`ws` package —
the one new dependency this feature needed; no QR-code library was added, keeping with
the project's usual minimal-dependency preference, see K16). No TLS — this is meant to be
reached over a Tailscale tailnet or a trusted LAN, not the open internet, so the
complexity of certificates was deliberately skipped. `candidateUrls()` in `remote.js`
prefers a Tailscale-named network interface first (its `100.64.0.0/10` CGNAT address),
falling back to ordinary LAN IPs.

**Security:** every HTTP request and the WS upgrade require a `?token=` query param
matching the stored token (checked in `remote.js`); the static file server is an
explicit allowlist (`ALLOWED_FILES`), not a directory root, so there's no path-traversal
surface even though the server is genuinely network-reachable.

**Reuse strategy:** `src/renderer.js`, `src/styles.css`, and the xterm.js bundle are
served to the browser completely unmodified — only the `window.multicli` bridge differs.
`src/remote-bridge.js` implements the identical method surface as `preload.js` but
speaks JSON over the shared WebSocket instead of `contextBridge`/`ipcRenderer`; it also
sets `window.__MULTICLI_REMOTE__ = true`, which is the one flag renderer.js checks to
know it's not running inside Electron. `src/remote.html` is `index.html` with its
`../node_modules/@xterm/...` paths rewritten to the `/vendor/...` routes the server
allowlists, and `remote-bridge.js` included before `renderer.js`. Clipboard operations
are deliberately implemented client-side (`navigator.clipboard`), not round-tripped to
the host, since copy/paste should act on the *viewing* device's clipboard.

**The danger this design avoids:** naively letting a remote page run the exact same boot
sequence as the host (spawn a pty per saved workspace panel) would have been able to
silently kill live local sessions, because panel ids used to be a simple per-page-load
counter — a remote tab and the host each starting from 0 could mint the identical id for
their first panel, and `pty:spawn` unconditionally kills+replaces whatever already holds
an id. Fixed two ways: ids are now collision-resistant (`mintPanelId()`, incorporates
`Date.now()`/`Math.random()`), and a **live-panel registry** in main.js (`panelMeta`,
populated by fire-and-forget `panel:announce`/`panel:closed` calls from any renderer)
lets a newly-connecting viewer call `panels:listLive` and **attach** to what's already
running (`attachLivePanels()`, reusing `buildPanel()` without calling `pty.spawn`)
instead of spawning fresh copies. `restoreWorkspace()`'s disk-snapshot spawn path now
only runs on the host, and even then skips any `key` that attach already covered — which
incidentally also fixed a latent devtools-hot-reload bug where reloading the host window
used to spawn duplicate ptys on top of the still-running old ones.

**Multi-viewer sync:** `main.js`'s `broadcast(channel, payload, exceptSender)` fans
`pty:data`/`pty:exit`/`panel:new`/`panel:closed` out to the local window AND every
connected remote socket (via `remote.broadcast(...)`), skipping the originating sender so
an event never echoes back to whoever caused it. This is what makes the host and any
number of remote tabs converge on the same panel set and the same terminal output.

**Not done:** embedding the remote UI inside another page (TripMate HQ was considered and
explicitly dropped by Murat — a nested iframe would have needed HTTPS via Tailscale Serve
and compatible CSP/X-Frame-Options, for no real benefit over just opening a second browser
tab); a QR code for the URL (Murat didn't ask for one, and it would have been the only new
dependency purely for convenience); TLS/HTTPS (see above — out of scope while this stays
Tailscale/LAN-only).

---

## 4. Decision Log (why it's this way)

| # | Decision | Rationale |
|---|-------|-----------|
| K1 | v1's code is unrecoverable, will be rewritten from scratch | Folder deleted, no remote |
| K2 | v2 does architecture design first, then code | The user asked for "more detailed" — so as not to rush |
| K3 | Stack: **Electron** (not Tauri) | v1 already used node-pty+xterm.js (portable), Claude Desktop is also Electron (theme reference), Tauri would have needed a from-scratch rewrite for pty+custom title bar |
| K4 | ~~Single global command input~~ **SWEPT AWAY (26 Aug 2026)** — every panel is directly typable on its own | Tried it, the user found it unnecessary/pointless ("I can type directly into every window, the bottom input became useless") — click-and-type like a normal terminal multiplexer (tmux/VS Code) is more natural. `term.onData()` writes to the pty, xterm does its own key encoding (the hand-rolled `keyToSequence()` was removed) |
| K5 | Active-panel highlight: green neon glow border | Visual consistency with the refresh-button glow effect in [[project_ai_limit_hq]] |
| K6 | File menu → Projects: assign a project folder | Each project's config/session/logs should live in its own folder (consistent with the TripMate/M669 habit) |
| K7 | Quota display is **both at once**: top-bar summary + right-dock detail | The top bar stays simple but gives a summary at a glance; the right dock (styled like [[project_ai_limit_hq]]) gives the detail when wanted. Toggled from the View menu |
| K8 | Panel-switch shortcut: **Ctrl+1..8**; agent list same as v1 (claude/gemini/qwen/codex) | Could be freely assigned since it's our own Electron window; no need was seen to change the agent list |
| K9 | Packaging: **a small NSIS installer via electron-builder** (setup.exe), not a portable single exe | User preference: Program Files + Start Menu shortcut + a proper uninstaller — the same feel as how Claude Desktop is distributed. Config already uses `app.getPath('userData')` (%APPDATA%), independent of this decision |
| K10 | Panel-local keyboard shortcuts are captured per panel via `attachCustomKeyEventHandler` (Ctrl+1..8 panel switch, PageUp/PageDown/Ctrl+Home/Ctrl+End scrollback) | Once K4 was dropped, shortcuts that lived at the "general window" level needed to be captured in the focused panel's own handler instead; xterm's official API is more robust than hacky window-level guards |
| K11 | **UI language follows the system locale automatically** (tr/en, `navigator.language`) | The user said "whatever language Windows/Linux is using, show that"; the `STRINGS` dictionary + `applyStaticI18n()` cover every menu/label/system message — adding a new language is as simple as adding a third block to `STRINGS` |
| K12 | Agents menu offers **New / Continue Last / Choose Session…** for agents with a known resume flag (currently Claude: `-c`/`-r`, Codex: `resume --last`/`resume`); agents without one (Gemini, Qwen) just start new | Rather than guessing a common resume UX across all four CLIs, `agents.json` gained per-agent `continueCommand`/`resumeCommand` fields; the Agents-menu click only shows the extra picker (`showSessionModePicker`) when an agent actually has one |
| K13 | Agent list extended with a 5th entry: **Open Code** (`opencode`) | User request; no known resume flag or local quota source yet, so it behaves like Gemini/Qwen (plain start, dock shows "no local data") until one is found |
| K14 | Copy/Paste/Select-All are both keyboard shortcuts *and* buttons in a thin bar at the very bottom of the window | User pushed back twice: first wanted the shortcuts to exist at all (`Ctrl+C`/`Ctrl+V`/`Ctrl+Shift+A`, `Ctrl+C` only copies when there's a selection so `^C`-as-interrupt still works), then wanted them as clickable buttons too, not just a text hint — the actions were refactored into shared functions (`copyPanelSelection`/`pasteIntoPanel`/`selectAllInPanel`) so both paths call the same code. Buttons default to a turquoise glowing border (`--turquoise` CSS var, same hex as the Gemini panel glow) |
| K15 | **Grid is not replaced — `viewMode` adds `canvas` and `board` alongside it** (`grid` stays the default), and every render path re-parents the *existing* panel DOM nodes | Prompted by looking at [nodeterm](https://github.com/eneskirca/nodeterm) (29 Aug 2026). Rewriting the split-pane grid into a canvas engine would have been a much bigger change with no fallback if the canvas turned out to be awkward; three sibling render functions behind one `renderView()` dispatcher cost far less and leave the proven layout intact. Because a panel's DOM node is moved rather than recreated, live sessions/scrollback survive switching modes — the same property `rebuildGridLayout()` already relied on |
| K16 | **Session persistence is "workspace restore", not a detached PTY daemon**: panel list + folders + canvas geometry are saved, and on restart each panel is relaunched with its agent's *continue* flag (`claude -c`, `codex resume --last`) plus its previous terminal output replayed as dimmed history | nodeterm gets true persistence from `tmux`, which has no Windows equivalent; real detached PTYs would mean shipping a separate always-running daemon process. Reusing K12's per-agent resume flags gets the outcome the user actually asked for ("kalıcılık") at a fraction of the cost, and the dimmed scrollback replay makes a restored panel look continuous even for agents with no resume flag (gemini/qwen/opencode) |
| K17 | **Agent status (running / needs-you / idle / exited) is inferred from the pty stream**, not from Claude Code's hook system | Hooks would mean writing into the user's global `~/.claude/settings.json` (invasive, and outside this app's own config) and would only ever work for 1 of the 5 agents. A settle-timer plus a deliberately conservative "does the tail look like a question" regex set covers every CLI for free. Tuned to avoid false positives specifically (a bare `>`/`$` shell prompt and Claude's idle input box must NOT match) since a wrong "needs you" fires an OS notification — 15 regression cases are checked in `test/attention.test.js` (`npm test`) |
| K18 | Board columns are **agent status**, not user-assigned buckets — so there is nothing to drag | A hand-sorted kanban would be a second state to maintain by hand; status columns fill themselves and give the actual value wanted from the board — "which of my 6 agents is stuck waiting on me right now" |
| K19 | A panel **claims a specific session transcript** shortly after it starts (`session:claim`) — the newest file in its cwd's session dir **created after the panel spawned** and not already claimed by a sibling. That claimed id drives both the token badge in the panel head and which conversation a restore resumes. A panel that can't find such a file claims nothing, and `quotas:getSession` returns nothing rather than falling back to the folder's newest file | There is no handle tying a spawned CLI process to the file it writes, but both Claude and Gemini shard session files by cwd, which the panel knows — cwd narrows it to a folder, and creation time picks the right file within it. **Modification time can't**: the user often has a CLI running in an ordinary terminal outside multicli in the same folder, and being active it is *always* the most recently modified file, so an mtime rule hands the panel a stranger's conversation (found this way on 29 Aug 2026 — the panel billed itself for that session's tokens and then resumed into it). Claiming is retried (3s/8s/20s, then on every token refresh) because the transcript often doesn't exist until the first exchange. Only claude/gemini have a readable local source (same constraint as §3.5); other agents render nothing rather than a `0` that would read as a real measurement. `test/session-claim.test.js` pins the behaviour |
| K20 | Restore resumes **the panel's own session** (`claude -r <id>`). `-c` is used only when a panel is the *sole* restored panel for its (agent, folder) pair; otherwise the panel starts fresh | Found the hard way on the first restore after K16 shipped (29 Aug 2026, Murat): `claude -c` means "continue the folder's most recent conversation", so restoring three Claude panels rooted in the same folder silently collapsed all three into one. K19's session id fixes the normal case; the sibling count handles the leftover one, since firing `-c` from several panels at once can only ever be wrong. Starting fresh loses the thread, but landing in *someone else's* thread is worse, and the dimmed scrollback replay still shows what the panel was doing |
| K21 | The bottom shortcut bar (Copy/Paste/Select All, K14) becomes **toggleable, default on** rather than deleted | Murat found it redundant in practice — PowerShell's own right-click already does copy/paste (29 Aug 2026). Deleting it would throw away working code and the keyboard-hint text it carries; a View-menu toggle keeps it for anyone who wants the buttons and costs one line of state. This supersedes K14's "buttons are always visible", not the shared-function refactor underneath it |
| K22 | Remote access is **attach to the live desktop session**, not a second independent instance: a plain HTTP+WS server in the main process (View → Start Remote Access…) serves the same renderer.js/styles.css/xterm bundle to a browser, backed by a WebSocket bridge (`remote-bridge.js`) that mimics preload.js's exact `window.multicli` surface. No TLS (meant for a Tailscale tailnet or plain LAN, not the open internet); a random per-install token gates every request as defense-in-depth. A new main.js-side live-panel registry (`panelMeta`, populated by `panel:announce`/`panel:closed`) lets any newly-connecting viewer — a remote tab, or the host itself after a devtools reload — **attach** to already-running panels via `attachLivePanels()` instead of spawning duplicates; `restoreWorkspace()`'s disk-snapshot spawn path only runs on the host and skips anything already attached. Panel ids were also made collision-resistant (`mintPanelId()`) since two independent JS contexts (host window + remote tab) used to both start counting from 0 | Murat wanted to control the same running Claude/Gemini/etc. sessions from another PC or phone over Tailscale, "kapsam geniş olsun" (broad scope — not just viewing, full control including opening new panels/projects). Reusing renderer.js almost verbatim was far cheaper than building a second UI, but doing so naively (replaying the same boot sequence that spawns ptys) was found — before it ever shipped — to be actively dangerous: main.js's `pty:spawn` kills+replaces whatever already holds an id, so a remote page load could have silently killed live local sessions the moment ids collided. The attach/registry model exists specifically to close that hole. TripMate HQ integration (embedding via nested iframe) was considered and explicitly dropped by Murat in favor of just opening a second browser tab — see the 30 Aug 2026 log entry |
| K23 | A saved session id is **re-verified against the file on disk before it is resumed** (`session:verify`), not trusted because it was saved. A record must carry provenance (`sessionSince`, the panel start its claim was judged against), its transcript must still be in the panel's folder, and that transcript must have been *created* at or after the claiming run. A record that fails is dropped and the panel starts clean — and, critically, it may not fall back to `claude -c` either | K19 fixed which id a panel *takes*; it did nothing about ids already saved. `sessionClaim` deliberately never drops an id it holds (a transient unreadable directory must not cost a panel its session), so three ids claimed under the old mtime rule survived every launch and kept resuming into Murat's own PowerShell conversation for two days (31 Aug 2026). A forward-only rule can't heal bad state; this is the backward half. Provenance rather than a heuristic re-check, because "was this file created by the run that claimed it" is the actual question and only the claiming run knows its own start time. The `-c` exclusion matters as much as the id check: `-c` means "continue this folder's latest conversation", so falling through to it after rejecting an id would land the panel in the same stranger's session by a different route |

---

## 5. Log (Session Records)

### 2026-08-26
- Confirmed v1 was abandoned (see the [[project_multicli]] memory note); the user wanted
  v2 to be "similar to that but more detailed."
- Reopened the `C:\Users\murat\Projects\multicli` folder, created this PROJECT.md and
  CLAUDE.md.
- WezTerm was installed in the same session (for a purpose unrelated to multicli — noted
  in §3).
- v2's architecture was detailed: an **Electron** exe, frameless custom title bar (top-
  left menu, center quota indicators styled like [[project_ai_limit_hq]], right window
  controls), project-folder assignment via File→Projects, a 3-8 agent panel grid in the
  main area, a single global command input (bottom/horizontal/center) typing into the
  active panel, the active panel highlighted with a **green neon glow** border, session
  resume (similar to Claude Code's `--continue`) targeted. Detail: PROJECT.md §3.
- The panel-switch shortcut **Ctrl+1..8** and an agent list identical to v1
  (claude/gemini/qwen/codex) were settled (K8). Quota display would be both a top-bar
  summary and a right-dock detail (K7), the right dock toggled from the View menu.
  Split-pane resize between agent panels + double-click maximize/restore were added
  (§3.2).
- A feasibility assessment was done (§3.4): the overall design is low-risk, the real
  uncertainty is per-agent quota data and session-resume support; also, the 6-8 panel
  target might be ambitious on RAM (precedent: [[project_nexus_core]]), starting with
  3-4 was recommended.
- **Next step:** settle the open decisions in §3.5 (quota sources, resume commands),
  then move to the code/scaffolding phase.
- **First working MVP coded and verified.** Set up via `npm init` + Electron 44/node-pty
  1.1.0/@xterm/xterm 6 — since node-pty is N-API based, its Windows prebuild worked
  directly, `@electron/rebuild` (which failed due to missing Python) wasn't needed and
  can be removed. Features implemented/verified:
  - Frameless window, custom title bar (File/Agents/View menus + mini quota indicators +
    window controls) — verified with a screenshot.
  - **2D grid panel layout** (rows+columns, `layoutIds`) — the first version was a single
    row, the user said "I couldn't resize vertically," a row-to-row `resizer-row`
    (row-resize) was added; both horizontal and vertical drag-resize now work.
  - **On-demand panel start via the "Agents" menu** — no panel auto-starts at launch,
    the user starts whichever agent they want from the menu; the panel title becomes the
    agent name (+ "Project - Agent" if a project is open). A `command` field was added to
    `agents.json` (claude/gemini/qwen/codex) — the panel auto-types that command 200ms
    after opening.
  - **Adding a panel is no longer destructive**: `rebuildGridLayout()` reuses the
    existing xterm/pty objects (moves them in the DOM), only creating a new xterm for the
    newly added panel — the earlier "every addition rebuilds the whole grid from
    scratch" design (which caused loss of session/scrollback) was dropped.
  - **Panel closing** (✕ button) added — kills the pty + disposes xterm + re-lays out the
    grid.
  - **The project system was redesigned** (user: "each inner window should be able to
    have its own project assignment" + "the File menu needs open/close project, add
    location"):
    - The File menu now has a multi-entry **saved projects list**
      (`projects: [{name,path}]`, persisted in `%APPDATA%\multicli-config.json`), added
      via "Add Project…", clicking one "opens" it (✓ marked), "✕" removes it from the
      list, "Close Project" clears the open one.
    - A new panel takes the **currently open project** as its cwd automatically (no
      dialog).
    - Each panel's header has a **📁 button** that can reassign that ONE panel to a
      different project (from the saved list or a new folder via "Browse") — the panel's
      pty is killed+respawned, and a yellow "project changed" note is written into xterm.
  - Packaging decision settled: **electron-builder + a small NSIS installer** (K9) — not
    a portable single exe, a Program Files + Start Menu shortcut + uninstaller; config
    already uses `app.getPath('userData')` so it's unaffected by this decision. Not set
    up yet, will happen once the MVP UI stabilizes.
  - **Git repo moved to GitHub**: `git init` → first commit → pushed with `gh repo create
    multicli --private`: **https://github.com/mrtengn-arch/multicli** (private). K1's
    lesson ("staying without a remote") is now closed. `.gitignore` excludes
    `node_modules`/log files; PROJECT.md/CLAUDE.md went into the commit without issue
    since the repo is private (unlike ai-limit-hq's public-repo restriction).
  - Verified with a screenshot: menus, green glow, quota dock, panel-header buttons all
    work visually. `[process exited: 1]` was the user's own test (typed `exit` in a
    panel) — not a bug, resolved.
  - **Default Location** added (File menu): the cwd fallback for panels with no assigned
    project is no longer `USERPROFILE` but a folder the user picks; asked once on first
    launch, changeable later.
  - **Panels were made read-only** (xterm `disableStdin: true`) — the user noticed they
    could click directly into a panel and type, which broke K4 (single global input).
    Since this also disabled xterm's built-in PageUp/PageDown scrollback shortcuts, those
    were rewired by hand to the bottom command bar (PageUp/PageDown/Ctrl+Home/Ctrl+End,
    pure client-side `term.scrollPages()` — never touches the pty).
  - **Panel color is per-agent** (View menu) — the user specifically wanted "Claude
    orange, Qwen purple" etc. separately; the first version was mistakenly a single
    global color, fixed. The color is now written as `--glow`/`--glow-dim` custom
    properties inline on each panel's OWN DOM element (not the global `:root`), defaults:
    claude=orange, gemini=turquoise, qwen=purple, codex=green; persisted in `%APPDATA%`
    as agentId→color.
  - ANSI color/background support (git diff green/red etc.) was asked about — no extra
    work needed, xterm.js + a real PTY (`name:'xterm-color'`) already fully supports it.
  - **K4 was reversed**: once the user tested it, the single-global-input idea felt
    pointless, and direct in-panel typing was restored (see K4, K10). The bottom command
    bar was removed entirely from HTML/CSS/JS.
  - **A color button was added to the panel header** (next to 📁/✕) — you can change that
    panel's agent color directly from the panel without going to the View menu; both
    share the same state (`agentColors`), so changing one updates the other in sync.
  - **i18n added** (K11): every menu/label/system message now comes from the
    `STRINGS.tr`/`STRINGS.en` dictionary, chosen automatically based on
    `navigator.language`.
  - **The quota panel works with real data** (§3.5): local file scanning for Claude +
    Gemini was completed and tested (verified against real files — the first attempt
    produced a meaningless 111M-token number, fixed by excluding cache_read). For
    Qwen/Codex, there's no/missing local source, and the UI honestly shows "no local
    data" — nothing was fabricated. Codex's internal `account/rateLimits/read` RPC was
    discovered and can be used for a real % in the future (§3.5 table).
  - Session wrap-up: the latest state of the repo was pushed to GitHub. The next real
    task is **session recall/picker** (§3.6) — once that's done, move on to
    electron-builder packaging (K9).
  - Added a GitHub repo description and a README with a real screenshot (4 panels
    running live: Claude x2, Gemini, Qwen, quota dock showing real numbers).
  - **Everything in the repo switched to English** (user's explicit call, mid-session) —
    PROJECT.md, CLAUDE.md, README, and all code comments across main.js/preload.js/
    src/*. This is a deliberate exception to the Turkish-docs pattern used in Murat's
    other projects (see CLAUDE.md's language rule for the reasoning).
  - **Repo made public + MIT licensed**, renamed to "MultiCli for AI Agent Management"
    (README/package.json/window title; the GitHub URL slug stays `multicli`). Added
    topics for discoverability. Ran a secret/token grep before flipping visibility —
    clean.
  - Added a Desktop shortcut (`electron.exe "<project dir>"`) so the app can be
    launched without a terminal, ahead of real installer packaging (K9).
  - **Fixed a real bug: closing the window with a panel open threw "Object has been
    destroyed"** (one Electron error dialog per open panel, had to click through all of
    them). Root cause: `mainWindow` was never reset to `null` on close, so a pty's
    `onData`/`onExit` firing after teardown called `mainWindow.webContents.send(...)`
    on an already-destroyed object — the existing `mainWindow?.` guards were no-ops
    against a stale non-null reference. Fixed with `mainWindow.on('closed', () => {
    mainWindow = null; })`, wrapped the two `.send()` calls in try/catch as
    defense-in-depth, and added a top-level `process.on('uncaughtException', ...)`
    safety net so a future bug like this logs instead of crashing the app with a
    dialog. Reproduced and verified fixed (close-with-panel-open, no more dialog).

### 2026-08-27
- **Session recall/picker for Claude and Codex** (K12): `agents.json` gained
  `continueCommand`/`resumeCommand` fields; clicking those two agents in the Agents menu
  now opens a small "New / Continue Last / Choose Session…" popup instead of always
  starting fresh. Gemini/Qwen have no known resume flag yet, so they're unaffected.
- **Panel titles always show a project name** — even with no project assigned, a panel
  now reads "No Project - Claude" instead of just "Claude", so it's never ambiguous which
  folder a window is running in.
- **Added a 5th agent: Open Code** (`opencode`, K13) — same "honest no data" treatment as
  Qwen/Codex in the quota dock, default panel glow color pink.
- **Copy/Paste/Select-All** (K14): `Ctrl+C`/`Ctrl+Shift+C` copy, `Ctrl+V`/`Ctrl+Shift+V`
  paste, `Ctrl+Shift+A` selects all — plus the same three actions as actual buttons (with
  icons: 📋/📥/🔲) in a new thin bar at the very bottom of the window, styled with a
  turquoise glowing border by default. Clipboard access goes through Electron's
  synchronous `clipboard` module, exposed via preload (no IPC round-trip needed since
  it's called from inside xterm's synchronous keydown handler).
- **Process-management lesson**: launched the app in the background via a bash subshell
  (`(electron.cmd . &)`) purely to screenshot-verify a change; when that backgrounded
  bash task's job finished, it took the Electron process down with it (job-control
  child, not properly detached) — closed a panel the user had open, with no warning.
  Lesson: don't use a bash-backgrounded launch for throwaway verification of this app
  again; if a screenshot check is needed, use a properly detached launch or just ask the
  user to check visually themselves.
- **Two Agents-menu/layout bugs fixed**, both reported by the user after live use:
  - Clicking "Start Claude" (or any agent with a resume flag) closed the whole Agents
    dropdown the instant the New/Continue/Resume picker opened next to it — the click
    bubbled to the window-level "close all open menus" listener before the picker's own
    logic ran. Felt like losing your place mid-navigation. Fixed with `e.stopPropagation()`
    on that one click path; picking an option still bubbles and closes everything, which
    is the behavior we want.
  - Row resizers (the horizontal drag bars between stacked panel rows) inherited a
    hardcoded `width: 5px` meant for column resizers, leaving only a ~5px-wide sliver to
    grab instead of a full-width bar — in effect, vertical resizing didn't work. Split
    `.resizer` into `.resizer-col` (width/col-resize) and `.resizer-row` (height/row-resize,
    width left to stretch). **Confirmed fixed live** by the user.
- **Known issue, not yet fixed**: column resizers (the vertical bars between side-by-side
  panels, dragged horizontally to change width) still don't work for the user even after
  the row-resizer fix above — reported same session, right after confirming the row fix.
  `.resizer-col`'s CSS looks equivalent to what it was before (width/flex-basis/cursor
  were already correct pre-fix, unlike the row case), so the root cause is probably in
  `addResizer()`'s JS drag logic itself, not CSS — needs an interactive drag test next
  session, not just static code reading.

### 2026-08-28
- **Panel title now tracks the running conversation, not just "Projesiz"** (user request):
  a "no project" panel gave zero clue which conversation was in it once an agent had
  actually started. `feedTitleCandidate()` watches the user's own `term.onData` keystrokes
  (never the auto-injected launch command — `captureTitle` only flips on after that's
  already sent) and uses the first line they submit as a one-shot stand-in title, same
  convention chat UIs use. Only applies to `!projectDir` panels; bails out safely (keeps
  the old placeholder) on any escape sequence to avoid garbage from arrow keys etc.
- **Fixed layout getting "confused" after closing a panel** (user-reported): manual
  resizer drags set a fixed-px `flex` directly on `.agent-panel` elements; since
  `rebuildGridLayout()` reuses those same DOM nodes rather than recreating them, the old
  pixel value survived into whatever new row/column arrangement resulted after a close —
  opening always looked fine because `buildPanel()` starts new panels at `1 1 0`, closing
  didn't reset the survivors. Now `rebuildGridLayout()` resets every panel to `1 1 0` on
  every structural change (open or close); live dragging within a stable layout is
  unaffected.
- **Not yet restarted/tested live this session** — user had another session running in
  an open panel and asked not to restart the app. Both fixes above are syntax-checked
  (`node --check`) and reasoned through carefully, but need a real restart + interactive
  check next session before calling them verified. Also revisit the still-stale top-of-file
  comment in `main.js` ("Session resume is future work") — that shipped 27 Aug (K12).

### 2026-08-29
- **Triggered by a competitor review.** The user asked whether
  [nodeterm](https://github.com/eneskirca/nodeterm) (a node-based terminal manager for AI
  agents) was worth installing. Verdict: **no** — it's macOS/Linux only (no Windows build;
  session persistence is `tmux`-backed), BUSL-1.1 licensed, and would need our whole
  agent/quota wiring redone. Three of its ideas were worth taking, and the user asked for
  all three in one pass, cheapest first.
- **Live agent status (K17)** — every panel head now carries a status dot:
  `running` (blue, pulsing) / `needs you` (amber, glowing, plus a `.needs-you` glow on the
  whole panel) / `idle` / `exited` (red). Driven from the pty stream in `notePanelOutput()`:
  output flips the panel to *running* and arms a 900 ms settle timer; when the stream goes
  quiet, `looksLikeAttention()` checks the last 8 buffer rows against `ATTENTION_PATTERNS`
  to decide *needs you* vs *idle*. Typing clears *needs you* immediately. When multicli is
  **not focused**, entering *needs you* fires an OS notification + taskbar flash
  (`notify:attention`, suppressed while focused — the badge is enough if you're looking).
  The patterns are deliberately conservative; a bare `>`/`$` shell prompt and Claude's idle
  input box must not match, since a false positive means a spurious toast. 15 regression
  cases live in `test/attention.test.js` (`npm test`; evals the real regexes out of `renderer.js`) —
  all passing.
- **Workspace + scrollback persistence (K16)** — the "kalıcılık" ask. `workspace:*` and
  `scrollback:*` IPC added. The renderer saves a debounced snapshot (panel list, per-panel
  folder + stable `key` + canvas geometry, view mode, canvas pan/zoom) on every structural
  change, and `main.js` holds the window close open (max 1.5 s) for one final flush that
  also dumps each terminal's last 400 lines to `%APPDATA%/…/scrollback/<key>.log`. On the
  next launch each panel is respawned in its old folder, its history replayed **dimmed**
  above the live output, and the agent relaunched with its continue flag from K12
  (`claude -c`, `codex resume --last`). Toggleable via View → "Restore Session on Start".
  Explicitly closing a panel deletes its saved history. **Not** true PTY persistence: a
  hard kill (rather than a window close) loses the final scrollback flush, though the
  debounced panel list survives.
- **Canvas + Board views (K15/K18)** — View → Layout, or Ctrl+Shift+1/2/3.
  *Canvas*: infinite pan/zoom surface, panels are free-positioned nodes (drag by header,
  resize by the corner grip, wheel-zoom about the cursor, left-drag empty space or
  middle-drag anywhere to pan, dot grid tracks the transform). Below 0.85 zoom the terminal
  bodies go `pointer-events: none` — xterm's mouse math doesn't survive a CSS scale, so
  panels become read-only map tiles at that point rather than pretending to be typable.
  *Board*: kanban-ish triage columns by status (Needs You / Running / Idle / Exited) with
  the terminals still live inside the cards; it re-flows itself (debounced 250 ms) as
  statuses change.
- **Grid untouched (K15).** `renderView()` dispatches to `renderGrid` / `renderCanvas` /
  `renderBoard` / `renderMaximized`, all re-parenting the *same* panel DOM nodes, so
  sessions survive a mode switch. `rebuildGridLayout()` was renamed `renderGrid()` and its
  now-dead empty-state branch moved up into `renderView()`. Maximize stopped being a CSS
  overlay (`position:absolute` can't escape the canvas's transformed world) and became a
  render mode of its own.
- **Verified:** `node --check` on all three JS files; a real Electron boot with
  `ELECTRON_ENABLE_LOGGING=1` produces no renderer console errors (confirmed the harness
  actually reports errors by first injecting a canary); 15/15 attention-detection cases.
  The "Renderer process crashed" line in those runs is an artifact of `timeout` SIGTERM-ing
  the app — the pre-change `HEAD` build prints it identically.
- **NOT yet verified interactively** (needs a real session at the keyboard): restoring a
  workspace across a restart, dragging/zooming on the canvas, the board re-flowing live,
  and whether `claude -c` in a restored panel behaves acceptably when that panel has no
  prior session to continue (it will print the CLI's own error and drop to a shell).

#### Fourth pass — pushed the third-pass fixes, verified with no working screenshot, GitHub topics

- **Screenshot verification came back solid black.** The Windows session was locked and the
  display had gone to sleep (power-save) at the time — `GetWindowRect`/`IsWindowVisible`
  confirmed the window existed, was not minimized, and was sized correctly, but
  `CopyFromScreen` returns black for a locked/asleep console regardless. Not an app bug.
  **Fallback: launch with `--remote-debugging-port` and talk CDP directly** (`Runtime.evaluate`
  over the websocket) to read the live DOM instead of a pixel buffer — confirmed 3 panels
  restored with correct titles/token counts, the quota dock, the menu, and zero console
  errors. Worth reaching for this first, not just as a fallback, whenever the machine might
  be locked/unattended.
- **Committed and pushed the third-pass fixes** (session-claim birthtime/1s-slack fix, the
  `-c`-fallback restriction, the canvas-panel focus `preventDefault()`, the token pill
  contrast, and `test/session-claim.test.js`) that had been sitting uncommitted since they
  were written — `7f5f56b`. `node --check` ×2 + `npm test` (15/15 + 10/10) run again
  immediately before commit.
- **GitHub topics for discoverability.** Compared against
  [nodeterm](https://github.com/eneskirca/nodeterm) (1350 stars) at the user's request — it
  tags itself with `linux`/`macos`/`tmux`/`adhd` among others, none of which fit us (we're
  Windows-only, real `node-pty` terminals rather than a tmux backend). Added 13 topics that
  do fit: `claude-code`, `gemini`, `codex`, `qwen`, `multi-agent`, `agent-orchestration`,
  `canvas`, `workspace-manager`, `node-pty`, `xterm`, `windows`, `quota-tracking`,
  `desktop-app` — on top of the 5 already set (`ai-agents`, `cli`, `developer-tools`,
  `electron`, `terminal`).
- **Open:** GitHub reports the repo moved to `mrtengn-arch/MultiCli` (case-only rename,
  cause not identified — `git push` still succeeds via the redirect). Remote URL not yet
  updated to match; low priority since pushes work either way.

#### Same day, second pass — five things the user hit while actually using it
- **Board cards hopped between columns.** Claude Code's TUI repaints itself while idle, so
  the status kept flapping running → idle → running and the card followed. Added per-panel
  hysteresis (`scheduleBoardMove`, `BOARD_STICKY_MS = 4000`): a card only changes column
  once its new status has held for 4 s. `attention` still moves instantly — that's the one
  transition you don't want damped. `renderBoard()` now groups by the debounced
  `p.boardStatus`, not the live `p.status`.
- **Canvas panels couldn't be resized.** One 14 px corner grip, and because the whole world
  is CSS-scaled it shrank to 7 physical px at 50 % zoom. Now three grips (right edge, bottom
  edge, 22 px corner) driven by an axis-aware `startCanvasResize(e, id, axis)`, sized off a
  `--inv-z` custom property set in `applyCanvasTransform()` so they stay a constant on-screen
  size at any zoom. Edge grips overhang slightly and light up on hover.
- **`claude -r` panels still read "Projesiz".** `feedTitleCandidate()` only watches typed
  lines and bails on escape sequences, but `-r`'s session picker is an arrow-key TUI. Hooked
  xterm's `onTitleChange` (OSC 0/2) → `applyTerminalTitle()` instead, which is authoritative;
  it ignores bare paths so a shell that sets its title to the cwd doesn't win.
- **Per-session token count in the panel head (K19)**, just left of the color dot, with the
  exact figure on hover. Needed a way to tie a panel to one transcript file: `session:claim`
  returns the newest `.jsonl` in the panel's cwd session dir that was touched since the panel
  spawned and isn't already held by a sibling. Verified against real transcripts — three
  simulated panels on `C:\Users\murat` claimed three distinct sessions with distinct totals.
  `pty:spawn` now returns the cwd it actually used (may differ from the requested one), since
  that resolved path is what the lookup keys off.
- **Restored Claude panels all landed in the same conversation (K20).** Reported by the user
  after the first real restore: `claude -c` resumes *the folder's* latest session, so three
  panels rooted in one folder collapsed into one. Restore now builds `claude -r <claimed id>`
  per panel and only falls back to `-c` when no id was captured. The session id is persisted
  in the workspace record. Note the workspace saved *before* this change has no ids in it, so
  the first restore after upgrading still uses `-c` — the panels have to be opened by hand
  once, after which each claims its own id. `session:claim` also takes the id the panel
  already holds: if that file has been written to since the panel spawned it stays put, and
  if it hasn't (i.e. `-r` forked a new transcript) the panel adopts the new one. Re-claiming
  is confined to the 3 s/8 s/20 s window after spawn, so an idle panel can never adopt an
  unrelated session someone started in the same folder later.
- **Shortcut bar is now optional (K21)** — the user pointed out PowerShell's right-click
  already covers copy/paste. Kept behind View → "Shortcut Bar" (default on) rather than
  deleted; toggling it refits every terminal, since the panels gain/lose ~34 px.
- **Verified:** `node --check` ×3, 15/15 attention cases, a clean `ELECTRON_ENABLE_LOGGING=1`
  boot, and throwaway harnesses that ran the real `session:claim` / `quotas:getSession` bodies
  against live transcripts: three simulated same-folder panels claimed three distinct sessions
  with distinct totals; `null` for a bogus id, an unsupported agent and a not-yet-written
  session; and 5/5 on the held-id branch (keep a live file, adopt after a fork, keep a known
  id when nothing newer exists, skip a sibling's file).
- **Keyboard died in zoomed-out canvas panels.** Self-inflicted: the panel's mousedown
  handler refused to call `term.focus()` below `CANVAS_INTERACTIVE_Z`, on the reasoning that
  a "map tile" shouldn't swallow keystrokes. Wrong reasoning — CSS scale breaks xterm's
  *mouse* math, not its keyboard, and the output is perfectly visible while scaled. Focus is
  now unconditional; `.zoomed-out` still takes pointer events off the body (so a selection
  drag can't land on the wrong cells), and the click falls through to the panel element,
  which focuses the terminal. Zoomed-out panels are typable again.
- **Token pill restyled** — dim grey text was too easy to miss, so it's now a lit pill
  colored off the panel's own `--glow`/`--glow-dim` vars. That means it inherits the agent's
  color for free (orange on Claude, turquoise on Gemini) and stays consistent with the
  existing per-agent color language rather than introducing a new accent.
- **Still NOT verified interactively:** the actual restore-with-`-r` round trip, and whether
  a panel reliably claims its session within the 3 s / 8 s / 20 s retry window.

#### Third pass — the same two bugs, this time diagnosed properly

Both of the fixes above turned out to be treating symptoms. Murat came back with the same two
complaints and, in the second case, the exact diagnosis.

- **Session claiming was picking up a stranger's conversation.** Murat: panel 1 restored into
  the Claude session he had open in an ordinary PowerShell window *outside* multicli, not the
  one it had been running. `session:claim` was ranking candidates by **modification** time,
  and a session that is actively being typed into is by definition the most recently modified
  file in the folder — so a panel with no transcript of its own reliably stole the live one.
  Creation time is the property that actually answers "did this panel start that session", and
  it's distinct and reliable on NTFS (checked against real transcripts: the file the panel
  stole was born on 26 Aug and modified seconds ago). So: sort and cut off by `birthtimeMs`,
  `SLACK_MS` 5000 → 1000 (5 s of clock slack is a wide enough window to swallow a session the
  user started just before the panel), and the folder-newest fallback in `quotas:getSession`
  deleted — an unclaimed panel now shows no number instead of a neighbour's.
  `test/session-claim.test.js` (10 cases) locks this in; its fixtures are built on disk with
  real sleeps because birthtime can't be faked through `fs.utimes`. Confirmed it fails when
  reverted to mtime before keeping it.
- **The `-c` fallback made that worse, so it's now restricted.** Since a workspace saved before
  K19 has no ids, *every* restored Claude panel fell back to `claude -c` and they all landed in
  the same conversation — the folder's newest, which is exactly the foreign session above.
  `restoreCommandFor(agent, sessionId, siblings)` only allows `-c` when the panel is the sole
  restored panel for its (agent, folder) pair; two or more and they start fresh. Documented in
  K20 — losing the thread beats landing in someone else's.
- **Keyboard in zoomed-out panels (second attempt).** Removing the `CANVAS_INTERACTIVE_Z` guard
  on `term.focus()` wasn't enough because the guard wasn't the whole cause: `.zoomed-out` takes
  pointer events off the xterm body, so the mousedown target is the plain `<div>` panel, and
  **mousedown's default action moves focus off our textarea after the handler runs**. Calling
  `focus()` and then letting the default proceed is a no-op. `e.preventDefault()` on mousedowns
  outside the panel head fixes it; the head is excluded so its buttons still work.
- **Token pill contrast.** Murat found the pill unreadable — it was `--glow` text on a
  `--glow-dim` background, i.e. tinted on tinted, and suggested cyan as orange's complement.
  Went with dark text (`#0d1016`) on a solid `--glow` fill instead: lightness contrast is much
  stronger than hue contrast at 10 px, and a fixed cyan would both detach the pill from its
  agent's color and disappear against the turquoise Gemini panel.
- **Verified:** `node --check` ×3; `npm test` → 15/15 attention + 10/10 session attribution;
  clean `ELECTRON_ENABLE_LOGGING=1` boot with no renderer errors.
- **Left for Murat to do by hand:** the saved workspace still holds three wrong session ids
  claimed under the old rule. The running app rewrites that file from memory on close, so it
  has to be cleared *after* quitting multicli —
  `%APPDATA%\MultiCli for AI Agent Management\multicli-config.json` (note the folder is named
  after `productName`, not `multicli`).

### 2026-08-30

- **Remote access implemented (K22)** — see §3.7 for the full design. Summary: a
  Tailscale/LAN-reachable HTTP+WS server (`remote.js`, new `ws` dependency) serves the
  existing `src/renderer.js`/`styles.css`/xterm bundle to a browser via a new
  `src/remote-bridge.js` bridge (mirrors `preload.js`'s `window.multicli` surface over
  WebSocket instead of `contextBridge`), gated by a per-install random token. `main.js`
  gained a live-panel registry (`panelMeta`, `panel:announce`/`panel:closed`,
  `panels:listLive`) and a `broadcast()` helper so every attached viewer (desktop + any
  number of remote tabs) converges on the same panel set and terminal output.
  `renderer.js` gained `attachLivePanels()` (attach to what's already running instead of
  spawning a duplicate) and collision-resistant panel ids (`mintPanelId()`), since the
  old per-page-load sequential counter could let a remote tab and the host mint the same
  id and have `pty:spawn` silently kill a live local session — found by tracing the
  design before it ever shipped, not by hitting the bug.
- Along the way, converted the rest of `main.js`'s `ipcMain.handle`/`ipcMain.on` bodies
  (pty:write/resize/kill) into named top-level functions, matching the earlier
  handler-conversion pass, so every one of them is reachable from both Electron IPC and
  the new remote WebSocket dispatch table off one shared implementation.
- **TripMate HQ integration was considered and dropped.** The plan was to embed the
  remote web UI in an iframe inside TripMate HQ (GAS); Murat looked at the actual
  requirements (HTTPS via Tailscale Serve, X-Frame-Options/CSP compatibility, a
  triple-nested-iframe) and decided a second plain browser tab is simpler and just as
  good — nothing was embedded, no GAS changes were made.
- **Verified end-to-end** — but see the 2026-08-31 entry: "end-to-end" here stopped at
  *fetching* `remote.html`, which is not the same as a browser *loading* it, and that gap
  hid a blocker. The rest of what's described below did hold up. `test/remote.test.js` (new, added to
  `npm test`) exercises the plain HTTP/WS server directly — token gate on both HTTP and
  the WS upgrade, a static file fetch, a call/result round trip (including an
  unregistered method and a throwing handler both resolving instead of hanging), and
  `broadcast()`'s exceptSender exclusion. Separately, launched the real Electron app with
  `--remote-debugging-port` and drove it over CDP: confirmed the "Start Remote Access…"
  menu item exists, `window.multicli.remote.start()` actually starts the server and
  returns real Tailscale/LAN URLs (the Tailscale interface was correctly detected and
  sorted first), fetched `remote.html` through the running server with the real token,
  opened a real WebSocket to it and called `panels:listLive`, which correctly returned
  the 3 real panels the desktop window had open (ids, agentId, cwd, sessionId, geom) —
  proof the announce → registry → remote-dispatch path works with the live app, not just
  mocked handlers. Also fixed a latent bug this surfaced: `test/session-claim.test.js`'s
  source-extraction regexes assumed `session:claim`/`quotas:getSession` were still
  inline `ipcMain.handle` arrow bodies, which an earlier pass in this same session had
  already converted to named functions + one-line registrations — the regexes now grab
  the function body and its registration line separately.
- **Also fixed a self-inflicted process-management mistake made during that CDP
  verification**: cleaned up the test Electron instance with `taskkill /IM electron.exe
  /T`, which kills every process named `electron.exe` **system-wide**, not just the one
  launched for the test — the right tool is killing the specific PID tree (or just
  closing the window) instead. No other Electron-based app appeared to be affected this
  time (checked immediately after), but the command itself was wrong and shouldn't be
  reused.
- Documented §3.7 and this K22 decision; §3.6's stale "remote access... not taken" note
  updated to point here.

### 2026-08-31

Review pass over the (still uncommitted) K22 work, at Murat's request. Three bugs found,
two of them blockers, all three fixed and pinned with regression tests.

- **The remote page loaded with no CSS and no JS.** `handleHttp` required `?token=` on
  *every* request, but only the page URL carries a query string — the `<link>`/`<script>`
  it pulls in are root-absolute paths (`/styles.css`, `/renderer.js`, `/vendor/xterm.js`),
  so all six subresources 401'd and the browser got bare HTML. Fixed by issuing the token
  as an `HttpOnly; SameSite=Strict; Path=/` cookie on the entry pages (`/`, `/remote.html`)
  and accepting *either* query or cookie in a new `authorized(req)`, used by both the HTTP
  handler and the `/ws` upgrade. The gate is preserved, not weakened: a forged cookie is
  still rejected. `Secure` is deliberately omitted — there's no TLS here and a Secure
  cookie over plain HTTP is silently dropped.
- **Why it shipped, which matters more than the bug:** yesterday's "verified end-to-end"
  step *fetched* `remote.html` and got a healthy 200. That tells you nothing about whether
  a browser can use the page, because the failure lives entirely in the follow-up requests
  the browser makes on its own. Worse, `test/remote.test.js` asserted `static file without
  token -> 401`, which actively locked the bug in. The lesson: for anything a browser
  renders, the verification has to be *a browser*. This time it was — the page was opened
  in Chrome against a standalone Node harness (no Electron, so the running app was left
  alone) and checked for `document.styleSheets.length > 0`, `typeof window.multicli ===
  'object'`, a live WS round trip to a real handler, and a clean console.
- **A busy port bricked the feature until restart.** A failed `listen` left the module
  holding a dead server whose `address()` is null, so the *next* "Start Remote Access"
  click took the already-running early exit and threw "Cannot read properties of null"
  instead of a real error — forever, even after the port freed up. Fixed by gating the
  early exit on `server.listening` (not just non-null) and clearing `server`/`wss` in the
  error handler before rejecting.
- **A failed start was invisible.** The renderer's menu handler had no try/catch, so a
  rejection went nowhere: no dialog, no label flip, the menu item just looked dead. Added
  a catch plus a `remoteAccessFailed` string in both locales.
- Tests: `test/remote.test.js` grew a "what a real browser actually does" block (entry
  page hands out the cookie; each subresource loads on the cookie alone; a forged cookie
  is rejected; a cookie-only WS upgrade is accepted — using the `ws` client, since the
  global `WebSocket` can't set request headers) and a port-busy recovery block (EADDRINUSE
  on the first try, *the same* EADDRINUSE on a retry rather than a null-deref, success once
  the port is free). Windows gotcha worth remembering: the squatter socket must
  `listen(port)` with no host to match `remote.js` and take the dual-stack wildcard —
  pinning it to `0.0.0.0` leaves `::` free and the clash never happens, which is exactly
  how the new checks first failed.
- Full `npm test` green: attention, session-attribution, and all remote-access checks.
- **Verified in a real browser this time**, which is the whole point of the second bullet:
  opened the remote page in Chrome against a standalone Node harness (`remote.js` with stub
  handlers, no Electron, so the running app was untouched) — `document.styleSheets.length`
  2, `typeof window.multicli` object, `__MULTICLI_REMOTE__` true, xterm loaded, a live WS
  round trip through `agents.list()` and `settings.getDefaultBaseDir()`, clean console.
- **Pushed** (`c8bebdb`, then `4d3122b` for the README screenshot). The GitHub repo has
  been renamed `multicli` → `MultiCli`; `origin` updated to match. Description now mentions
  remote access and the `remote-access`/`tailscale` topics were added — note GitHub caps a
  repo at **20 topics** and we're now at the cap, so anything further has to displace an
  existing one.
- One caveat on the first "the remote page looked terrible and nothing worked" report:
  that was not a design problem at all. The desktop app had been started at 09:00 and
  `remote.js` is `require`d once at main-process startup, so it was still serving the
  pre-fix code that 401s subresources — bare unstyled HTML with no JS. Restarting the app
  fixed it. Worth remembering before debugging anything else in this file: **a change to
  `remote.js` needs an app restart, not just a reload.**

#### Session claiming is still broken for already-saved ids (diagnosed, then fixed — see K23 below)

Found while Murat was testing the remote view: panel 1 was showing *this* Claude
conversation — the one running in an ordinary PowerShell window, outside multicli.

The saved workspace held three session ids whose transcripts were created 26–28 Aug,
while the panels claiming them spawned on 31 Aug at 09:00. So none of them could have been
a legitimate claim. Two separate causes:

1. **The generator:** `defaultBaseDir` is `C:\Users\murat`. With no project open, every
   panel runs its agent in the home directory — the same `~/.claude/projects/C--Users-murat/`
   that Murat's own PowerShell Claude sessions write to (21 transcripts had piled up in
   there). Panels and foreign sessions meet in one folder.
2. **What makes it permanent:** those ids were claimed under the *old* mtime rule and
   written to the workspace. K19's birthtime fix only governs *new* claims; `sessionClaim`'s
   final `return current || null` never drops an id it already holds, and `restoreOnStart`
   re-runs `claude -r <that id>` on every launch. So a panel resumes someone else's live
   conversation forever. The 29 Aug note said Murat should clear the config by hand — that
   was the wrong call, since it left the failure mode intact.

Also surfaced: there is currently **no way to deliberately bind a panel to an existing
session**. "Choose Session…" runs bare `claude -r`, which opens the *CLI's* own picker, so
multicli never learns which session was chosen, and the strict birthtime rule then refuses
to claim it — no id, no token badge, nothing saved.

Agreed direction (not yet implemented):

- Store `claimedAt` next to `sessionId` in the workspace and re-check the birthtime rule at
  restore; records without it (i.e. all existing ones) are untrusted and dropped once, so
  bad state heals itself instead of needing a manual config edit.
- Verify the transcript actually lives in the panel's cwd folder before `claude -r`.
- Give multicli its own session picker (`sessions:list` + a preview of each transcript), so
  a user-chosen session is recorded as an *explicit* claim that bypasses the heuristic. The
  birthtime rule should only ever guard *automatic* claims.
- Separately, `defaultBaseDir` should not be the home directory. Panels opened with a real
  project folder each get their own transcript pool and the collision cannot arise.

Worth recording about the transcript format, since it decides whether sessions can be
moved between project folders: Claude locates a session **by which folder the `.jsonl` sits
in**, not by the `cwd` field inside it. That field is per-message and a single session
routinely spans several directories (one here had five, because the user `cd`s during the
session). So moving a transcript into another project's folder is a plain file move and
`claude -r` keeps working; only `~/.claude/history.jsonl`'s `project` field goes stale, and
that only affects prompt-history recall, not resuming.

Acted on that immediately: the home-directory pool was split up, each session moved into
the project folder it actually belonged to (M669, nexuscore, BlackBox, TripMateOPS,
TripMate-Manuals, notebooklm-py, multicli), taking `~/.claude/projects/C--Users-murat/`
from 21 transcripts / ~220 MB down to 10 / 76 MB. Two dead ones were deleted after being
summarised and checked against the memory notes first. One misstep worth recording: a
transcript was deleted while a `claude.exe --session-id` process still held it — it was a
214-byte title stub so nothing was lost, but **check the process list before deleting a
transcript**.

#### The fix (K23) — `session:verify`

Written the same afternoon. The shape of the bug is that `sessionClaim` only ever runs
*forward*: it is careful about which id a panel takes, and then never questions one it
already holds. Everything else follows from that, so the fix is a single backward check.

- **`session:verify` (main.js)** — given a saved id, re-asserts the claim rule against the
  file on disk and answers with the id or `null`. Three ways to fail: no provenance (a
  record written before this check existed), the transcript isn't in this panel's folder
  any more (it moved, or it was deleted), or the transcript was *created* before the run
  that claimed it. That last one is the hijack: a foreign session's file predates the panel
  entirely, which is exactly what all three bad records looked like.
- **Provenance is `sessionSince`** — the `spawnedAt` a claim was judged against, recorded in
  `claimPanelSession` only when the id actually *changes*, and carried through the workspace
  record, the live-panel registry and `panel:new`. Deliberately not re-stamped on a restore:
  the transcript's birthtime has to be compared against the *original* run, so overwriting
  it with the current spawn would destroy the only evidence there is.
- **`restoreCommandFor` gained `distrusted`** — because dropping the id alone would have
  quietly undone the whole thing. With no id and a sole panel for its folder, K20's case 2
  fires `claude -c`, which means "continue this folder's latest conversation" — the same
  hijack by another route. If verification *rejected* an id, `-c` is off the table too.
- `resolveCwd()` was pulled out of `ptySpawn` so the folder for an unspawned panel can be
  worked out at restore time, which is the one moment the check needs it.
- Seven cases added to `test/session-claim.test.js` (10 → 17, full suite green). They build
  real files in a real order, because birthtime can't be faked through `fs.utimes`.

Not done, still open: **multicli's own session picker**. "Choose Session…" still shells out
to bare `claude -r` and its CLI picker, so a deliberately chosen session stays invisible to
the app. That needs `sessions:list` plus a preview, and it's a feature rather than a bug —
the birthtime rule should only ever guard *automatic* claims, never an explicit one.

`defaultBaseDir` is **still** the home directory — worth being precise about, because it was
briefly recorded here as fixed on the strength of a config file that turned out to be dead.
There are two userData folders: `%APPDATA%\multicli\` (stale, last written 26 Aug, from
before `productName` was set) and `%APPDATA%\MultiCli for AI Agent Management\` (live, the
one `app.getPath('userData')` actually resolves to). Read the second one. The generator side
of the bug therefore stands, and it only stays harmless as long as every panel has a real
project folder assigned.

Verified in the running app, not just in the harness. Murat exited his sessions and closed
the app, so it was relaunched with `--remote-debugging-port` and driven over CDP — which
goes through the real renderer → preload → `ipcMain` → main.js path, the part a test that
`eval`s functions out of main.js can't reach. All three panels restored, zero renderer
errors, and against a real transcript (multicli's own): a legitimate provenance keeps the
id, a transcript predating the panel by an hour is dropped, a record with no provenance is
dropped, an unknown id is dropped, and the same id checked against another project's folder
is dropped. `restoreCommandFor` was exercised in the live renderer too, including the case
that matters most — **id rejected ⇒ `claude` fresh, not `claude -c`**. The workspace now
persists `sessionSince` alongside `sessionId`.

Two things this could not prove, because doing so would mean burning real tokens on a live
CLI: that a *fresh* claim stamps `sessionSince` correctly end-to-end, and that a genuine
restore resumes the right conversation. Both run through code paths that are covered by
`test/session-claim.test.js`, but the first real restore is still the moment to watch.
