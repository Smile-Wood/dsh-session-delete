#!/usr/bin/env node
/**
 * One-command installer for dsh-session-delete.
 *
 *   node install.mjs              install or update
 *   node install.mjs --dry-run    print the plan, write nothing
 *   node install.mjs --uninstall  remove the mount and the staged copy
 *
 * What it does:
 *
 *   1. Stages `host.js`, `client.js` and a generated `package.json` under
 *      `$DSH_HOME/plugins/dsh-session-delete/rev-<content-hash>/`.
 *   2. Writes a managed block into `$DSH_HOME/cordis.patch.yml` pointing at the
 *      staged `host.js`. DSH's HMR watches that file, so the plugin mounts
 *      immediately and survives restarts.
 *
 * Why it stages a copy instead of pointing at this checkout: Node's ESM registry
 * caches modules by resolved URL and the DSH Loader has no invalidation hook. A
 * mount that always names the same file therefore keeps running the *old* Host
 * code after an edit or a `git pull`. Naming the staged directory after a hash
 * of its contents gives every revision a new URL, so `git pull && node
 * install.mjs` genuinely reloads the Host half in a running DSH. Staging also
 * means the install survives moving or deleting this checkout.
 *
 * Only Node 22+ is required; there are no dependencies.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Directory holding this installer, and therefore the plugin sources. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** Loader row id. Namespaced so it cannot collide with a shipped row. */
const ROW_ID = "dsh-session-delete";

/** Markers delimiting the region of the patch file this installer owns. */
const BEGIN = "# >>> dsh-session-delete managed block >>>";
const END = "# <<< dsh-session-delete managed block <<<";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const uninstall = argv.includes("--uninstall");
const unknown = argv.filter((a) => a !== "--dry-run" && a !== "--uninstall");
if (unknown.length > 0) {
  fail(`unknown option(s): ${unknown.join(" ")}\nusage: node install.mjs [--dry-run | --uninstall]`);
}
if (dryRun && uninstall) fail("--dry-run and --uninstall cannot be combined");

/** Print an error and exit non-zero. */
function fail(message) {
  console.error(`install.mjs: ${message}`);
  process.exit(1);
}

/** Resolve `$DSH_HOME` the way the Host does. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : join(homedir(), ".dsh");
}

/**
 * Quote a filesystem path as a YAML single-quoted scalar.
 *
 * Backslashes are rewritten to forward slashes: they are literal inside single
 * quotes either way, and forward slashes keep the generated block readable on
 * Windows. A literal `'` is escaped by doubling it.
 */
function yamlQuote(value) {
  return `'${value.replace(/\\/g, "/").replace(/'/g, "''")}'`;
}

/** Render the managed block for one staged host path. */
function renderBlock(hostPath) {
  return (
    [
      BEGIN,
      "# Written by install.mjs; reinstalling rewrites this block and",
      "# `node install.mjs --uninstall` removes it.",
      "#",
      "# The name is an absolute path, which the Loader rewrites to a file:// URL.",
      "# The revision directory in that path is content-addressed on purpose: a",
      "# changed host.js lands on a new URL, which is the only way a running DSH",
      "# picks up new Host code.",
      "- insert:",
      `    - id: ${ROW_ID}`,
      `      name: ${yamlQuote(hostPath)}`,
      END,
    ].join("\n") + "\n"
  );
}

/** Read a text file, returning "" when it does not exist. */
function readTextIfPresent(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Normalize line endings and guarantee exactly one trailing newline. */
function normalize(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n*$/, "\n");
}

/** Insert or replace the managed block in a patch file's text. */
function upsertBlock(text, block) {
  const lines = text.length === 0 ? [] : normalize(text).split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const start = lines.indexOf(BEGIN);
  const end = lines.indexOf(END);
  const blockLines = block.replace(/\n$/, "").split("\n");
  if (start !== -1 && end > start) {
    lines.splice(start, end - start + 1, ...blockLines);
  } else {
    if (lines.length > 0) lines.push("");
    lines.push(...blockLines);
  }
  return normalize(lines.join("\n"));
}

/** Remove the managed block, reporting whether anything was removed. */
function stripBlock(text) {
  const lines = normalize(text).split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const start = lines.indexOf(BEGIN);
  const end = lines.indexOf(END);
  if (start === -1 || end <= start) return { text: normalize(text), removed: false };
  lines.splice(start, end - start + 1);
  return { text: normalize(lines.join("\n")), removed: true };
}

/**
 * Assert that `client.js` registers under the package name.
 *
 * client-modules derives the browser bundle's id from the resolved package's
 * `name`, then rejects a bundle that registers under anything else. The only
 * symptom is a silently missing menu row, so it is worth catching here.
 */
