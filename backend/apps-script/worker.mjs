// VisionFlow Trusted Backend — Apps Script V8 Module
import {settleReviewTimers} from './review-worker.mjs';
import {resolveEventSource,notificationEventId} from './source-binding.mjs';
import {reviewTimestamp} from '../review-engine.mjs';
import {paymentMoney,paymentTotals} from '../../portal/payment-notification.js';
import {paymentDocument} from './payment-document.mjs';
// NOT DEPLOYED. Injectable adapters for Node.js testing.
// Reuses review-engine.mjs policy; does not weaken gates.

// ── Adapter contracts (injected at setup) ─────────────────────────
// firestore: { get(path), set(path, data, opts?), runTransaction(fn), query(collection, filters) }
// mail:      { send(message), remainingQuota() }
// clock:     { now() → ISO string, serverTimestamp() }
// config:    { projectId, adminUid, portalHost, activationBoundary }

/**
 * @fileoverview
 * Scheduled outbox worker for VisionFlow notification and review backend.
 *
 * Design decisions:
 * - doPost fails closed: no mail, no record mutation, no arbitrary recipients.
 * - doGet returns non-sensitive health only.
 * - All email recipients are server-resolved from private Firestore records.
 * - Outbox events have stable IDs for deduplication.
 * - Leases prevent concurrent worker overlap.
 * - Gmail send + Firestore commit are NOT atomic: crash-after-send
 *   produces 'sent-unconfirmed' status requiring reconciliation.
 * - 72-hour review window uses VF-REVIEW-72H-v1 policy exclusively.
 * - No retroactive deadlines for legacy records.
 * - Activation boundary prevents mass-mailing on first enable.
 */

// ── Constants ─────────────────────────────────────────────────────
const OUTBOX_COLLECTION = 'portal_outbox';
const BACKEND_EVENTS = 'portal_backend_events';
const SETTINGS_DOC = 'portal_settings/notifications';
const LEASE_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const MAX_EVENTS_PER_RUN = 20;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 30000;
const PORTAL_HOST = 'https://visionflow-bd.github.io';
const EMAIL_LOGO_URL = `${PORTAL_HOST}/logo.png`;

const EVENT_TYPES = Object.freeze([
  'consent-complete',
  'master-signed',
  'project-signed',
  'project-acknowledged',
  'project-notification',
  'payment-notification',
  'delivery-notification',
  'update-notification',
  'confirmation-received',
  'objection-received',
  'deemed-accepted',
  'review-window',
]);

