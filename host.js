/**
 * session-delete - Host half.
 *
 * DSH ships no Session-delete API: `sessionController` has no delete, the
 * append-only `sessionPersistence` has none, and `workspaceRegistry.delete()`
 * removes only a Workspace registration while keeping every Session log.
 *
 * This plugin therefore exposes one loopback route that performs the deletion
 * using the official seams:
 *
 *   1. `workspaceRegistry.archiveSession(id, { stopActivity: true })` - the
 *      official "stop this Session's activity" path (it fans out
 *      `workspace/session-stop`), and it also makes the id known to the
 *      registry when only a stored artifact remains.
 *   2. Detach the live Session from the SessionStore. The store keeps its
 *      entries in the non-public `store` map; calling the entry's own `detach`
 *      is the single seam that raises `session/disposed`.
 *   3. `session/disposed` -> `api-session/removed` (dsh-api-session-controller)
 *      -> `ctx.remote.$on("api-session/removed", ...)` on the client, which
 *      removes the sidebar row. That chain is the only reason the row
 *      disappears without a page reload.
 *   4. Drop the registry membership (detachSession / unarchiveSession /
 *      unpinSession) so no archived or pinned ghost survives.
 *   5. Remove the on-disk artifact directory and the projection-cache record.
 */

import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Cordis plugin name, used for diagnostics. */
export const name = "session-delete";

/**
 * Only `webServer` is required: the deletion targets are probed through
 * `ctx.get()` at request time so a missing optional service degrades the
 * feature instead of blocking the whole plugin from activating.
 */
export const inject = ["webServer"];

/**
 * Exact route served to the browser half.
 *
 * The path is deliberately stable, because the browser bundle ships with it.
 * What is *not* stable is the Host module URL: the Loader imports by resolved
 * URL and Node's ESM registry has no invalidation hook, so a code change only
 * takes effect under a new URL (see `$DSH_HOME/cordis.patch.yml`). A route-table
 * entry can outlive the fiber that registered it, and a disposer deletes by
 * path, so `STALE_ROUTES` below is evicted before this path is claimed.
 */
const ROUTE_PATH = "/plugins/session-delete/delete";

/**
 * Routes owned by retired generations of this plugin.
 *
 * `webServer.register` throws on a duplicate path, so a freshly imported
 * generation can only reclaim a path that a dead generation still holds by
 * removing that entry first. Every generation ever mounted on this machine is
 * listed here; an absent path is already the desired state.
 */
const STALE_ROUTES = [
	ROUTE_PATH,
	"/plugins/session-delete/delete-v2",
	"/plugins/session-delete/delete-v3",
	"/plugins/session-delete/delete-v4",
	"/plugins/session-delete/delete-v5"
];

/** Echoed in every response so a probe can name the generation that answered. */
const GENERATION = "v6";

/** Session ids are branded strings; keep the accepted alphabet tight. */
const SESSION_ID = /^[A-Za-z0-9._:@-]{1,200}$/;

/** Maximum accepted request body. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Resolve the DSH home directory the same way the Host does.
 * @returns absolute path of the DSH home.
 */
function dshHome() {
	const fromEnv = process.env.DSH_HOME;
	return fromEnv !== void 0 && fromEnv.length > 0 ? fromEnv : join(homedir(), ".dsh");
}

/**
 * Write one JSON response.
 * @param res - Node response.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function json(res, status, payload) {
	const body = JSON.stringify(payload);
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.end(body);
}

/**
 * Read and parse a small JSON request body.
 * @param req - Node request.
 * @returns the parsed body, or `{}` for an empty body.
 * @throws when the body is too large or not valid JSON.
 */
