// Approval + delivery-verification state (pure, browser and Node safe).
//
// Policy (owner decision, 28 Sep 2026): every client approval request has a
// fixed 72-hour review window that starts when the administrator publishes it.
// - Explicit confirm      -> "confirmed"
// - Explicit rejection    -> "rejection-pending" (admin decides) / "rejected"
// - No response by 72h    -> "deemed" (deemed accepted, shown separately from an
//                            explicit confirmation so the record stays honest)
// A deemed acceptance never writes a record from the browser. It is derived
// from the administrator-published createdAt and the absence of a client
// response, so every viewer (client, admin, report) derives the same outcome.
export const REVIEW_WINDOW_HOURS = 72;
export const REVIEW_WINDOW_MS = REVIEW_WINDOW_HOURS * 3600000;

const ms = value => {
  if (!value) return NaN;
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (Number.isInteger(value?.seconds)) return value.seconds * 1000 + (value.nanoseconds || 0) / 1e6;
  return typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : NaN;
};

export function approvalDeadline(approval) {
  const start = ms(approval?.createdAt);
  return Number.isFinite(start) ? start + REVIEW_WINDOW_MS : null;
}

export function approvalState(approval, response, now = Date.now()) {
  const deadline = approvalDeadline(approval);
  // Admin dismissed the client's rejection: the item is closed for good. Its
  // timer never restarts; any later change is published as a new approval.
  if (approval?.closure === 'dismissed') return { state: 'dismissed', deadline, response, closedAt: approval.closedAt };
  if (response) {
    if (response.kind === 'rejected') return { state: 'rejected', deadline, response };
    if (response.kind === 'rejection-pending') return { state: 'rejection-pending', deadline, response };
    return { state: 'confirmed', deadline, response };
  }
  if (deadline === null) return { state: 'pending', deadline: null };
  if (now >= deadline) return { state: 'deemed', deadline };
  return { state: 'pending', deadline };
}

export const isAccepted = view => view?.state === 'confirmed' || view?.state === 'deemed';

export function countdownParts(deadline, now = Date.now()) {
  if (!Number.isFinite(deadline) || now >= deadline) return null;
  const total = Math.ceil((deadline - now) / 1000);
  return { hours: Math.floor(total / 3600), minutes: Math.floor((total % 3600) / 60), seconds: total % 60 };
}

// Stable, non-reversible fingerprint of a private delivery link. The raw link
// must never be copied into approval records (they are published to clients).
export function linkFingerprint(value) {
  const input = String(value || '');
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
  }
  return input ? `f${h1.toString(16)}${h2.toString(16)}` : '';
}

const legacyDeliveryNumber = approval => {
  const match = /^\s*Deliverable\s+(\d+)\b/i.exec(String(approval?.title || ''));
  return match ? Number(match[1]) : null;
};

export function deliveryApprovalFor(project, number) {
  const n = Number(number);
  const rows = project?.approvals || [];
  return rows.find(a => a.kind === 'delivery' && Number(a.itemNumber) === n)
    || rows.filter(a => a.kind !== 'delivery' && a.itemNumber === undefined && legacyDeliveryNumber(a) === n).at(-1)
    || null;
}

const safeLink = value => { try { const u = new URL(String(value || '')); return ['https:', 'http:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };

// Admin-side, runs inside the save transaction input. Every delivered item gets
// exactly one delivery verification request. A changed delivery link restarts
// that item's 72-hour window and returns the approval id whose old client
// response must be cleared (so a rejected file cannot unlock its replacement).
export function ensureDeliveryApprovals(client, nowIso = new Date().toISOString()) {
  const restarted = [];
  for (const [key, project] of Object.entries(client?.projects || {})) {
    if (!project || project.deleted) continue;
    project.approvals ||= [];
    for (const item of (project.items || []).filter(i => !i.deleted)) {
      const link = safeLink(item.dl);
      if (!link) continue;
      const n = Number(item.n);
      const fingerprint = linkFingerprint(link);
      const title = `Deliverable ${n}${item.t ? ` · ${String(item.t).slice(0, 150)}` : ''}`;
      let approval = deliveryApprovalFor(project, n);
      if (!approval) {
        approval = { id: `delivery-${key}-${n}`.slice(0, 180), kind: 'delivery', itemNumber: n, title,
          desc: 'Please review this delivered file. Confirm it to unlock the final download, or reject it with a clear reason so we can revise it.',
          createdAt: nowIso, deliveryRef: fingerprint };
        if (project.approvals.some(a => a.id === approval.id)) approval.id = `${approval.id}-${fingerprint.slice(1, 9)}`;
        project.approvals.push(approval);
        continue;
      }
      // Adopt a legacy "Deliverable N — Delivered" request without changing its id,
      // so an existing client confirmation remains valid evidence.
      if (approval.kind !== 'delivery') { approval.kind = 'delivery'; approval.itemNumber = n; }
      if (!approval.deliveryRef) { approval.deliveryRef = fingerprint; continue; }
      if (approval.deliveryRef !== fingerprint) {
        approval.deliveryRef = fingerprint;
        approval.title = title;
        approval.createdAt = nowIso;
        approval.updatedAt = nowIso;
        delete approval.closure; delete approval.closedAt; delete approval.closeReason;
        restarted.push(approval.id);
      }
    }
  }
  return restarted;
}

export function downloadDecision(project, item, responseFor, now = Date.now()) {
  if (!item?.hasDelivery) return { allowed: false, reason: 'unavailable' };
  const approval = deliveryApprovalFor(project, item.n);
  // Published before delivery verification existed: keep the agreement gate only.
  if (!approval) return { allowed: true, reason: 'legacy', view: null, approval: null };
  const view = approvalState(approval, responseFor(approval), now);
  // A dismissed delivery stands as final, so its download is released.
  return { allowed: isAccepted(view) || view.state === 'dismissed', reason: view.state, view, approval };
}