// ── HTML Escaping ─────────────────────────────────────────────────
function esc(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ── doGet: non-sensitive health ───────────────────────────────────
export function doGet(_e, { config }) {
  return {
    ok: true,
    service: 'VisionFlow Backend v5.0',
    status: 'healthy',
    // No credentials, tokens, endpoints, or internal state
  };
}

// ── doPost: fails closed ──────────────────────────────────────────
export function doPost(e, { firestore, config }) {
  // doPost is NOT a mail relay. It only accepts authenticated
  // admin commands for specific safe operations.
  // Default: reject everything.
  try {
    const data = JSON.parse(e?.postData?.contents || '{}');

    // The only permitted operation is enqueueing a notification
    // with a verified Firebase admin ID token.
    if (data.action === 'enqueue' && data.idToken) {
      // ID token verification is deferred to verifyAdminToken()
      // which must be called before any mutation.
      return {
        ok: false,
        error: 'Direct enqueue via doPost is disabled in this version. ' +
               'Notifications are enqueued by Firestore rules-gated portal writes. ' +
               'The scheduled worker processes the outbox.',
      };
    }

    return { ok: false, error: 'Unauthorized. This endpoint does not relay mail.' };
  } catch {
    return { ok: false, error: 'Bad request.' };
  }
}

// ── Firebase ID Token Verification ────────────────────────────────
// Uses Google's public certificates endpoint (REST, no Admin SDK).
// In Apps Script: UrlFetchApp.fetch(CERTS_URL).
// In tests: injected mock.
export async function verifyAdminToken() {
  // No vetted cryptographic verifier is installed. This unused entry point
  // must reject everything; decoded claims are not proof of identity.
  return null;
}

// ── Outbox Event Schema ───────────────────────────────────────────
export function createOutboxEvent({
  eventType, sourceCollection, sourceId, clientSlug, projectKey,
  sourceVersion, masterVersion, activationBoundary, clock, portalToken, reviewEpoch=0,
}) {
  if (!EVENT_TYPES.includes(eventType)) {
    throw new Error(`Unknown event type: ${eventType}`);
  }
  const stableId = notificationEventId({eventType,clientSlug,sourceCollection,sourceId,sourceVersion,projectKey});
  if(stableId.length>1400)throw new Error('Event identity exceeds the bounded Firestore document ID size.');
  return {
    id: stableId,
    eventType,
    sourceCollection,
    sourceId,
    clientSlug,
    projectKey: projectKey || null,
    sourceVersion: sourceVersion || null,
    portalToken: portalToken || (sourceCollection?.startsWith('portal_public/')?sourceCollection.split('/')[1]:null),
    reviewEpoch,
    masterVersion: masterVersion || null,
    status: 'queued',
    createdAt: clock.now(),
    leasedBy: null,
    leasedUntil: null,
    retryCount: 0,
    lastError: null,
    sentAt: null,
    confirmedAt: null,
    activationBoundary,
  };
}

// ── Lease Acquisition (atomic) ────────────────────────────────────
function workerClientScope(config) {
  const value = typeof config?.clientScopeSlug === 'string' ? config.clientScopeSlug.trim() : '';
  return value || null;
}

function scopeCursor(base, scope) {
  return scope ? `${base}-${scope}` : base;
}

export async function claimEvents({ firestore, clock, workerId, limit = MAX_EVENTS_PER_RUN, config }) {
  if((await firestore.get('portal_settings/recovery'))?.active===true)return [];
  const now = clock.now();
  const nowMs = Date.parse(now);
  const scope = workerClientScope(config);

  // Sending is recovered only into reconciliation; terminal handoffs are never
  // candidates for another send even if their secondary dedup log is missing.
  //        (leasedUntil is null OR leasedUntil < now) AND
  //        retryCount < MAX_RETRIES
  const scan=scopeCursor('portal_backend_state/outbox-scan',scope),cursor=await firestore.get(scan);
  const cursorValid=typeof cursor?.lastId==='string'&&cursor.lastId.length>0&&cursor.lastId.length<=1400&&!cursor.lastId.includes('/');
  const options={orderBy:['__name__','asc'],limit:limit*2};
  const scopedWhere=scope ? {where:[['clientSlug','==',scope]]} : {};
  let candidates=await firestore.query(OUTBOX_COLLECTION,{...options,...scopedWhere,...(cursorValid?{startAfterId:cursor.lastId}:{})});
  if(!candidates.length&&cursorValid)candidates=await firestore.query(OUTBOX_COLLECTION,{...options,...scopedWhere});

  const claimed = [];
  let lastId=null;
  for (const event of candidates) {
    if (claimed.length >= limit) break;
    lastId=event.id;
    if(scope && event.clientSlug!==scope)continue;
    if(!['queued','retry','processing','sending','quota-exhausted','settings-paused'].includes(event.status)||event.retryCount>=MAX_RETRIES)continue;

    // Skip events with active leases
    if (event.leasedUntil && Date.parse(event.leasedUntil) > nowMs) continue;
    if(!event._updateTime)continue; // Never downgrade a CAS claim into a blind write.
    if(event.nextRetryAfter&&(!Number.isFinite(Date.parse(event.nextRetryAfter))||Date.parse(event.nextRetryAfter)>nowMs))continue;
    if(event.status==='sending'){
      try{await firestore.set(`${OUTBOX_COLLECTION}/${event.id}`,{status:'needs-reconciliation',processedAt:now},{merge:true,precondition:{updateTime:event._updateTime}});}catch{}
      continue;
    }

    // Atomic lease: use Firestore precondition (updateTime match)
    const leaseData = {
      leasedBy: workerId,
      leasedUntil: new Date(nowMs + LEASE_DURATION_MS).toISOString(),
      status: 'processing',
    };

    try {
      await firestore.set(
        `${OUTBOX_COLLECTION}/${event.id}`,
        leaseData,
        { merge: true, precondition: { updateTime: event._updateTime } }
      );
      claimed.push({ ...event, ...leaseData });
    } catch {
      // Another worker claimed it — skip
    }
  }
  await firestore.set(scan,{lastId,checkedAt:now});
  return claimed;
}

// ── Recipient Resolution ──────────────────────────────────────────
// Recipients are ALWAYS server-resolved from private Firestore records.
// The caller NEVER chooses recipients.
export async function resolveRecipients(event, { firestore, config, boundClient }) {
  const recipients = { client: null, admin: null };

  // Admin notification email from settings
  const settings = await firestore.get(SETTINGS_DOC);
  recipients.enabled=settings?.enabled===true;
  if (recipients.enabled&&settings.adminEnabled!==false&&validRecipient(settings.adminEmail)) {
    recipients.admin = settings.adminEmail;
  }

  // Client email from private client record (admin-only collection)
  if (event.clientSlug) {
    const client = boundClient || await firestore.get(`portal_clients/${event.clientSlug}`);
    if (recipients.enabled&&settings.clientEnabled!==false&&validRecipient(client?.email)) {
      recipients.client = client.email;
    }
  }
  const name=(value,fallback)=>typeof value==='string'&&value.trim()?value.replace(/[\r\n]/g,' ').trim().slice(0,120):fallback;
  recipients.clientName=name(settings?.clientSenderName,'Vision Flow');recipients.adminName=name(settings?.adminSenderName,'Vision Flow Team');
  recipients.clientReplyTo=validRecipient(settings?.clientReplyTo)?settings.clientReplyTo:null;
  recipients.adminReplyTo=validRecipient(settings?.adminReplyTo)?settings.adminReplyTo:null;

  return recipients;
}
function validRecipient(value) { return typeof value==='string'&&value.length<=254&&/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value); }

