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

Clone the repository, then run one command:

```sh
git clone https://github.com/<your-username>/dsh-session-delete.git
cd dsh-session-delete
node install.mjs
```

That is the whole install. It needs Node 22+ and has no dependencies. DSH's HMR watches the file it
writes, so the plugin mounts **immediately** — no restart. Then reload the DSH page in your browser
so it picks up the browser bundle, and open a Session's `...` menu in the sidebar.

To update later:

```sh
git pull && node install.mjs
```

This is a real reload, not just a re-copy — see [Host reload semantics](#host-reload-semantics).

To remove it again:

```sh
node install.mjs --uninstall
```

Add `--dry-run` to either the install or the uninstall form to see exactly what would be written,
without writing it.

### What the installer does

It does not install a package manager artifact and does not touch your profile. It:

1. Copies `host.js`, `client.js` and a generated `package.json` into
   `$DSH_HOME/plugins/dsh-session-delete/rev-<content-hash>/`.
2. Writes a managed block into `$DSH_HOME/cordis.patch.yml` (Windows:
   `%USERPROFILE%\.dsh\cordis.patch.yml`) naming that copy's `host.js` by absolute path.

Re-running it is idempotent: the managed block is replaced in place, never duplicated, and
superseded `rev-*` directories are deleted. `--uninstall` removes the block and the staged copy,
and deletes the patch file if this block was its only content.

The managed block is delimited, so anything else you keep in `cordis.patch.yml` is preserved:

```yaml
# >>> dsh-session-delete managed block >>>
# ...
- insert:
    - id: dsh-session-delete
      name: 'C:/Users/you/.dsh/plugins/dsh-session-delete/rev-c471ce8e/host.js'
# <<< dsh-session-delete managed block <<<
```

Set `DSH_HOME` if your harness home is not `~/.dsh`; the installer reads the same variable DSH does.

### Why the installer stages a copy

Two reasons, both about how DSH loads a plugin mounted by path.

**Editing a mounted file in place does not take effect.** Node's ESM registry caches modules by
*resolved URL* and offers no invalidation hook, so a running DSH keeps executing the Host code it
first imported — forever, no matter how many times you save the file. The staged directory is named
after a hash of its contents, so changed sources land on a **new URL**. That is what makes
`git pull && node install.mjs` actually reload the Host half.

**The mount should not depend on the checkout.** Staging means you can move or delete the clone
afterwards and the plugin keeps working.

### Manual install (if you would rather not run the script)

Point `name` in `$DSH_HOME/cordis.patch.yml` at the **absolute path** of `host.js` in your checkout:

```yaml
- insert:
    - id: dsh-session-delete
      name: 'C:/Users/you/code/dsh-session-delete/host.js'
```

Save it — the plugin mounts immediately. But note the reload caveat above: with a fixed filename,
Host code edits will not take effect until you restart DSH or rename the file. That is exactly the
problem `install.mjs` exists to solve.
[`examples/cordis.patch.yml`](examples/cordis.patch.yml) is an annotated version of this file.

> [!NOTE]
> `client.js` registers itself under the name `dsh-session-delete`, which must stay **character-for-character
> identical** to `name` in `package.json`. When a plugin is mounted by path, client-modules derives
> the browser bundle's id from the nearest enclosing `package.json`, then rejects a bundle that
> registers under anything else — and the only symptom is a menu row that silently never appears.
> `install.mjs` checks this before it writes anything.

### Installing as a profile bundle (untested)

The package manifest also carries the standard bundle shape, so it can in principle be installed as a
profile bundle instead:

```jsonc
// package.json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },   // Host half, resolves by package name
  "client": { "platform": "web", "immediately": true, "inject": [ /* ... */ ] }
}
```

The bundled [`cordis.patch.yml`](cordis.patch.yml) uses the package name `dsh-session-delete` for
this case, whereas the installer writes an absolute path. This route was **not** exercised — use the
installer.

## Host reload semantics

Node's ESM registry caches modules by **resolved URL** and offers no invalidation hook. A DSH plugin
mounted by absolute path is imported as a `file://` URL, which means:

> **Editing `host.js` in place does not take effect in a running DSH.**

`install.mjs` sidesteps this by staging each revision under a content-addressed directory, so every
change produces a new URL. If you mount the file by hand, or edit a staged copy directly, you must
instead restart DSH or bump the filename (`host.js` → `host.v7.js`) and update `name` to match.

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

1. Run `node install.mjs` and confirm the Loader entry is active.
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
install.mjs                 One-command installer / uninstaller (no dependencies)
host.js                     Host half: the deletion route and its five steps
client.js                   Browser half: the Session-menu row
cordis.patch.yml            Bundle patch (used by the untested profile-bundle route)
examples/cordis.patch.yml   Annotated manual-mount patch
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