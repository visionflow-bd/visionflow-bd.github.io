# Main-site media workflow

`media.js` is the testable transport/queue layer; `uploads.js` integrates it with
the existing administrator editor. `index.html` retains the site's design and
loads both files before initialization. No provider secret belongs in these
public browser assets.

## Owner workflow

Configure image and video Cloudinary accounts separately in the Cloud Storage
admin section. Only explicitly active accounts are used, in configured order;
duplicate cloud/preset pairs are removed. A failed account-settings save restores
the prior in-memory configuration and does not report success.

Upload one file inside an editor, or select up to 20 files in a portfolio batch.
Two requests run concurrently. Queued files can be cancelled without sending;
active cancellation may leave an asset at the provider. Progress includes speed
and an estimated remaining time. Reaching 100% bytes is still processing until
the provider returns and its response is validated.

Uploads continue while changing admin sections or closing an editor, not after
closing the page. Firebase administrator auth loss aborts active requests, removes
waiting requests and hides draft controls. Browser auth guards are usability
checks, not Cloudinary's server-side authorization boundary.

Every completed upload becomes an unpublished draft with Open file, Copy URL,
Create portfolio entry and Dismiss actions. Draft metadata is cached locally;
file bytes are not. A cache failure leaves the in-memory draft and a persistent
copy-before-leaving warning. Dismiss only forgets the draft; it does not delete
the cloud asset. Restored drafts do not establish publication or cloud existence.

Create portfolio entry uses a filename-derived title, **not AI-generated copy**.
Review category/title/description, then save. An inline completion never overwrites
a newer editor or manually changed URL. Save waits for inline uploads, freezes
the submitted form during persistence and restores authoritative cloud state after
a failed write. Drafts are consumed only after a successful save using their URL.

## Provider and security boundaries

- Local limits are 20 MB for JPG/PNG/WEBP/GIF and 500 MB for MP4/MOV/WEBM. These
  are client bounds, not verified Cloudinary plan or unsigned-preset capacity.
  Large uploads remain unverified; no resumable/chunked-upload guarantee exists.
- Fallback only follows HTTP 420/429 or a narrowly recognized quota rejection.
  File-size errors, timeouts, network failures, malformed success responses and
  other ambiguous outcomes never automatically retry another account. Inspect
  the media library before retrying an uncertain result.
- Response URLs require HTTPS, the exact Cloudinary host, expected account and
  expected resource type. Cloud/preset values cannot redirect uploads elsewhere.
- Unsigned preset names are inherently visible to visitors. The browser's admin
  check cannot prevent an outside caller from abusing a known unsigned preset.
  Verify provider-side limits, allowed formats, overwrite policy and monitoring;
  a trusted signed-upload backend is needed for authenticated upload enforcement.
- Public video metadata is not eagerly loaded; YouTube embeds load on click.
  Images/video use proportional presentation and generated posters use `c_limit`
  instead of cropping portrait frames.

## Cloud save safety

`store.js` performs a three-way merge inside an actual Firestore transaction:
the editor's original baseline, its submitted changes, and the latest server
record. Independent field changes merge; competing changes to the same field or
list fail visibly. Lists are atomic: reopen after a conflict to review the latest
version. Browser timestamps never decide which snapshot wins.

`persistence.js` requires a server-confirmed snapshot and never seeds a missing
document or auto-publishes cache migrations. Private leads/notification config
are excluded. Failed saves do not report success or silently trim large images.
Submitted forms are locked until completion; dynamic contact/stat drafts remain
available for retry. Moving to a different section discards that section's
unsubmitted changes rather than publishing them through an unrelated save.
The administrator UI uses the same fixed UID/email as the Firestore Rules;
the Rules remain the actual authorization boundary.

## Verification commands

`npm run test:site` tests the merge and transport/queue layers. Set `VF_BROWSER_MODULES`
to an installed node_modules directory containing Playwright if it is not a
local dependency, then run `npm run test:site:browser` (installed Edge required).
`VF_BROWSER_SCREENSHOTS` optionally selects a screenshot output directory.

The browser test uses the actual page with synthetic Auth/Firestore and mocked
Cloudinary; every other nonlocal request is blocked. It covers persistence failure,
save locking, detached editors, batch concurrency, cancellation, auth loss, cache
failure/reload, filename HTML injection, mobile controls and uncropped lazy media.
It is not a real provider upload, quota, live permission or publication test.

`npm run test:site:emulator` checks two concurrent SDK transactions against the
local Firestore emulator and the repository's Rules: independent edits survive,
competing list edits conflict, non-owner writes and recovery-locked saves fail.
Run it sequentially with the other emulator suites sharing port 8088.