// ── Email Builder ─────────────────────────────────────────────────
// Templates are branded but NEVER include:
// - Raw final file links (dl URLs)
// - Private admin notes
// - Access credentials or client tokens in internal-team messages
// - Arbitrary external CTAs
// Only the canonical portal host is used for action links.
export function buildEmail(event, recipients, { config, context }) {
  const subject = emailSubject(event, context);

  const messages = [];

  // Client email (if applicable and recipient exists)
  if (recipients.client && isClientEvent(event.eventType)) {
    messages.push({
      to: recipients.client,
      subject,
      body: emailPlain(event, context, 'client'),
      htmlBody: emailHtml(event, context, 'client'),
      name: recipients.clientName || 'Vision Flow',
      replyTo: recipients.clientReplyTo || config?.replyTo || 'visionflow.agency.bd@gmail.com',
      targetType: 'client',
    });
  }

  // Admin alert (always, if admin email exists)
  if (recipients.admin) {
    messages.push({
      to: recipients.admin,
      subject: `[Admin] ${subject}`,
      body: emailPlain(event, context, 'admin'),
      htmlBody: emailHtml(event, context, 'admin'),
      name: recipients.adminName || 'Vision Flow Team',
      replyTo: recipients.adminReplyTo || config?.replyTo || 'visionflow.agency.bd@gmail.com',
      targetType: 'admin',
    });
  }

  if(event.eventType==='payment-notification'&&context?.ok){
    for(const message of messages)message.paymentDocument=paymentDocument(context,paymentSummary(context),emailLinks(event,context,message.targetType).action);
  }
  return messages;
}

function isClientEvent(type) {
  return [
    'consent-complete', 'master-signed', 'project-signed', 'project-acknowledged',
    'project-notification', 'payment-notification', 'delivery-notification',
    'update-notification', 'deemed-accepted', 'review-window',
    'confirmation-received', 'objection-received',
  ].includes(type);
}

function emailSubject(event, context) {
  const source=context?.source;
  if(context?.ok&&source?.schemaVersion===1&&source.eventType===event.eventType&&['project-notification','payment-notification','delivery-notification','update-notification'].includes(event.eventType)){
    const title=String(source.title||'').replace(/https?:\/\/\S+/gi,'[view workspace]').replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,200);
    if(title)return title;
  }
  const subjects = {
    'consent-complete': 'Welcome to Vision Flow',
    'master-signed': 'Master agreement signed',
    'project-signed': 'Project agreement signed',
    'project-acknowledged': 'Project acknowledgement recorded',
    'project-notification': 'Project update',
    'payment-notification': 'Payment update',
    'delivery-notification': 'Delivery update',
    'update-notification': 'Workspace update',
    'confirmation-received': 'Confirmation received',
    'objection-received': 'Feedback received',
    'deemed-accepted': 'Review period completed',
    'review-window': 'Your 72-hour review window',
  };
  return subjects[event.eventType] || 'Vision Flow notification';
}

export function emailLinks(event, context, targetType='client') {
  const base=`${PORTAL_HOST}/portal/`;
  // Only source-resolved context may supply a bearer link. An unbound preview
  // falls back to the authenticated portal, never an event-provided URL.
  if(!context?.ok)return {overview:base,project:base,action:base,label:'Open workspace'};
  const overview=targetType==='admin'?`${base}?c=${encodeURIComponent(context.portal.clientSlug)}`:`${base}?access=${encodeURIComponent(context.portalToken)}`;
  const project=event.projectKey?`${overview}&p=${encodeURIComponent(event.projectKey)}`:overview;
  let hash='review-updates',label='Review this update',destination=project;
  if(event.eventType==='consent-complete'){hash=context.portal.agreementMode==='project'?'':'master-agreement';label=targetType==='admin'?'View client onboarding':context.portal.agreementMode==='project'?'Choose your project':'Review & sign master agreement';destination=overview;}
  else if(event.eventType==='master-signed'){hash='master-agreement';label='View signed master agreement';destination=overview;}
  else if(event.eventType==='project-acknowledged'){hash='agreement';label='View acknowledged project';}
  else if(event.eventType==='project-signed'){hash='agreement';label='View signed project agreement';}
  else if(event.eventType==='deemed-accepted'){hash=`review-${event.sourceId}`;label='View review outcome';}
  else if(event.eventType==='review-window'){hash=`review-${event.sourceId}`;label='Review, confirm or object';}
  else if(['confirmation-received','objection-received'].includes(event.eventType)){hash=context.source?.requestId?`review-${context.source.requestId}`:`evidence-${event.sourceId}`;label=targetType==='admin'?'Review client response':'View your saved response';}
  else if(context.source?.responseTarget&&['review','evidence'].includes(context.source.responseTarget.kind)&&/^[A-Za-z0-9_-]{1,200}$/.test(context.source.responseTarget.id)){hash=`${context.source.responseTarget.kind}-${context.source.responseTarget.id}`;label='Read our response';}
  else if(event.eventType==='delivery-notification'&&event.projectKey){hash='deliveries';label=targetType==='admin'?'Open production log':'Verify & download';destination=`${project}&tab=log`;}
  else {hash=`notice-${event.sourceId}`;}
  return {overview,project,action:hash?`${destination}#${encodeURIComponent(hash)}`:destination,label};
}

