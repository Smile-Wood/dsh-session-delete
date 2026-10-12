# AI authorship

This document records how `dsh-session-delete` was produced. It exists because the project is
entirely AI-generated, and that fact should be as legible as the code itself.

## Summary

| | |
| --- | --- |
| **Origin** | Written by an AI coding agent inside DeepSeek Harness, over a single extended session |
| **Human role** | Set the goal, fixed the constraints, reviewed results, approved publication |
| **Model** | DeepSeek (`deepseek-v4.1-flash`; the session spanned several model switches) |
| **Human-authored code** | None |
| **License** | MIT |

## How the work was directed

The human's entire initial instruction was, in substance:

> Deploy a plugin that lets me delete sessions inside DSH. Write the code yourself.

Everything after that was the agent working: reading DSH's source, locating the seams, writing the
plugin, installing it, and debugging why it did not appear in the UI. The human's later
contributions were short — mostly "continue", plus a report that the menu item was missing from
the sidebar, which triggered the longest debugging arc.

## What the agent actually did

1. **Established that no delete API exists.** It enumerated the Host and client services
   (`sessionController`, `sessionPersistence`, `workspaceRegistry`, `sessions`, `uiWorkspace`) via
   read-only introspection and confirmed none of them deletes a Session. This ruled out the
   obvious implementation and forced the seam-based design.
2. **Found the event chain that refreshes the UI.** `session/disposed` is emitted by the
   `SessionStore`; `dsh-api-session-controller` listens and re-emits `api-session/removed`; that
   event is forwarded to the browser, where the client controller removes the sidebar row. This
   chain is the reason a deletion is visible without a reload.
3. **Read a working third-party plugin** shipped on the same machine to learn the official Host
   route-registration idiom (`ctx.effect(() => ctx.webServer.register({...}))`) and the browser
   half's bundle shape (`window.__ModuleLoader__.load({ id, factory })` with a hand-built CommonJS
   `exports` object).
4. **Wrote both halves** and mounted them.
5. **Debugged a silent no-show.** The menu item did not appear. The cause turned out to be that the
   browser bundle was never admitted to the client-module graph, because the package did not
   export `./package.json` — the resolver needed to read the manifest by that path. The fix was a
   one-line `exports` addition. This took a substantial number of steps to isolate, because the
   route probe used to check registration returned a status that was being misread.
6. **Found a mount channel that avoids package installation.** `$DSH_HOME/cordis.patch.yml` is a
   machine-wide patch layer that DSH's HMR watches live. Inserting a row whose `name` is an
   absolute path mounts the plugin with no `pnpm install` and no restart.
7. **Solved the reload problem.** Editing `host.js` in place had no effect, because Node's ESM
   registry caches by resolved URL. The workaround — a new filename per generation plus a patch
   row that disables the previous one — is now documented in the README, since anyone editing this
   code will hit it immediately.
8. **Closed a real UX gap.** Deleting a *cold* Session (one restored from disk, never opened in the
   running process) removed the bytes but left the sidebar row, because there was no store entry to
   detach. The fix emits `api-session/removed` directly for that case. The agent verified by
   searching the whole application that nothing on the Host listens for that event, so the emit is
   side-effect free.
9. **Cleaned up after itself.** Test sessions injected during debugging, dangling profile symlinks,
   and scratch files were all removed, and the three real Sessions present on the machine were
   confirmed intact.

## Corrections and dead ends

Recording these matters more than usual for AI-written code, because they show where the reasoning
was wrong and how it was caught.

- **A misread HTTP status.** Early probes treated a `403` as evidence that a route was registered.
  It was actually the desktop web server's browser-access denial. A later controlled comparison —
  probing a *known-good* third-party bundle alongside the new one, using correctly computed
  revision hashes — produced the real answer: the new package was absent from the graph. The lesson
  generalizes: a probe without a working control group proves nothing.
- **An incorrect theory about `immediately`.** It was briefly assumed that the `dsh.client.immediately`
  flag controlled whether a bundle entered the client-module graph. Reading the resolver showed it
  is only validated and passed through. The real cause was the missing `./package.json` export.
- **Chasing a phantom.** Considerable effort went into removing test session ids from the workspace
  registry. They turned out to be invisible to the domain layer — the in-memory entity is rebuilt
  from an index, so ids the Host never opened are filtered out and `detachSession` correctly does
  nothing. The durable file was edited by hand to clean the residue instead.
- **Fifteen consecutive compression failures.** Context-compression calls failed repeatedly because
  model switches invalidated the message references being targeted. Not a code defect, but it
  shaped the session and is part of the honest record.

## What was verified, and what was not

Verified on Windows with Node 24, against a live DSH install:

- the Host Loader entry activates (`fiberPhase: active`);
- the route answers `POST` with a report, and retired generations' routes are evicted;
- the browser bundle is served from the client-module graph;
- the menu row registers as a slot occupant alongside the four shipped rows;
- end-to-end: a throwaway Session's artifact directory and projection-cache file are both removed,
  and real Sessions are untouched;
- `node --check` passes on both halves.

Not verified:

- any DSH version other than the one it was built against;
- non-Windows platforms (the removal retry loop exists specifically for Windows handle semantics);
- concurrent deletion of the same Session, or deletion during an active turn;
- behavior after a DSH upgrade that changes the on-disk layout.

## Maintenance expectations

A reader should assume this code was written by a capable agent with no long-term stake in the
result. It is small and commented, and the comments explain *why* each seam is used — which is the
part that matters, because the seams are the fragile thing. If DSH changes, the comments are the
map.