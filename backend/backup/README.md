# VisionFlow recovery tools

These are owner-operated recovery tools, not an automatic public restore API.
No production restore or maintenance lock has been executed during development.

## Scope

`export` uses one server `readTime` and paginated recursive collection discovery,
including missing parent documents. It preserves the raw Firestore wire types,
all token generations, file bodies stored in Firestore, unknown collections,
website/leads, settings, archives, outbox, review and backend state. A failed page
aborts the export; incomplete results are never labelled a valid backup.

The SHA-256 digest detects accidental changes, not malicious re-signing or the
identity of the person who created a backup. Backups/plans/journals contain
private client links, signatures and documents: keep them outside the public
repository, restrict filesystem access and use encrypted offline storage.
Writes use exclusive-create plus fsync, never silently overwrite an old file.

This is a complete **Firestore data** backup, not a complete infrastructure or
media backup. Firebase Auth, rules/indexes, Apps Script source/properties/triggers,
IAM, repository source and external Drive/Cloudinary file bodies are explicitly
listed as exclusions. Capture and verify those separately before a rollout.
The portal's legacy client-archive export is not this full database snapshot.

## Non-mutating commands

Run from the repository. Paths below are placeholders, not existing evidence.
An existing Firebase CLI login can be used explicitly; no login/account switch
is performed. Alternatively provide `VF_FIRESTORE_ACCESS_TOKEN` privately.
Credentials/provider response bodies are never logged.

```powershell
node backend/backup/cli.mjs export --project visionflow-bd --out D:\Recovery\NEW-snapshot.json --firebase-cli
node backend/backup/cli.mjs inspect --input D:\Recovery\NEW-snapshot.json
node backend/backup/cli.mjs plan --input D:\Recovery\SOURCE.json --current D:\Recovery\CURRENT.json --out D:\Recovery\NEW-plan.json
```

Planning has no external writes. Review the plan privately. Differing existing
business documents produce conflicts by default. `--replacements PATHS.json`
accepts an explicit array of database-relative document paths after review;
immutable signatures/consent/acknowledgements/feedback/files/archive/dedup evidence
cannot be overwritten through that option. Current-only documents are retained.
Existing queue outcomes/dedup records/recipient settings win over older backups.
Legacy public snapshots are regenerated using the secure migration planner;
original private financial values and wire types are retained. Interrupted
legacy recovery jobs require a separate reviewed migration, not a forced import.
Admin concurrency revisions and review epochs advance beyond both backup and
current values. Current-only links belonging to restored clients are also paused;
cross-client token collisions block planning. Resuming a recovered workspace
must not reactivate an old unattended review window or an obsolete shared link.

## Required maintenance gate before any apply or rollback

1. Verify that deployed rules include `recoveryLocked` for client access and
   administrator writes, and the deployed worker checks recovery before claims,
   final send authorization and review settlement. Suspend any legacy worker or
   other IAM writer that bypasses these gates. Merely editing source or setting
   a `gatesVerified` Boolean is not evidence that a deployment is protected.
2. Preserve a fresh full snapshot and deployed rules/indexes/runtime artifacts.
   Using the IAM owner (not a browser Firebase ID token), create/update
   `portal_settings/recovery` with exact updateTime/exists precondition:
   `active: true`, a unique `operationId`, `gatesVerified: true`, and `startedAt`
   set by a server REQUEST_TIME transform. Only mark gates verified after step1.
   The tool deliberately does not auto-acquire/unlock a production lock.
3. Allow ten server-timed minutes for already-authorized worker executions to
   drain. Review every `sending`/`processing` outbox record; uncertain handoff
   requires reconciliation, not marking it queued. Recovery refuses these states.
4. Export CURRENT again after quiescence and rebuild/review the restore plan.
   Acquire an independent pre-recovery copy and keep all operation files.

```powershell
node backend/backup/cli.mjs apply --project visionflow-bd --plan D:\Recovery\NEW-plan.json --journal D:\Recovery\NEW-journal --operation EXACT_OPERATION_ID --firebase-cli --acknowledge-live-write
```

Apply preflights all targets, uses exact-version/exists CAS for every write,
retains a pre-commit journal, stores server receipts and compares restored fields.
Every batch also conditionally writes the unchanged lock in the same commit, so
an unlock racing the batch rejects the entire batch rather than exposing a
partially restored workspace.
It leaves sharing paused, notifications disabled and maintenance active. Old
pending review windows are cancelled, pending mail becomes manual reconciliation,
and backend cursor/lease state is retained only as backup evidence, not restored.

## Failures and rollback

Never rerun an ambiguous apply blindly. A prepared batch without a committed
receipt can mean the server applied it before the connection failed. Preserve
the journal and inspect server fields/updateTimes with an owner. The CLI refuses
automatic rollback for uncertain journals. Known successful receipts allow:

```powershell
node backend/backup/cli.mjs rollback --project visionflow-bd --plan D:\Recovery\NEW-plan.json --source-journal D:\Recovery\NEW-journal --journal D:\Recovery\NEW-rollback-journal --operation EXACT_OPERATION_ID --firebase-cli --acknowledge-live-write
```

Rollback restores the pre-operation fields only where exact committed versions
still match, and deletes only documents created by that operation. It never
deletes current-only documents. Newer writes block rollback instead of being
overwritten. A partial rollback or lost receipt requires journal reconciliation.
Keep maintenance enabled until source/data/rules/backend/site are coherent and
the admin/client/anonymous tests pass. Do not unlock/re-enable worker or sharing
automatically. Recheck old review windows and publish fresh notices as needed.

## Verification

- `npm run test:backup`: full-tree/raw-type/checksum/bounds/conflict/plan/CAS/
  journal-order/uncertain-outcome/rollback safety and REST constraints.
- `npm run test:backup:emulator`: real REST enumeration with missing parents,
  timestamp/integer/bytes/reference/geopoint preservation, paused restore and
  versioned rollback. This emulator's ListDocuments GET parser rejects readTime;
  a test-only localhost shim omits that parameter. It does NOT prove snapshot
  isolation; unit tests verify forwarding and actual read-only cloud export was
  exercised with the unchanged production adapter.
- Rules tests verify cached admin/client denial while recovery is active;
  backend tests verify the final pre-send and review-transaction race gates.
- No emulator test targets a non-demo project. Use port8088 sequentially.