function bdTime(iso) {
  // Bangladesh has no DST; avoid Intl time zones, which Apps Script V8 does not fully support.
  const ms=Date.parse(iso);if(!Number.isFinite(ms))return '';
  const d=new Date(ms+6*3600000),months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const h=d.getUTCHours(),m=String(d.getUTCMinutes()).padStart(2,'0');
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${h%12||12}:${m} ${h<12?'AM':'PM'} (Bangladesh time)`;
}

function emailCopy(event, context, targetType) {
  // Names are short labels, not a channel for arbitrary URLs or private notes.
  const label=value=>String(value||'').replace(/https?:\/\/\S+/gi,'[view workspace]').replace(/[\r\n]/g,' ').slice(0,200);
  const name=label(context?.portal?.name)||'there',project=label(context?.project?.name);
  const clientIntro={
    'consent-complete':context?.portal?.agreementMode==='project'?'Your Terms and Privacy acceptance is saved. Choose a project to review its details and any applicable project agreement.':'Your Terms and Privacy acceptance is saved. Review and sign your Master Partner Agreement once for this workspace.',
    'master-signed':'Your signed Master Partner Agreement is saved. You will not need to sign again for new projects. If project details change in an important way, you will only be asked to acknowledge them.',
    'project-signed':'Your signed agreement for this project is saved. You can view the captured terms in your workspace.',
    'project-acknowledged':'Your acknowledgement of the current project details is saved.',
    'project-notification':'A new project is ready for you. Open it to read the details.',
    'payment-notification':'A payment record on your project was updated. Please check the amounts below and tell us through the portal if anything looks wrong. This email is a record update, not a payment receipt.',
    'delivery-notification':'Good news - a delivery is ready for you.',
    'update-notification':'Your project was updated. Please check the latest details and send any questions through the portal.',
    'confirmation-received':'Your confirmation is saved - thank you. You can see it in your workspace at any time.',
    'objection-received':'Your feedback was received. Automatic acceptance is paused until we review it and reply. We will email you when we respond.',
    'deemed-accepted':'The 72-hour review period for this update ended without any reported problem, so it is now recorded as accepted. You can still contact us through the portal if anything needs attention.',
    'review-window':`You have at least until ${bdTime(context?.earliestDeadline)||'the deadline shown in your workspace'} to review this update. Confirm it or report a problem in your workspace. If nothing is reported before the deadline, the update counts as accepted.`,
  }[event.eventType]||'Open your workspace to review this update.';
  const adminIntro={
    'consent-complete':`Client ${name} completed Terms and Privacy consent. Review the onboarding record and applicable agreement status.`,
    'master-signed':`Client ${name} signed the Master Partner Agreement. Review the saved signature and covered project particulars.`,
    'project-signed':`Client ${name} signed the project agreement. Review the captured project terms and signature.`,
    'project-acknowledged':`Client ${name} acknowledged the current project details.`,
    'project-notification':`A new project for ${name} was published to the client portal.`,
    'payment-notification':`A payment record for ${name} was updated. The summary below is a record update, not a payment confirmation.`,
    'delivery-notification':`A delivery for ${name} was published. The client must verify it before downloading; it is auto-accepted after 72 hours if no problem is reported.`,
    'update-notification':`The ${name} project was updated and the client was notified.`,
    'confirmation-received':`Client ${name} confirmed an update. The response is saved in the workspace.`,
    'objection-received':`Client ${name} reported a problem or sent feedback. Automatic acceptance is paused until you respond in the portal.`,
    'deemed-accepted':`The 72-hour review period for ${name} ended without an objection. The update is recorded as accepted (deemed, not an explicit confirmation).`,
    'review-window':`A 72-hour review window started for ${name}. The deadline is shown in the workspace.`,
  }[event.eventType]||'Open the administrator workspace to review this notification.';
  const source=context?.source;
  const note=context?.ok&&source?.schemaVersion===1&&source.eventType===event.eventType&&!(targetType==='admin'&&event.eventType==='delivery-notification')?String(source.message||'').replace(/https?:\/\/\S+/gi,'[view workspace]').slice(0,4000):'';
  return {greeting:targetType==='admin'?'Dear Sir':`Hello ${name}`,project,note,intro:targetType==='admin'?adminIntro:clientIntro};
}

function paymentSummary(context) {
  const totals=paymentTotals(context?.project),changes=context?.source?.paymentChanges;
  const label=value=>String(value||'').replace(/https?:\/\/\S+/gi,'[view workspace]').replace(/[\r\n]/g,' ').slice(0,80);
  const rows=[];
  for(const change of (changes?.identified&&Array.isArray(changes.items)?changes.items:[]).slice(0,20)){
    if(!['added','updated','removed'].includes(change.kind))continue;
    const payment=change.after||change.before;
    const date=/^\d{4}-\d{2}-\d{2}$/.test(payment?.date)?payment.date:'Date not recorded';
    rows.push([`Record ${change.kind}: ${date}${payment?.type?' / '+label(payment.type):''}`,paymentMoney(payment?.amount)]);
    if(change.kind==='updated')rows.push(['Previously recorded',paymentMoney(change.before?.amount)]);
  }
  if(changes?.count>(changes?.items?.length||0))rows.push(['Additional changed records',`${changes.count-(changes.items?.length||0)} - view workspace`]);
  rows.push(['Project budget',paymentMoney(totals.budget)],['Total recorded',paymentMoney(totals.paid)],
    [totals.credit?'Credit balance':'Recorded balance',paymentMoney(totals.balance===null?null:Math.abs(totals.balance))]);
  return rows;
}

function emailHtml(event, context, targetType) {
  const links=emailLinks(event,context,targetType),copy=emailCopy(event,context,targetType);
  const payment=event.eventType==='payment-notification'?paymentSummary(context):null;
  const paymentRows=payment?`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:20px 0;background:#f7fafc;border:1px solid #e2e8f0;">${payment.map(([label,value])=>`<tr><td style="padding:9px 12px;color:#475569;border-bottom:1px solid #e2e8f0;">${esc(label)}</td><td style="padding:9px 12px;text-align:right;font-weight:700;border-bottom:1px solid #e2e8f0;">${esc(value)}</td></tr>`).join('')}</table>`:'';
  return `<!doctype html><html><body style="margin:0;background:#f4f7fb;font-family:Arial,Helvetica,sans-serif;color:#17233a;">
<div style="padding:24px 12px;background:#f4f7fb;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #dbe4ee;border-radius:12px;overflow:hidden;">
    <tr><td style="padding:22px 28px;border-bottom:4px solid #0f9f9a;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle;"><img src="${EMAIL_LOGO_URL}" alt="Vision Flow" width="52" height="52" style="display:block;width:52px;height:52px;object-fit:contain;border-radius:10px;"></td>
        <td style="padding-left:14px;vertical-align:middle;"><a href="${esc(links.overview)}" style="font-size:20px;color:#12304a;font-weight:700;text-decoration:none;">Vision Flow</a><br><span style="font-size:12px;color:#64748b;">Creative Production Agency</span></td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:28px;">
      <p style="margin:0 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#0f766e;font-weight:700;">${esc(emailSubject(event))}</p>
      <h1 style="margin:0 0 18px;font-size:25px;line-height:1.25;color:#12304a;overflow-wrap:anywhere;">${esc(emailSubject(event,context))}</h1>
      <p style="margin:0 0 14px;">${esc(copy.greeting)},</p>${copy.project?`<p style="margin:0 0 14px;font-weight:700;">${esc(copy.project)}</p>`:''}
      <p style="margin:0 0 18px;line-height:1.65;">${esc(copy.intro)}</p>
      ${copy.note?`<p style="padding:14px;background:#f7fafc;border-left:3px solid #0f766e;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;">${esc(copy.note)}</p>`:''}
      ${paymentRows}
      <p style="margin:22px 0;"><a href="${esc(links.action)}" style="display:inline-block;padding:12px 20px;background:#0f766e;color:#ffffff;text-decoration:none;border-radius:7px;font-weight:700;">${esc(links.label)}</a></p>
      ${event.projectKey?`<p style="margin:0 0 14px;"><a href="${esc(links.project)}" style="color:#0f766e;">Open this project</a></p>`:''}
      <p style="margin:0 0 14px;"><a href="${esc(links.overview)}" style="color:#0f766e;">All projects</a></p>
      <p style="font-size:12px;line-height:1.55;color:#64748b;">Updates that need your review show a live 72-hour countdown in your workspace. If something is not right, tell us through the portal before the timer ends.</p>
      <p style="font-size:12px;line-height:1.55;color:#64748b;">If this is your first message from Vision Flow, please check Spam or Promotions and mark it as trusted so future updates are not missed.</p>
    </td></tr>
    <tr><td style="padding:18px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:11px;line-height:1.55;color:#64748b;">Automated notification from Vision Flow. Please keep your private workspace link confidential.</td></tr>
  </table>
</div></body></html>`;
}

