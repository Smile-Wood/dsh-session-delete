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

The plugin installs as a **profile bundle**, using DSH's own plugin command:

```sh
dsh plugin --profile web add github:Smile-Wood/dsh-session-delete
```

From a local checkout instead of a git host:

```sh
dsh plugin --profile web add C:\path\to\dsh-session-delete
```

Use the profile you actually launch DSH with (`web` is the DSH Desktop default, and is also what
`dsh plugin …` assumes when you omit `--profile`). `dsh` is a shim into the packaged CLI, placed on
`PATH` once DSH Desktop has been started at least once.

> [!NOTE]
> **The repository must be public for the `github:` shorthand.** pnpm probes the HTTPS URL first and
> only falls back to SSH when that probe fails, which is what happens for a private repository or a
> nonexistent one. On a machine where outbound SSH (port 22) is blocked, that fallback fails with
> `ssh: connect to host github.com port 22: Connection refused`. For a private repository, use an
> explicit HTTPS spec and let git's credential helper authenticate:
>
> ```sh
> dsh plugin --profile web add git+https://github.com/Smile-Wood/dsh-session-delete.git
> ```

Then reload the DSH page in your browser so it picks up the browser bundle, and open a Session's
`...` menu in the sidebar. **DSH itself does not need restarting.**

To update after new commits land, re-run the same command:

```sh
dsh plugin --profile web add github:Smile-Wood/dsh-session-delete
```

Re-running `add` *is* the update path: pnpm re-resolves the ref, and a changed shipped file lands in
a new content-addressed store directory, so DSH imports a **new module URL** and the Host half
genuinely reloads. See [Host reload semantics](#host-reload-semantics).

To remove it again:

```sh
dsh plugin --profile web remove dsh-session-delete
```

That prunes the dependency, drops the name from `dsh.profile.bundles`, and unloads both halves —
verified live: the route stops answering and the browser bundle leaves the client-module graph.

> [!NOTE]
> For a **local-path** install the profile entry is a `link:`, and pnpm was observed to leave the
> symlink at `$DSH_HOME/profiles/<profile>/node_modules/dsh-session-delete` behind after a `remove`.
> It is inert, but delete it by hand if you want the tree clean. Git installs are unaffected.

### What `dsh plugin add` actually does

`dsh plugin` is a thin front end for pnpm: it forwards its arguments to pnpm **inside the profile
directory** (`$DSH_HOME/profiles/<profile>/`). The part that makes the plugin load is what DSH does
next — it reconciles the profile manifest and, for every dependency that was just added and declares
a `dsh.bundle.patch`, appends its package name to `dsh.profile.bundles`:

```jsonc
// $DSH_HOME/profiles/web/package.json, after the add
{
  "dependencies": {
    "dsh-session-delete": "git+https://github.com/Smile-Wood/dsh-session-delete.git"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "…existing bundles…",
        "dsh-session-delete"        // <- appended by the add
      ]
    }
  }
}
```

`dsh.profile.bundles` is the **only** thing that decides what loads. That array is why one command
is sufficient and no `$DSH_HOME/cordis.patch.yml` row is required.

A dependency that declares no `dsh.bundle` is installed as a plain dependency and skipped, with a
warning:

```
dsh: warning: <name> declares no dsh.bundle — installed as a plain dependency, not a profile layer
```

The bundled [`cordis.patch.yml`](cordis.patch.yml) is the patch this profile layer reads:

```yaml
- insert:
    - id: session-delete
      name: 'dsh-session-delete'
```

`name` is the **package name**, not a path — the profile resolves it from its own `node_modules`.

> [!NOTE]
> `client.js` registers itself under the name `dsh-session-delete`, which must stay
> **character-for-character identical** to `name` in `package.json`. client-modules derives the
> browser bundle's id from the enclosing `package.json` and rejects a bundle that registers under
> anything else — and the only symptom is a menu row that silently never appears.

## Host reload semantics

Node's ESM registry caches modules by **resolved URL** and offers no invalidation hook. That has one
practical consequence:

> **Editing an installed `host.js` in place does not take effect in a running DSH.**

How much that bites depends on how you installed:

- **From git**, pnpm copies the package into its content-addressed store. A changed file produces a
  new store directory, so re-running `add` yields a new URL and the Host half reloads.
- **From a local checkout** (`dsh plugin … add C:\path\to\…`), the profile entry is a `link:`, so
  `node_modules/dsh-session-delete` is a symlink to your working copy. Edits land on the *same* URL
  and are never re-imported, no matter how often you save.

So if you are iterating on `host.js` itself, install from a git spec (or restart DSH) rather than
relying on a linked checkout.

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
- **Installation needs `dsh` and pnpm.** Both ship with DSH Desktop. There is no dependency-free
  install path any more — the plugin is a profile bundle, and installing one means letting DSH
  reconcile its profile manifest.
- **`remove` can leave a dangling symlink for local-path installs.** If you installed with
  `dsh plugin … add C:\path\to\dsh-session-delete`, the profile entry is a `link:`. Removing it
  prunes the manifest and the lockfile, but the symlink at
  `$DSH_HOME/profiles/<profile>/node_modules/dsh-session-delete` was observed to survive; delete it
  by hand. It is inert (nothing loads it), but it is untidy. Git installs copy into the store and
  are not affected.
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

1. Run `dsh plugin --profile <profile> add <spec>` and confirm the name appears in
   `dsh.profile.bundles` and the Loader entry is active.
2. `POST` the route with a bogus id — expect `200` and a report naming the steps that were skipped:

   ```sh
   curl -X POST http://127.0.0.1:<port>/plugins/session-delete/delete \
     -H 'content-type: application/json' -d '{"sessionId":"bogus"}'
   ```

3. Create a throwaway Session artifact and projection-cache file, delete it through the route, and
   confirm both paths are gone while real Sessions are untouched.
4. Confirm the sidebar row appears in the Session `...` menu and that deleting removes it without a
   reload.
5. Run `dsh plugin --profile <profile> remove dsh-session-delete` and confirm the route stops
   answering and the bundle leaves the client-module graph.

## Repository layout

```
host.js                     Host half: the deletion route and its five steps
client.js                   Browser half: the Session-menu row
cordis.patch.yml            Bundle patch, resolved by package name
docs/ai-authorship.md       How this project was produced
package.json                Manifest, including the dsh.bundle and dsh.client declarations
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