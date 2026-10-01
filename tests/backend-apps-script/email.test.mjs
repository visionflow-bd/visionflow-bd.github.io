import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildEmail,emailLinks,resolveRecipients,processOutbox} from '../../backend/apps-script/worker.mjs';
import {notificationSettings,validateNotificationSettings} from '../../portal/notification-settings.js';
import {createFakeFirestore} from './fake-firestore.mjs';
import {notificationStatus,notificationStatusHtml} from '../../portal/notification-status.js';

const context={ok:true,portalToken:'synthetic-private-token',portal:{clientSlug:'client-one',name:'Test Partner'},project:{name:'Sample Project'},source:{message:'PRIVATE CONTENT https://drive.google.com/file/d/secret'}};
const event={eventType:'payment-notification',projectKey:'project-one',sourceId:'notice-one',portalToken:'untrusted-event-token',portalUrl:'https://attacker.invalid'};

test('client mail has three distinct canonical destinations and the resolved client name',()=>{
  const [mail]=buildEmail(event,{client:'client@example.invalid'},{config:{},context});
  const links=emailLinks(event,context);
  assert.equal(links.overview,'https://visionflow-bd.github.io/portal/?access=synthetic-private-token');
  assert.equal(links.project,`${links.overview}&p=project-one`);
  assert.equal(links.action,`${links.project}#notice-notice-one`);
  assert.ok(mail.htmlBody.includes('Hello Test Partner'));assert.ok(mail.htmlBody.includes('Sample Project'));
  assert.ok(mail.body.includes(links.overview));assert.ok(mail.body.includes(links.project));assert.ok(mail.body.includes(links.action));
  for(const secret of ['untrusted-event-token','attacker.invalid','PRIVATE CONTENT','drive.google.com'])assert.ok(!JSON.stringify(mail).includes(secret));
});
test('internal alert goes to authenticated admin route and never receives client bearer token',()=>{
  const [mail]=buildEmail({...event,eventType:'objection-received',sourceId:'feedback-one'},{admin:'team@example.invalid'},{config:{},context});
  const links=emailLinks({...event,eventType:'objection-received',sourceId:'feedback-one'},context,'admin');
  assert.equal(links.overview,'https://visionflow-bd.github.io/portal/?c=client-one');
  assert.equal(links.action,`${links.overview}&p=project-one#evidence-feedback-one`);
  assert.ok(mail.body.includes(links.action));assert.ok(!JSON.stringify(mail).includes('synthetic-private-token'));
  assert.ok(!JSON.stringify(mail).includes('access='));
});
test('review response email links to its durable review even after controls disappear',()=>{
  const links=emailLinks({...event,eventType:'objection-received',sourceId:'review-one'},{...context,source:{requestId:'review-one'}},'admin');
  assert.ok(links.action.endsWith('#review-review-one'));
});
test('welcome leads to master signing; acknowledgement and deemed outcome have exact targets',()=>{
  for(const [type,anchor] of [['consent-complete','master-agreement'],['master-signed','master-agreement'],['project-acknowledged','agreement'],['deemed-accepted','review-notice-one']]){
    const links=emailLinks({...event,eventType:type},context);
    assert.ok(links.action.endsWith('#'+anchor));
    if(type==='consent-complete'||type==='master-signed')assert.ok(!links.action.includes('&p='));
  }
});
test('malicious/unbound preview cannot inject sender host, token, markup or private source content',()=>{
  const bound={...context,portal:{...context.portal,name:'<script>bad()</script> https://example.invalid/final'},project:{name:'<img onerror="bad()">'}};
  const [mail]=buildEmail(event,{client:'client@example.invalid'},{config:{portalHost:'https://evil.invalid'},context:bound});
  assert.ok(mail.htmlBody.includes('&lt;script&gt;'));assert.ok(!mail.htmlBody.includes('<script>'));
  for(const secret of ['https://example.invalid/final','evil.invalid','PRIVATE CONTENT'])assert.ok(!JSON.stringify(mail).includes(secret));
  const preview=buildEmail(event,{client:'client@example.invalid'},{config:{}})[0];
  assert.ok(preview.body.includes('https://visionflow-bd.github.io/portal/'));
  assert.ok(!preview.body.includes('access='));
});
test('private preferences route separate client/team names reply-to and audience controls',async()=>{
  const settings=validateNotificationSettings(notificationSettings({enabled:true,adminEmail:'team@example.invalid',clientSenderName:'Client Desk',adminSenderName:'Internal Desk',clientReplyTo:'clients@example.invalid',adminReplyTo:'internal@example.invalid'}));
  const db=createFakeFirestore({'portal_settings/notifications':settings,'portal_clients/client-one':{email:'customer@example.invalid'}});
  const targets=await resolveRecipients({clientSlug:'client-one'},{firestore:db});
  const messages=buildEmail(event,targets,{config:{},context});assert.equal(messages.length,2);
  assert.equal(messages[0].name,'Client Desk');assert.equal(messages[0].replyTo,'clients@example.invalid');
  assert.equal(messages[1].name,'Internal Desk');assert.equal(messages[1].replyTo,'internal@example.invalid');
  assert.equal(messages[0].to,'customer@example.invalid');assert.equal(messages[1].to,'team@example.invalid');
  await db.set('portal_settings/notifications',{clientEnabled:false},{merge:true});
  assert.equal((await resolveRecipients({clientSlug:'client-one'},{firestore:db})).client,null);
  await db.set('portal_settings/notifications',{adminEnabled:false},{merge:true});
  assert.equal((await resolveRecipients({clientSlug:'client-one'},{firestore:db})).admin,null);
});
test('absent or paused private preferences do not claim queued mail or send',async()=>{
  for(const enabled of [undefined,false]){
    const db=createFakeFirestore({'portal_outbox/pending':{status:'queued',retryCount:0},...(enabled===false?{'portal_settings/notifications':{enabled:false}}:{})});
    const result=await processOutbox({firestore:db,clock:{now:()=>new Date().toISOString()},mail:{remainingQuota:async()=>100,send:async()=>assert.fail('No sending while paused')},config:{enabled:true,projectId:'demo',adminUid:'test',activationBoundary:'2026-09-30T00:00:00Z'}});
    assert.equal(result.processed,0);assert.match(result.error,/paused/);assert.equal((await db.get('portal_outbox/pending')).status,'queued');
  }
});
test('settings validation rejects recipient/header injection and ineffective enablement',()=>{
  assert.equal(notificationSettings().enabled,false);
  for(const input of [{enabled:true,adminEmail:''},{clientReplyTo:'a@example.com,b@example.com'},{adminReplyTo:'safe@example.com\nBcc:bad@example.com'},{enabled:true,adminEnabled:false,clientEnabled:false}])assert.throws(()=>validateNotificationSettings(notificationSettings(input)));
  assert.equal(notificationSettings({clientSenderName:'A\nB'}).clientSenderName,'A B');
});
test('admin queue view distinguishes uncertainty and never renders private payloads or URLs',()=>{
  assert.match(notificationStatus({status:'sent-unconfirmed'}),/inbox delivery unconfirmed/);
  assert.match(notificationStatus({status:'needs-reconciliation'}),/before any resend/);
  const html=notificationStatusHtml([{clientSlug:'c',eventType:'<script>bad()</script>',status:'needs-reconciliation',portalToken:'DO-NOT-RENDER',lastError:'PRIVATE-ERROR',dl:'https://example.invalid/final',deliveryResults:[{to:'client',status:'unknown'}]}],{c:{name:'<img onerror="bad()">'}});
  for(const text of ['<script>','<img','DO-NOT-RENDER','PRIVATE-ERROR','example.invalid/final'])assert.ok(!html.includes(text));
  assert.ok(html.includes('client: unknown'));assert.ok(html.includes('&lt;script&gt;'));
});