function emailPlain(event, context, targetType) {
  const links=emailLinks(event,context,targetType),copy=emailCopy(event,context,targetType);
  const payment=event.eventType==='payment-notification'?paymentSummary(context):null;
  const paymentText=payment?`\nPayment summary\n${payment.map(([label,value])=>`${label}: ${value}`).join('\n')}\n`:'';
  return `${emailSubject(event,context)}\n\n${copy.greeting},\n${copy.project||''}\n\n${copy.intro}\n${copy.note||''}\n${paymentText}\n${links.label}: ${links.action}\n\nProject: ${links.project}\nAll projects: ${links.overview}\n\nUpdates that need your review show a live 72-hour countdown in your workspace. If something is not right, tell us through the portal before the timer ends. If this is your first message, check Spam or Promotions and mark it trusted. Keep your private link confidential.`;
}

// ── Process Single Event ──────────────────────────────────────────
export async function processEvent(event, { firestore, mail, clock, config }) {
  if(config?.enabled!==true)return {status:'disabled'};
  if(!event?.id||event.id.includes('/')||!event.leasedBy)return {status:'lease-lost'};
  const path=`${OUTBOX_COLLECTION}/${event.id}`;
  let current=await firestore.get(path);
  if(!current?._updateTime||current.status!=='processing'||current.leasedBy!==event.leasedBy||
    !(Date.parse(current.leasedUntil)>Date.parse(clock.now())))return {status:'lease-lost'};
  // Fence every state transition with the version actually read. In particular,
  // no mail call may occur until processing -> sending wins this CAS.
  const fenced={...firestore,set:async(p,data,options={})=>{
    if(p!==path)return firestore.set(p,data,options);
    if(!(Date.parse(current.leasedUntil)>Date.parse(clock.now()))&&current.status!=='sending')throw Error('LEASE_LOST');
    try{await firestore.set(p,data,{...options,precondition:{updateTime:current._updateTime}});}
    catch{throw Error('LEASE_LOST');}
    current=await firestore.get(path);
    if(!current?._updateTime||current.leasedBy!==event.leasedBy)throw Error('LEASE_LOST');
  },runTransaction:async fn=>{
    let result;
    try{result=await firestore.runTransaction(fn);}
    catch(txErr){
      let reread;
      try{reread=await firestore.get(path);}catch{throw txErr;}
      if(!reread?._updateTime||reread.leasedBy!==event.leasedBy||reread.status!=='processing'||!(Date.parse(reread.leasedUntil)>Date.parse(clock.now())))throw Error('LEASE_LOST');
      throw txErr;
    }
    current=await firestore.get(path);
    if(!current?._updateTime||current.leasedBy!==event.leasedBy)throw Error('LEASE_LOST');
    return result;
  }};
  try{return await processOwnedEvent({...current,id:event.id},{firestore:fenced,mail,clock,config});}
  catch(error){if(error.message==='LEASE_LOST')return {status:'lease-lost'};throw error;}
}

