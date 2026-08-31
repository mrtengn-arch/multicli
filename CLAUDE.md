# multicli — Working Rules (auto-loaded every session)

**First thing:** read `PROJECT.md` — vision, v1's old architecture (§2, reference), v2's
evolving architecture (§3), decisions (§4), and the log (§5) all live there.
At the end of a session, add a dated entry to PROJECT.md's §5 Log; if you made a new
decision, add it to §4 with a K-number.

## Fixed rules

- **Language:** speak Turkish with Murat in conversation. Documentation/code in this
  repo (PROJECT.md, CLAUDE.md, README, comments, commit messages) is in **English**
  (Murat's explicit call, 26 Aug 2026) — this is a deliberate exception to the usual
  pattern in his other projects, where these files stay Turkish even for private repos.
- **Get approval before writing code** ([[feedback_gemini_rules]] — the "surgical
  intervention" principle applies to every project, not just GAS).
- Nothing from the v1 code is recoverable (deleted, no remote) — v2 starts from the
  architecture NOTES in PROJECT.md §2 but is written from scratch.
- **Set up the git remote early** — that was v1's biggest lesson (K1). Done: pushed to
  GitHub the same day v2 restarted (made public + MIT licensed on 26 Aug 2026).
- Don't use a bash-backgrounded launch of this app for throwaway screenshot verification
  — when the backgrounded shell task ends it can take the Electron process (and whatever
  panel the user had open) down with it (27 Aug 2026 lesson).
- If the machine's session might be locked or the display asleep, a screen-capture
  screenshot comes back solid black even though the window is real (`GetWindowRect`/
  `IsWindowVisible` confirm it) — not an app bug. Launch with `--remote-debugging-port` and
  verify over CDP (`Runtime.evaluate` on the websocket) instead of trusting a screenshot
  (29 Aug 2026 lesson).
- Don't start coding before v2's architecture is settled; implement as PROJECT.md §3
  fills in.
- Never clean up a test Electron launch with `taskkill /IM electron.exe /T` — it kills
  every process named `electron.exe` **system-wide**, not just the one under test, and
  could take down an unrelated Electron app the user has open. Kill the specific PID (or
  its PID tree) instead (30 Aug 2026 lesson).
- **A change to `remote.js` (or anything else `require`d by `main.js`) needs the app
  restarted, not reloaded.** Main-process modules are loaded once at startup, so a running
  instance keeps serving the old code — which is what made a fixed remote page still come
  up broken for half an hour (31 Aug 2026 lesson).
- **Never call a browser-rendered page verified because you fetched it.** Fetching
  `remote.html` returned a healthy 200 while the page was completely broken in a real
  browser: the failure lived in the subresource requests the browser makes on its own.
  Load it in an actual browser and check something only a working page can satisfy
  (`document.styleSheets.length`, `window.multicli`, a live round trip) — 31 Aug 2026,
  and the test suite had been asserting the broken behaviour as correct.

## Structure and references

- Folder: `C:\Users\murat\Projects\multicli`
- Repo: https://github.com/mrtengn-arch/MultiCli (public, MIT licensed, 26 Aug 2026;
  renamed from `multicli` on 31 Aug 2026 — the old URL still redirects)
- Related memory notes: [[feedback_cost_delegation]] (the project's "why"),
  [[project_ai_limit_hq]] (a similar "quota tracking" idea but a different product — one
  is a browser extension + dashboard, this is a terminal tool), [[project_conduit]] (the
  CLI-lane idea shows up there too)
- WezTerm is installed on this machine (26 Aug 2026, `winget install wez.wezterm`) — was
  considered and dropped as a terminal backend option; v2 has its own Electron window
  and doesn't depend on it.
