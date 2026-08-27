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

⚠️ **Open question:** This behavior varies from CLI to CLI — Claude Code has native
resume support, but gemini/qwen/codex CLIs may have different (or no) session/resume
mechanisms of their own. Each agent needs to be researched individually and its resume
command/flag added to `agents.json`. **To be settled before moving to the v2 coding
phase.**

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