async function processOwnedEvent(event, { firestore, mail, clock, config }) {
  const now = clock.now();
  if(!validateConfig(config).valid)return {status:'configuration-invalid'};

  // 1. Validate event is not stale
  if (!event || !event.id || !EVENT_TYPES.includes(event.eventType)) {
    return { status: 'invalid', reason: 'Unknown or malformed event.' };
  }

  // 2. Check activation boundary — never email for events before activation
  if(!Number.isFinite(reviewTimestamp(event.createdAt)))return {status:'invalid',reason:'Event timestamp is missing or invalid.'};
  if (reviewTimestamp(event.createdAt) < Date.parse(config.activationBoundary)) {
    await firestore.set(`${OUTBOX_COLLECTION}/${event.id}`, {
      status: 'skipped-pre-activation',
      processedAt: now,
    }, { merge: true });
    return { status: 'skipped-pre-activation' };
  }

  // 3. Deduplication: check if this stable ID already has a terminal status
  const existing = await firestore.get(`${BACKEND_EVENTS}/${event.id}`);
  if (existing && ['sent', 'skipped-pre-activation'].includes(existing.status)) {
    await firestore.set(`${OUTBOX_COLLECTION}/${event.id}`, {
      status: 'deduplicated',
      processedAt: now,
    }, { merge: true });
    return { status: 'deduplicated' };
  }

  // 4–5. Validate exact source ownership/version and current workspace identity.
  const binding=await resolveEventSource(event,{firestore,clock,config});
  if(!binding.ok){await firestore.set(`${OUTBOX_COLLECTION}/${event.id}`,{status:binding.status,processedAt:now},{merge:true});return {status:binding.status};}

  // 6. Resolve recipients from server records
  const recipients = await resolveRecipients(event, { firestore, config, boundClient:binding.client });
  if(!recipients.enabled){await firestore.set(`${OUTBOX_COLLECTION}/${event.id}`,{status:'settings-paused',processedAt:now},{merge:true});return {status:'settings-paused'};}
  if (!recipients.client && !recipients.admin) {
    await firestore.set(`${OUTBOX_COLLECTION}/${event.id}`, {
      status: 'no-recipients',
      processedAt: now,
    }, { merge: true });
    return { status: 'no-recipients' };
  }

  // 7. Check remaining mail quota
  const remaining = await mail.remainingQuota();
  let messages;
  try{messages=buildEmail(event, recipients, { config, context:binding });}
  catch{await firestore.set(`${OUTBOX_COLLECTION}/${event.id}`,{status:'attachment-blocked',processedAt:now},{merge:true});return {status:'attachment-blocked'};}
  if(!messages.length)return {status:'no-recipients'};
  if (remaining < messages.length) {
    await firestore.set(`${OUTBOX_COLLECTION}/${event.id}`, {
      status: 'quota-exhausted',
      // Quota exhaustion is not a send failure. Retry later without exhausting
      // the transport failure budget while the daily quota is unavailable.
      nextRetryAfter: new Date(Date.parse(now)+60*60*1000).toISOString(),
      lastError: `Quota remaining: ${remaining}, needed: ${messages.length}`,
      processedAt: now,
    }, { merge: true });
    return { status: 'quota-exhausted' };
  }

  // 8. Send emails — Gmail send and Firestore commit are NOT atomic
  // Mark as 'sending' BEFORE attempting mail
  // Revalidate all dependencies in the SAME transaction as the sending claim.
  // Mail cannot be atomic with Firestore. This defines its authorization point:
  // subsequent edits cannot recall an already handed-off message.
  let authorization={ok:false,status:'lease-lost'};
  await firestore.runTransaction(async tx=>{
    if((await tx.get('portal_settings/recovery'))?.active===true){authorization={ok:false,status:'recovery-paused'};return;}
    const persisted=await tx.get(`${OUTBOX_COLLECTION}/${event.id}`);
    if(!persisted||persisted.status!=='processing'||persisted.leasedBy!==event.leasedBy||!(Date.parse(persisted.leasedUntil)>Date.parse(clock.now())))return;
    const fresh=await resolveEventSource({...persisted,id:event.id},{firestore:tx,clock,config});
    if(!fresh.ok){authorization=fresh;return;}
    const targets=await resolveRecipients(event,{firestore:tx,config,boundClient:fresh.client});
    if(!targets.enabled){authorization={ok:false,status:'settings-paused'};return;}
    if(event.eventType==='review-window')fresh.earliestDeadline=new Date(reviewTimestamp(clock.now())+72*3600000).toISOString();
    let prepared;
    try{prepared=buildEmail(event,targets,{config,context:fresh});}catch{authorization={ok:false,status:'attachment-blocked'};return;}
    if(!prepared.length){authorization={ok:false,status:'no-recipients'};return;}
    if(prepared.length>remaining){authorization={ok:false,status:'quota-exhausted'};return;}
    tx.set(`${OUTBOX_COLLECTION}/${event.id}`,{status:'sending',processedAt:clock.now(),...(fresh.earliestDeadline?{earliestDeadline:fresh.earliestDeadline}:{}),recipientClient:targets.client||null},{merge:true});
    authorization={ok:true};messages=prepared;
  });
  if(!authorization.ok){
    if(authorization.status!=='lease-lost')await firestore.set(`${OUTBOX_COLLECTION}/${event.id}`,{status:authorization.status,processedAt:clock.now()},{merge:true});
    return {status:authorization.status};
  }

  const results = [];
  for (const msg of messages) {
    try {
      await mail.send(msg);
      results.push({ to: msg.targetType, status: 'handed-to-provider' });
    } catch (err) {
      // A network timeout may follow successful acceptance. Only an explicit
      // adapter guarantee of non-acceptance makes an automatic retry safe.
      results.push({ to: msg.targetType, status: err?.notAccepted===true?'failed':'unknown', error: 'Mail handoff failed or is uncertain.' });
    }
  }

  // 9. Determine outcome — distinguish states carefully
  const allFailed = results.every(r => r.status === 'failed');
  const anyFailed = results.some(r => r.status === 'failed');
  if(results.some(r=>r.status==='unknown')){
    await firestore.set(`${OUTBOX_COLLECTION}/${event.id}`,{status:'needs-reconciliation',processedAt:now,deliveryResults:results},{merge:true});
    return {status:'needs-reconciliation',results};
  }

  if (allFailed) {
    // Complete failure — schedule retry with backoff
    const retryCount = (event.retryCount || 0) + 1;
    const finalStatus = retryCount >= MAX_RETRIES ? 'failed-permanent' : 'retry';
    await firestore.set(`${OUTBOX_COLLECTION}/${event.id}`, {
      status: finalStatus,
      retryCount,
      lastError: results[0]?.error || 'All sends failed',
      nextRetryAfter: retryCount < MAX_RETRIES
        ? new Date(Date.parse(now) + BACKOFF_BASE_MS * Math.pow(2, retryCount - 1)).toISOString()
        : null,
      processedAt: now,
    }, { merge: true });
    return { status: finalStatus, results };
  }

  // 10. At least one send succeeded.
  //     We handed the message to the provider but CANNOT confirm inbox delivery.
  //     This is 'sent-unconfirmed' — not 'delivered'.
  const finalStatus = anyFailed ? 'sent-partial' : 'sent-unconfirmed';
  await firestore.set(`${OUTBOX_COLLECTION}/${event.id}`, {
    status: finalStatus,
    sentAt: clock.now(),
    processedAt: now,
    deliveryResults: results,
  }, { merge: true });

  // Record in backend events for dedup
  await firestore.set(`${BACKEND_EVENTS}/${event.id}`, {
    status: 'sent',
    eventType: event.eventType,
    clientSlug: event.clientSlug,
    projectKey: event.projectKey,
    sentAt: now,
  });

  return { status: finalStatus, results };
}