function assertClientId(source, packageName) {
  const match = /__ModuleLoader__\.load\(\{\s*id:\s*["']([^"']+)["']/.exec(source);
  if (match === null) {
    fail(
      "client.js does not start with window.__ModuleLoader__.load({ id, factory }); " +
        "the browser half would never register."
    );
  }
  if (match[1] !== packageName) {
    fail(
      `client.js registers as "${match[1]}" but package.json name is "${packageName}".\n` +
        "client-modules matches the bundle id to the resolved package name, so this\n" +
        "mismatch would leave the menu row missing. Make the two strings identical."
    );
  }
}

// ---------------------------------------------------------------- read sources

const hostPath = join(HERE, "host.js");
const clientPath = join(HERE, "client.js");
const manifestPath = join(HERE, "package.json");
for (const required of [hostPath, clientPath, manifestPath]) {
  if (!existsSync(required)) fail(`missing source file: ${required}`);
}

const hostSource = readFileSync(hostPath, "utf8");
const clientSource = readFileSync(clientPath, "utf8");
const manifestSource = readFileSync(manifestPath, "utf8");

let manifest;
try {
  manifest = JSON.parse(manifestSource);
} catch (error) {
  fail(`package.json is not valid JSON: ${error.message}`);
}
if (typeof manifest.name !== "string" || manifest.name.length === 0) {
  fail("package.json has no name");
}
assertClientId(clientSource, manifest.name);

const clientDeclaration = manifest.dsh?.client;
if (clientDeclaration === undefined || clientDeclaration.platform !== "web") {
  fail("package.json must declare dsh.client.platform = \"web\"");
}

// ---------------------------------------------------------------- plan

const home = dshHome();
const patchPath = join(home, "cordis.patch.yml");
const stageRoot = join(home, "plugins", manifest.name);
const revision = createHash("sha256")
  .update(hostSource)
  .update("\0")
  .update(clientSource)
  .update("\0")
  .update(manifestSource)
  .digest("hex")
  .slice(0, 8);
const revisionDir = join(stageRoot, `rev-${revision}`);
const stagedHost = join(revisionDir, "host.js");

if (uninstall) {
  const existing = readTextIfPresent(patchPath);
  const { text, removed } = stripBlock(existing);
  // Leave no empty file behind when this block was the patch file's only
  // content; an existing file with other rows keeps its remaining text.
  const emptied = removed && text.trim().length === 0;
  if (!dryRun && removed) {
    if (emptied) rmSync(patchPath, { force: true });
    else writeFileSync(patchPath, text, "utf8");
  }
  const hadStage = existsSync(stageRoot);
  if (!dryRun && hadStage) rmSync(stageRoot, { recursive: true, force: true });
  console.log(`dsh-session-delete: uninstalled`);
  const patchNote = removed ? (emptied ? "(mount removed; empty file deleted)" : "(mount removed)") : "(no mount found)";
  console.log(`  patch file   ${patchPath} ${patchNote}`);
  console.log(`  staged copy  ${stageRoot} ${hadStage ? "(removed)" : "(absent)"}`);
  console.log("");
  console.log("DSH unmounts the plugin as soon as it reloads the patch file.");
  if (dryRun) console.log("(--dry-run: nothing was written)");
  process.exit(0);
}

/** The staged package.json: same client declaration, host entry next to it. */
const stagedManifest = {
  name: manifest.name,
  version: manifest.version ?? "1.0.0",
  private: true,
  type: "module",
  description: manifest.description,
  license: manifest.license,
  exports: {
    ".": "./host.js",
    "./client": "./client.js",
    "./package.json": "./package.json",
  },
  dsh: { client: clientDeclaration },
};

const block = renderBlock(stagedHost);
const nextPatch = upsertBlock(readTextIfPresent(patchPath), block);

console.log(`dsh-session-delete: ${dryRun ? "dry run" : "installing"}`);
console.log(`  dsh home     ${home}`);
console.log(`  revision     ${revision}`);
console.log(`  staged copy  ${revisionDir}`);
console.log(`  patch file   ${patchPath}`);
console.log("");
console.log("Managed block written to the patch file:");
console.log("");
console.log(block.replace(/^/gm, "  "));

if (dryRun) {
  console.log("(--dry-run: nothing was written)");
  process.exit(0);
}

// ---------------------------------------------------------------- apply

mkdirSync(revisionDir, { recursive: true });
writeFileSync(join(revisionDir, "host.js"), hostSource, "utf8");
writeFileSync(join(revisionDir, "client.js"), clientSource, "utf8");
writeFileSync(join(revisionDir, "package.json"), `${JSON.stringify(stagedManifest, null, 2)}\n`, "utf8");

// Drop superseded revisions. The Loader may still hold one until it recomposes,
// which is harmless: the patch file now names only the current revision.
for (const entry of readdirSync(stageRoot)) {
  if (entry.startsWith("rev-") && entry !== `rev-${revision}`) {
    rmSync(join(stageRoot, entry), { recursive: true, force: true });
  }
}

writeFileSync(patchPath, nextPatch, "utf8");

console.log("Installed.");
console.log("");
console.log("Next:");
console.log("  1. DSH watches the patch file, so the Host half is live already.");
console.log("  2. Reload the DSH page in your browser to pick up the menu row.");
console.log("  3. Open a Session's \"...\" menu in the sidebar; \"Delete Session\" is last.");