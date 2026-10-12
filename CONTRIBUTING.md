# Bug reports and pull requests are welcome.

This plugin reaches into DSH internals that are not public API, so the most useful report includes
the DSH version you are running and the exact step that failed.

## Before opening an issue

- Check [Limitations](../README.md#limitations) in the README. Several failure modes are known and
  documented, including the one where a DSH upgrade changes the on-disk layout.
- If the menu item does not appear at all, confirm the browser bundle reached the client-module
  graph — a plugin can be active on the Host while its browser half is missing.
- If a code change to `host.js` appears to do nothing, read
  [Host reload semantics](../README.md#host-reload-semantics-read-this-before-editing-hostjs).
  Editing a mounted Host file in place is *expected* to have no effect.

## A good bug report

Include:

1. DSH version and OS.
2. How you mounted the plugin (checkout patch file, or profile bundle).
3. The `POST /plugins/session-delete/delete` response body, verbatim. The `steps` array names
   exactly which of the five steps ran, was skipped, or failed, and `generation` names the Host
   module that answered.
4. What you expected to happen on disk, and what actually happened.

Please redact Session ids and local paths if you would rather not publish them — but keep the shape
of the `steps` array intact, since that is the diagnostic.

## Pull requests

- Keep the five-step sequence in `host.js` legible. The comments explaining *why* each seam is used
  are the most valuable part of this file; if you change a seam, update the comment.
- If you add a Host generation (a new filename), extend `STALE_ROUTES` in the same commit.
- Run `npm run check` before opening the PR.
- This project is AI-generated. If your contribution is also AI-generated, say so in the PR
  description.

## Security

This plugin deletes files permanently and is reachable over the Host's web server. Please report
anything that would let a caller delete a path outside the intended Session artifact directory as a
security issue rather than a normal bug.