// ── Scheduled Worker Entry Point ──────────────────────────────────
export async function processOutbox({ firestore, mail, clock, config }) {
  const workerId = `worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // 1. Validate configuration — fail closed
  if (!validateConfig(config).valid) {
    return {
      ok: false,
      error: 'Configuration incomplete. Worker requires projectId, adminUid, and activationBoundary.',
      processed: 0,
    };
  }

  // 2. Check remaining quota before starting
  if(config.enabled!==true)return {ok:false,error:'Worker is disabled until runtime and rules integration are verified.',processed:0};
  const sender=await mail.readiness?.();
  if(sender&&sender.ok!==true)return {ok:false,error:'The authenticated sender does not match the configured agency account.',code:sender.code,processed:0};
  const quota = await mail.remainingQuota();
  if (quota <= 0) {
    return { ok: false, error: 'Daily email quota exhausted.', processed: 0 };
  }
  if((await firestore.get(SETTINGS_DOC))?.enabled!==true)return {ok:false,error:'Notification sending is paused in private settings.',processed:0};

  // 3. Claim events with atomic leases
  const events = await claimEvents({
    firestore, clock, workerId, config,
    limit: Math.min(MAX_EVENTS_PER_RUN, quota,config.eventBatchLimit||MAX_EVENTS_PER_RUN),
  });

  // 4. Process each event
  const results = [];
  let quotaRemaining = quota;
  for (const event of events) {
    if (quotaRemaining <= 0) break;
    try{firestore.checkBudget?.(50);}catch{break;}

    const result = await processEvent(event, { firestore, mail, clock, config });
    results.push({ eventId: event.id, ...result });

    if (result.status === 'quota-exhausted') break;
    if (result.results) quotaRemaining -= result.results.length;
  }

  return {
    ok: true,
    workerId,
    processed: results.length,
    results,
  };
}

// ── Review Timer Processing ───────────────────────────────────────
// Imports the review engine for deemed-acceptance decisions.
// This function is called by the scheduled worker for review events.
export async function processReviewTimers(adapters) {
  return settleReviewTimers(adapters);
}

// ── Configuration Validation ──────────────────────────────────────
export function validateConfig(config) {
  const errors = [];
  if (!config) errors.push('Config is null.');
  else {
    if (!config.projectId) errors.push('Missing projectId.');
    if (!config.adminUid) errors.push('Missing adminUid.');
    if (!config.activationBoundary||!Number.isFinite(Date.parse(config.activationBoundary))) errors.push('Missing or invalid activationBoundary.');
    if (config.portalHost && config.portalHost!==PORTAL_HOST) {
      errors.push('portalHost must be the canonical VisionFlow origin.');
    }
    if (config.clientScopeSlug !== undefined && config.clientScopeSlug !== null &&
        (typeof config.clientScopeSlug !== 'string' ||
         (config.clientScopeSlug.trim() && (config.clientScopeSlug.trim().length > 200 || config.clientScopeSlug.includes('/'))))) {
      errors.push('clientScopeSlug must be a bounded client id without slash.');
    }
  }
  return { valid: errors.length === 0, errors };
}

// ── Exports ───────────────────────────────────────────────────────
export {
  EVENT_TYPES,
  OUTBOX_COLLECTION,
  BACKEND_EVENTS,
  MAX_EVENTS_PER_RUN,
  MAX_RETRIES,
  LEASE_DURATION_MS,
  esc,
};
