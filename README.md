# dsh-session-delete

Add a **Delete Session** action to the [DeepSeek Harness](https://github.com/deepseek-ai) (DSH)
sidebar. Choosing it permanently removes the Session's stored log and its projection cache, and
drops the sidebar row without a page reload.

> [!IMPORTANT]
> **This project was written by AI.** The code, this README, and every other file in this
> repository were produced by an AI coding agent (see [AI authorship](#ai-authorship)). It was
> reviewed and tested against a real DSH install before publication, but you should treat it as
> AI-generated software: read the source before you run it, and expect rough edges outside the
> paths that were exercised.

---

## Why this plugin exists

DSH has no API for deleting a Session. As of the versions this was built against:

| Candidate | What it actually does |
| --- | --- |
| `sessionController` (Host `ctx.remote.session`) | `resolveAgent` / `inspect` / `list` / `search` / `create` / `selectModel` / `rename` / `fork` / `prompt` / `cancel` / `page` / `projections` — **no delete** |
| `sessionPersistence` | `create` / `open` / `flush` / `stat` / `list` — an append-only log, **no delete** |
| `workspaceRegistry.delete(id)` | Deletes a *Workspace registration* while deliberately retaining the directory and **every Session log** |
| `sessions` (client) | `retain` / `using` / `refreshProjections` / `search` / `fork` / `scope` / `binding` — **no delete** |

So the only way to offer the feature is to compose the official seams in the right order. This
plugin does exactly that, and nothing else.

## How it works

The Host half registers one loopback route, `POST /plugins/session-delete/delete`, and the browser
half adds a row to each Session's `...` menu that calls it.

Deletion runs as five steps:

1. **Stop the Session** — `workspaceRegistry.archiveSession(id, { stopActivity: true })`. This is
   the official "stop this Session's activity" path; it fans out `workspace/session-stop`, which
   `dsh-agent`, `dsh-jobs`, `dsh-schedule` and `dsh-subagent` all listen to.
2. **Detach the live Session** — `ctx.sessions.store.get(id).detach()`. The store keeps entries in
   a non-public map, and calling the entry's own `detach` is the single seam that raises
   `session/disposed`.
3. **Remove the sidebar row** — `session/disposed` → `api-session/removed`
   (`dsh-api-session-controller`) → `ctx.remote.$on("api-session/removed", …)` on the client. That
   chain is the only reason the row disappears without a reload.
   A **cold** Session (one restored from disk that was never opened in this process) has no store
   entry, so `detach` cannot fire. For that case the plugin emits `api-session/removed` itself —
   the same signal, by the same name. Nothing on the Host listens for that event, so this is
   side-effect free.
4. **Forget the membership** — `detachSession` on every Workspace, plus `unarchiveSession` and
   `unpinSession`, so no archived or pinned ghost survives.
5. **Remove the bytes** — the artifact directory under `$DSH_HOME/sessions/<encoded-cwd>/<id>/`
   and the projection cache at `$DSH_HOME/storages/session_projcache/sessions/<id>.json`.

The SQLite session index is *derived* from persistence state, so it converges on its own during the
next reconcile — the plugin does not touch it.

### Files touched on disk

Everything the plugin removes lives under `$DSH_HOME` (default `~/.dsh`):

```
$DSH_HOME/
  sessions/<encoded-cwd>/<session-id>/session.v4.jsonl[.zstd]   <- removed
  storages/session_projcache/sessions/<session-id>.json         <- removed
  storages/workspace.json                                       <- membership updated in place
```

## Install

There are two ways to mount it.

> Only **Option A** was verified end to end. Option B is the standard bundle shape and the package
> manifest is written for it, but it was not exercised with this package name — treat it as
> untested.

### Option A — mount from a checkout (no install step)

This is the simplest route, and the one used during development and testing.

1. Clone this repository somewhere permanent.
2. Create or edit `$DSH_HOME/cordis.patch.yml` (Windows: `%USERPROFILE%\.dsh\cordis.patch.yml`)
   and point `name` at the **absolute path** of `host.js`:

   ```yaml
   - insert:
       - id: session-delete
         name: 'C:/Users/you/code/dsh-session-delete/host.js'
   ```

3. Save the file. DSH's HMR watches this patch layer, so the plugin mounts immediately — no
   restart needed.
4. Reload the DSH page in your browser so it picks up the new client bundle.

See [`examples/cordis.patch.yml`](examples/cordis.patch.yml) for an annotated version of this file.

### Option B — install as a profile bundle (untested)

Install the package into the `web` profile and enable it. The exact command depends on how your DSH
build exposes plugin management; the package is shaped for it:

```jsonc
// package.json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },   // Host half
  "client": { "platform": "web", "immediately": true, "inject": [ /* ... */ ] }
}
```

Note that the bundled [`cordis.patch.yml`](cordis.patch.yml) uses the package name
`dsh-session-delete`, whereas the checkout in Option A uses an absolute path. That difference is
intentional — see the next section.

## Host reload semantics (read this before editing `host.js`)

Node's ESM registry caches modules by **resolved URL** and offers no invalidation hook. A DSH
plugin mounted by absolute path is imported as a `file://` URL, which means:

> **Editing `host.js` in place does not take effect in a running DSH.**

To load changed Host code you must either restart DSH, or bump the filename
(`host.js` → `host.v7.js`) and update `name` in the patch file to match.

A second wrinkle follows from the same design: a route-table entry can outlive the fiber that
registered it, and `webServer.register` throws on a duplicate path. `host.js` therefore evicts
retired generations' paths (`STALE_ROUTES`) before claiming its own. If you fork this and add
generations, extend that list.

The route path itself, `/plugins/session-delete/delete`, is deliberately **stable**, because the
browser bundle ships with it baked in.

## Configuration

The plugin takes no configuration. The `id` in the patch file is arbitrary; pick something unique
to your install so it does not collide with another row.

## Security notes

- The route is served by the Host's web server and inherits its access policy. On DSH Desktop the
  desktop web server rejects browser requests that its access policy denies (HTTP 403) before the
  handler runs.
- The handler accepts only `POST`, caps the body at 64 KiB, and validates `sessionId` against
  `/^[A-Za-z0-9._:@-]{1,200}$/` — an id cannot escape its own directory.
- There is no authentication beyond the Host's own browser-access decision. If you expose a DSH
  web server beyond loopback, understand that this route deletes files.

## Limitations

- **Deletion is permanent.** There is no trash and no undo. The confirmation dialog is the only
  guard.
- **Path shape is version-dependent.** Step 5 assumes the JSONL persistence layout
  (`$DSH_HOME/sessions/<encoded-cwd>/<id>/` and `storages/session_projcache/sessions/`). A DSH
  release that changes either layout will need this plugin updated; step 5 would silently remove
  nothing rather than fail loudly.
- **Non-public seam.** Step 2 reaches into `ctx.sessions.store`, which is not a public API. If DSH
  renames or hides it, the live-Session branch degrades to the cold-Session path (which still
  removes the bytes and the sidebar row, via step 3's explicit emit).
- **`node --check` is the only automated test.** There is no test suite. See
  [Testing](#testing) for the manual verification that was performed.
- **Not tested on macOS or Linux.** The removal retry loop in `host.js` exists specifically for
  Windows handle semantics. It is written to be harmless elsewhere, but that is a reading of the
  code, not a measurement.

## Testing

Syntax:

```sh
npm run check      # node --check host.js && node --check client.js
```

The end-to-end verification performed before publication, on Windows with Node 24:

1. Mount via Option A and confirm the Loader entry is active.
2. `POST` the route with a bogus id — expect `200` and a report naming the steps that were skipped:

   ```sh
   curl -X POST http://127.0.0.1:<port>/plugins/session-delete/delete \
     -H 'content-type: application/json' -d '{"sessionId":"bogus"}'
   ```

3. Create a throwaway Session artifact and projection-cache file, delete it through the route, and
   confirm both paths are gone while real Sessions are untouched.
4. Confirm the sidebar row appears in the Session `...` menu and that deleting removes it without a
   reload.

## Repository layout

```
host.js                     Host half: the deletion route and its five steps
client.js                   Browser half: the Session-menu row
cordis.patch.yml            Bundle patch (used by Option B)
examples/cordis.patch.yml   Annotated checkout-mount patch (Option A)
docs/ai-authorship.md       How this project was produced
package.json                Manifest, including the dsh.client declaration
LICENSE                     MIT
```

## AI authorship

This repository is AI-generated. It was written end to end by an AI coding agent running inside
DSH, driven by a human who specified the goal ("deploy a plugin that lets me delete sessions from
DSH; write the code yourself") and steered the debugging.

What that means in practice, stated plainly:

- **The code is AI-written.** The human did not hand-author the implementation. Their contribution
  was the objective, the constraints, the review, and the decision to publish.
- **The design rests on reverse-engineered internals.** The five-step deletion sequence was
  derived by reading DSH's shipped JavaScript, not from public documentation. Some of it uses
  non-public seams (notably `ctx.sessions.store`), which is why the limitations above are spelled
  out rather than buried.
- **Testing was manual and narrow.** There is no test suite. Verification covered the paths listed
  under [Testing](#testing); other paths are untested.
- **No warranty.** See [LICENSE](LICENSE) — MIT, provided "as is". Given that this plugin deletes
  files permanently, back up `$DSH_HOME` before first use.

Fuller account: [`docs/ai-authorship.md`](docs/ai-authorship.md).

## License

[MIT](LICENSE).