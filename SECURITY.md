# Security Policy

## Scope

`dsh-session-delete` permanently deletes files under `$DSH_HOME` and is reachable over the DSH
Host's web server. Two classes of issue are in scope:

1. **Path escape** — anything that lets a caller delete a path outside the Session artifact
   directory it belongs to. The handler validates `sessionId` against
   `/^[A-Za-z0-9._:@-]{1,200}$/`, which excludes path separators; a bypass of that check is a
   vulnerability.
2. **Unauthorized deletion** — anything that lets a caller reach the route without the Host's own
   browser-access decision being applied. The plugin relies entirely on the web server's access
   policy and adds no authentication of its own; a way to bypass that policy through this route is
   a vulnerability.

Out of scope:

- Anyone with access to the DSH profile or `$DSH_HOME` deleting Sessions directly on disk.
- A user confirming the dialog and deleting a Session they did not mean to delete. Deletion is
  permanent by design and the dialog is the only guard.
- Denial of service through repeated legitimate requests.

## Reporting

Open a [private security advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository, or contact the maintainer directly. Please do not open a public issue for a
suspected vulnerability.

Include the DSH version, OS, and a minimal reproduction. A proof of concept that demonstrates a
path escape is the most useful thing you can send.

## Expectations

This is a small, AI-generated, single-maintainer project. There is no response-time commitment. Fixes
are released as patches to `main`; there are no backports, because there are no maintained release
branches.

## Supported versions

Only the latest commit on `main` is supported.