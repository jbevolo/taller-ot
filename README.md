# Taller OT

Static workshop work-order PWA with Supabase Auth, database persistence, photo Storage, customer links, printing, and JSON backup/restore. Serve this directory over HTTPS (or localhost for development); there is no build step or runtime dependency installation.

**Before deploying this version, follow [the database deployment checklist](database/README.md).** Restore and photo updates require the reviewed RPC migration. If it is absent, those operations fail safely rather than deleting or overwriting data from the browser.

## Local verification

Use Node.js 20+:

```sh
node --test tests/app.test.mjs tests/sw.test.mjs
node --test tests/database.test.mjs
git diff --check
```

The browser tests execute the real inline application and service worker with DOM/network doubles. They do not contact Supabase or prove real-browser layout, camera compatibility, or script execution. The database test uses installed `initdb`, `pg_ctl`, and `psql` to create a private disposable PostgreSQL cluster, with TCP disabled. It ignores database connection environment variables, stops the cluster, and removes its temporary directory afterward. If PostgreSQL tools are missing, that test is explicitly skipped; install them separately before claiming backend verification. No packages are installed by the tests.

Run all tests with `node --test tests/*.test.mjs`. Database fixtures test supported photo column types and security boundaries; they are not a substitute for checking the actual deployed schema/RLS.

## Operational notes

- User-entered text is escaped or rendered as text. Photo handlers are DOM callbacks rather than generated JavaScript.
- Signing out or changing accounts clears orders, drafts, photos, and modal content; stale responses cannot repopulate the next account.
- Backups preserve UUID share links. Photo files require a separate Storage backup.
- The service worker revalidates the public shell and falls back to cached assets offline. It never caches backend requests. Orders and writes still require a working connection; there is no offline order queue.
- Save drafts and close all old tabs/PWA windows when deploying the new worker. It deliberately does not force an update over unsaved work.

## Reviewable work units

No commits are required to verify this working tree. If changes are later organized into commits, keep each behavior with its tests and deployment notes:

1. Transactional restore/share IDs and concurrent photo RPCs: `database/`, the corresponding `index.html` handlers, and database/application tests.
2. Safe rendering, account isolation, and camera/upload handling: the corresponding `index.html` changes and application regression tests. These fixes can remain if RPC features are disabled.
3. Shell update/offline fallback: `sw.js` and `tests/sw.test.mjs`; independent of database deployment.

This is a multi-unit security/data-integrity change larger than a small single review slice. Do not remove tests or compress source to conceal its size.
