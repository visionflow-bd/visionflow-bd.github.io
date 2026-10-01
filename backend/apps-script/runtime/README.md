# VisionFlow runtime: local verification, not deployed

Build with `npm run build:backend`. Never edit generated `Code.gs` directly.
Run `npm run test:runtime` for the adapter and built-entrypoint tests, and
`npm run test:runtime:emulator` for real REST serialization and transactions in
the isolated `demo-visionflow-runtime` emulator. No real email is sent.

## Runtime contract

- `scheduledWorker` is async and awaits outbox completion before review work.
  Rejections propagate. Disabled/incomplete configuration performs no work.
  Public `doGet`/`doPost` wrappers delegate to the same tested worker functions;
  POST is always rejected, including requests containing an ID token.
- Firestore requests use absolute HTTPS URLs and inline owner OAuth. Single
  writes and transaction commits both carry preconditions in JSON `:commit`
  bodies. This avoids the emulator PATCH query parser losing updateTime.
- Plain ISO strings remain strings. Timestamp wrappers retain their wire value
  and expose seconds/nanoseconds/toMillis/toDate/toString. Reference, bytes,
  geopoint and unsafe-large integer wire values round-trip without coercion.
  Document metadata `_updateTime`/`_path` is not persisted; nested business
  properties and business `id` fields are preserved.
- Query `orderBy` accepts a field string, one `[field,direction]` pair, or multiple
  pairs. Exact pagination uses `startAfter: {values: [...]}` with Firestore wire
  values in order, including a `__name__` reference tie breaker. A scalar cursor
  is only appropriate when one unique ordered value suffices.
- Read-only/error transactions roll back. No automatic transaction retry occurs;
  the caller must re-read/revalidate on a future attempt. No ambiguous commit or
  mail send is retried inside the adapter.
- Default request allowance is 200 HTTP calls and 240 seconds per adapter run.
  Budget checks prevent new requests/mail attempts; one rollback cleanup may
  exceed that count. They cannot interrupt an already-blocking UrlFetchApp call
  or guarantee completion below Google's execution limit.
- All MailApp exceptions are uncertain, regardless of exception wording. They
  must result in reconciliation, not automated resend. Successful send means
  provider handoff, not verified inbox delivery. Invalid quota returns zero.

## Verification boundary

The Node VM executes the actual generated artifact, including the real review
worker and adapter against the local Firestore emulator. It is not Google's
Apps Script host, IAM verification, OAuth consent, trigger verification or
production mail delivery. Those remain unverified. The emulator does not prove
production index availability, quotas or contention behavior.

On 1 October 2026 the actual staging editor rejected the numeric literal
`30_000` (line 435 of the earlier build) despite successful Node parsing. The
worker now uses `30000`; the regenerated source and explicit-scope manifest
save successfully in the real editor. This is parser/save evidence, not a
successful host execution or permission grant. Keep the regression assertion
and do not reintroduce numeric separators into the generated Apps Script.

## Read-only owner check

`ownerReadinessCheck()` is an editor-only diagnostic, not a web endpoint. It
does not send mail, change records/properties, install triggers or enable the
worker. With valid `PROJECT_ID`, `ADMIN_UID` and `ACTIVATION_BOUNDARY` properties
it reads the recovery/settings documents and one document-name-ordered sample
from each of four core collections. It works with `ENABLED=false`.

Set `EXPECTED_SENDER` only to the intended execution owner's address. The check
compares it with `Session.getEffectiveUser().getEmail()` but returns no address,
token, document IDs/content or provider error messages. A missing/unavailable
identity is unknown, never success. The local manifest declares `userinfo.email`
for this check; any new live OAuth grant requires the owner's approval.

Authorization, quota and current-user trigger checks are diagnostic observations.
They do not prove inbox delivery, write IAM, trigger interval, other owners'
triggers, deployed-version/source matching or complete data migration. Every
report deliberately retains `productionReady:false` and named unverified gates.
Run only after backing up the existing script and reviewing the candidate in
an owner-authorized staging context; do not paste over production to run a check.

Google documents support for microtasks/async/await but not a macrotask event
loop, and blocking I/O in [Apps Script V8 limitations](https://developers.google.com/apps-script/guides/v8-runtime#asynchronous_limitations).
The build preserves async/await and awaits completion explicitly; do not infer
that an unawaited async function completes synchronously.
Firestore's [commit API](https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/commit)
provides atomic ordered writes and supports transaction identifiers.

Do not paste this bundle over the existing production Apps Script until the
complete deployed source is exported and compatibility is checked. Do not
enable flags, grant IAM, accept new OAuth scopes, create triggers or deploy from
these local test results alone. Trusted source binding/publication, atomic
portal outbox integration and bounded worker scheduling have local tests;
actual host configuration and coordinated live rollout remain unverified.
Review-state readiness remains disabled by default.
