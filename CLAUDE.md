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
  a private GitHub repo the same day v2 restarted.
- Don't start coding before v2's architecture is settled; implement as PROJECT.md §3
  fills in.

## Structure and references

- Folder: `C:\Users\murat\Projects\multicli`
- Repo: https://github.com/mrtengn-arch/multicli (private)
- Related memory notes: [[feedback_cost_delegation]] (the project's "why"),
  [[project_ai_limit_hq]] (a similar "quota tracking" idea but a different product — one
  is a browser extension + dashboard, this is a terminal tool), [[project_conduit]] (the
  CLI-lane idea shows up there too)
- WezTerm is installed on this machine (26 Aug 2026, `winget install wez.wezterm`) — was
  considered and dropped as a terminal backend option; v2 has its own Electron window
  and doesn't depend on it.