async function readJson(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new Error("request body too large");
		chunks.push(chunk);
	}
	if (size === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Remove a path, retrying while another handle still holds it.
 *
 * `session/disposed` makes the JSONL persistence layer close its writer, but
 * that close is asynchronous and deliberately not awaited by the dispose
 * handler. On Windows an unclosed handle makes `rm` fail with EBUSY/EPERM, so
 * the removal is retried briefly instead of reporting a half-finished delete.
 *
 * @param target - absolute path to remove.
 * @returns `true` when the path is gone.
 */
async function removeWithRetry(target) {
	const delays = [0, 80, 160, 320, 640, 1200];
	for (const delay of delays) {
		if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
		try {
			await rm(target, { recursive: true, force: true });
			return true;
		} catch (error) {
			const code = error?.code;
			if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
		}
	}
	return !existsSync(target);
}

/**
 * Locate the directory holding one Session's artifact.
 *
 * Preferred path is the persistence service's own `stat` + `locate` pair, so
 * the encoded project directory and compression suffix come from the backend
 * that actually wrote the file. The scan is a fallback for a Session the
 * backend no longer reports.
 *
 * @param persistence - the `sessionPersistence` service, when available.
 * @param sessionId - Session id to locate.
 * @returns the absolute directory path, or `undefined` when not found.
 */
async function resolveSessionDir(persistence, sessionId) {
	if (persistence !== void 0 && persistence !== null) {
		try {
			const snapshot = await persistence.stat(sessionId);
			const header = snapshot?.header;
			if (header !== void 0 && typeof persistence.locate === "function") {
				const located = persistence.locate(header);
				if (located?.path !== void 0) return dirname(located.path);
			}
		} catch {
			// Fall through to the directory scan.
		}
	}
	const root = join(dshHome(), "sessions");
	try {
		for (const entry of await readdir(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const candidate = join(root, entry.name, sessionId);
			if (existsSync(candidate)) return candidate;
		}
	} catch {
		// No sessions root: nothing to remove.
	}
	return void 0;
}

/**
 * Delete one Session: stop it, detach it, forget it, then remove its bytes.
 * @param ctx - the plugin context.
 * @param sessionId - Session id to delete.
 * @returns a report of the steps that succeeded and the files that were removed.
 */
async function deleteSession(ctx, sessionId) {
	const steps = [];
	const removed = [];
	const registry = ctx.get("workspaceRegistry");
	const sessions = ctx.get("sessions");
	const persistence = ctx.get("sessionPersistence");

	// Resolve the artifact directory before anything makes the id unresolvable.
	const directory = await resolveSessionDir(persistence, sessionId);

	// 1. Stop activity through the official archive path.
	if (registry !== void 0) {
		try {
			await registry.archiveSession(sessionId, { stopActivity: true });
			steps.push("archive");
		} catch (error) {
			steps.push(`archive-skipped: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// 2. Detach the live Session: the only seam that raises `session/disposed`.
	//
	// A Session that was never opened in this process (a "cold" row restored
	// from disk) has no store entry, so `detach` cannot fire and the sidebar
	// would keep showing the row it just lost its bytes for. The shipped
	// controller raises `api-session/removed` itself only from its
	// `session/disposed` handler, and that event has no Host listener, so
	// emitting it here is the same signal by the same name for the cold case.
	if (sessions !== void 0) {
		const store = sessions.store;
		const entry = store?.get?.(sessionId);
		if (entry !== void 0 && typeof entry.detach === "function") {
			entry.detach();
			steps.push("detach");
		} else {
			ctx.emit("api-session/removed", sessionId);
			steps.push("detach-skipped: not live; announced removal");
		}
	}

	// 3. Drop the registry membership so no archived/pinned ghost survives.
	//
	// `workspace.sessionIds` is a *filtered* view: it keeps only ids whose
	// in-process path memory still matches the workspace path, so an id the
	// host never opened (or already forgot) reads as absent even while it sits
	// in the durable record. `detachSession` is idempotent and `mutate`
	// re-filters the array, so calling it unconditionally is safe. The raw
	// `record.sessionIds` decides whether to report the step, because the
	// filtered getter would report "absent" for exactly the ghosts we target.
	if (registry !== void 0) {
		for (const workspace of registry.list()) {
			try {
				const before = workspace.record?.sessionIds?.length;
				await workspace.detachSession(sessionId);
				const after = workspace.record?.sessionIds?.length;
				if (before === void 0 || after === void 0 || after !== before) steps.push("detach-membership");
			} catch (error) {
				steps.push(
					`detach-membership-failed: ${error instanceof Error ? error.message : String(error)}`
				);
			}
		}
		try {
			await registry.unarchiveSession(sessionId);
		} catch {
			// Absent ids are not an error here.
		}
		try {
			await registry.unpinSession(sessionId);
		} catch {
			// Absent ids are not an error here.
		}
	}

	// 4. Remove the artifact directory. The dispose-triggered writer close is
	//    asynchronous, so give the handle a moment to be released.
	if (directory !== void 0) {
		if (await removeWithRetry(directory)) removed.push(directory);
		else steps.push("artifact-locked");
	}

	// 5. Remove the projection-cache record (identity-keyed, so it would
	//    otherwise be reused only after a same-id rebuild).
	const cache = join(dshHome(), "storages", "session_projcache", "sessions", `${sessionId}.json`);
	if (existsSync(cache)) {
		if (await removeWithRetry(cache)) removed.push(cache);
		else steps.push("cache-locked");
	}

	return { sessionId, steps, removed };
}

/**
 * Register the deletion route on the web server.
 * @param ctx - the plugin context, which provides `webServer`.
 */
export function apply(ctx) {
	ctx.effect(() => {
		// Evict routes left behind by earlier generations. The table is keyed by
		// path, and `register` throws on a duplicate, so this is the only way a
		// freshly imported generation can reclaim a path a dead one still holds.
		for (const table of [ctx.webServer.exact, ctx.webServer.prefixes]) {
			if (table === void 0 || typeof table.delete !== "function") continue;
			for (const stale of STALE_ROUTES) {
				try {
					table.delete(stale);
				} catch {
					// A table without this path is already the desired state.
				}
			}
		}
		const dispose = ctx.webServer.register({
			kind: "exact",
			path: ROUTE_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") {
					json(res, 405, { ok: false, generation: GENERATION, error: "method not allowed" });
					return;
				}
				try {
					const body = await readJson(req);
					const sessionId = body?.sessionId;
					if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
						json(res, 400, { ok: false, generation: GENERATION, error: "invalid sessionId" });
						return;
					}
					json(res, 200, {
						ok: true,
						generation: GENERATION,
						...(await deleteSession(ctx, sessionId))
					});
				} catch (error) {
					json(res, 500, {
						ok: false,
						generation: GENERATION,
						error: error instanceof Error ? error.message : String(error)
					});
				}
			}
		});
		return () => {
			try {
				dispose();
			} catch {
				// The route table may already be gone during teardown.
			}
		};
	}, "session-delete: route");
}