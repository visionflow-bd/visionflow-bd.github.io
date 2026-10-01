// HISTORICAL AGY DRAFT — NOT AN IMPLEMENTABLE OR APPROVED CONTRACT.
// Codex review found invalid slash-delimited IDs, contradictory admin-only
// outbox/client consent enqueue, non-atomic examples and an undefined rules
// helper. Do NOT copy these examples into portal code or security rules.
// Current executable worker tests supersede behavior claims below. Review
// settlement additionally requires shared reviews/{id} state and atomic
// objection/decision writes; reviewStateReady MUST remain false until integrated.
// This draft is retained as evidence, not as deployment instructions.
// Firestore Integration Contract for Portal/Rules
// This file documents the EXACT collections, fields and rules
// that the portal and Firestore rules must implement for the
// trusted backend outbox worker to function.
//
// The backend reads from these collections; the portal writes to them.
// Codex integrates these into portal/* and firestore.rules separately.

/**
 * ═══════════════════════════════════════════════════
 *  PORTAL → BACKEND OUTBOX CONTRACT
 * ═══════════════════════════════════════════════════
 *
 * When the portal performs a state-changing write that should trigger
 * a notification, it MUST atomically create an outbox document.
 *
 * Collection: portal_outbox/{stableId}
 *
 * Fields:
 *   id:                  string  — stable dedup key: "{eventType}/{clientSlug}/{sourceId}/{sourceVersion}"
 *   eventType:           string  — one of EVENT_TYPES (see worker.mjs)
 *   sourceCollection:    string  — Firestore collection of the source record
 *   sourceId:            string  — document ID of the source record
 *   clientSlug:          string  — client identifier (maps to portal_clients/{slug})
 *   projectKey:          string? — project key within the client, if applicable
 *   sourceVersion:       string? — version of the source record at enqueue time
 *   masterVersion:       string? — master agreement version, if applicable
 *   status:              string  — always "queued" at creation
 *   createdAt:           string  — ISO timestamp from server clock
 *   activationBoundary:  string  — ISO timestamp; events before this are skipped
 *
 * Firestore Rules:
 *   - Admin can create (status == 'queued') and read
 *   - Client browser CANNOT write to portal_outbox
 *   - Backend worker (via service account or owner token) can update status
 *
 * Example rule (Codex to integrate):
 *   match /portal_outbox/{eventId} {
 *     allow read: if isAdmin();
 *     allow create: if isAdmin() && request.resource.data.status == 'queued';
 *     allow update: if false; // Only server/trigger can update
 *   }
 */

/**
 * ═══════════════════════════════════════════════════
 *  BACKEND EVENT LOG (deduplication)
 * ═══════════════════════════════════════════════════
 *
 * Collection: portal_backend_events/{stableId}
 *
 * Fields:
 *   status:     string  — "sent" (terminal for dedup)
 *   eventType:  string
 *   clientSlug: string
 *   projectKey: string?
 *   sentAt:     string  — ISO timestamp
 *
 * Firestore Rules:
 *   - Only backend worker can read/write
 *   - NOT accessible from client browsers
 */

/**
 * ═══════════════════════════════════════════════════
 *  REVIEW REQUEST CONTRACT
 * ═══════════════════════════════════════════════════
 *
 * Collection: portal_reviews/{reviewId}
 *
 * Created by: Admin portal (when publishing a review request)
 *
 * Fields:
 *   id:                  string  — unique review ID
 *   schemaVersion:       number  — must be 1
 *   policyVersion:       string  — must be REVIEW_POLICY.version ('VF-REVIEW-72H-v1')
 *   reviewHours:         number  — must be 72
 *   projectKey:          string  — which project
 *   sourceVersion:       string  — version of the source being reviewed
 *   masterVersion:       string  — required master agreement version
 *   publishedAt:         string  — ISO timestamp (server-authoritative publication time)
 *   portalToken:         string  — portal_public token for context lookup
 *   clientSlug:          string  — client identifier
 *   status:              string  — 'pending', 'blocked', 'deemed-accepted', 'client-confirmed', 'objected'
 *   notificationSent:    boolean — true when email was handed to provider
 *   portalNoticeShown:   boolean — true when portal displays the notice
 *   cancelledAt:         string? — if admin cancels the review
 *
 * The backend worker reads this collection to find pending reviews
 * and uses assessReview() from review-engine.mjs to determine outcomes.
 *
 * IMPORTANT: publishedAt is set at actual publication time.
 * A delayed or failed notification does NOT consume a hidden window.
 * An unsent request is NOT pending client review (notificationReady must be true).
 */

/**
 * ═══════════════════════════════════════════════════
 *  STATUS DISPLAY CONTRACT
 * ═══════════════════════════════════════════════════
 *
 * The portal should display review status to clients by reading:
 *   portal_reviews/{reviewId}.status
 *   portal_reviews/{reviewId}.publishedAt (to show deadline countdown)
 *
 * Computed deadline = publishedAt + 72 hours
 *
 * Display states:
 *   pending         → "Under review — X hours remaining"
 *   blocked         → "Review paused — action required"
 *   client-confirmed → "Confirmed by client"
 *   objected        → "Objection recorded"
 *   deemed-accepted → "Review period completed — deemed accepted"
 *   cancelled       → "Review cancelled"
 *
 * The portal NEVER writes deemed-accepted. Only the trusted server does.
 */

export const FIRESTORE_CONTRACT_VERSION = '1.0.0';
