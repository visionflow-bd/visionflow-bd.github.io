import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildEmail,emailLinks,resolveRecipients,processOutbox} from '../../backend/apps-script/worker.mjs';
import {notificationSettings,validateNotificationSettings} from '../../portal/notification-settings.js';
import {createFakeFirestore} from './fake-firestore.mjs';
import {notificationStatus,notificationStatusHtml} from '../../portal/notification-status.js';
import {paymentChanges,paymentCents,paymentTotals} from '../../portal/payment-notification.js';

const context={ok:true,portalToken:'synthetic-private-token',portal:{clientSlug:'client-one',name:'Test Partner'},project:{name:'Sample Project'},source:{message:'PRIVATE CONTENT https://drive.google.com/file/d/secret'}};
const event={eventType:'payment-notification',projectKey:'project-one',sourceId:'notice-one',portalToken:'untrusted-event-token',portalUrl:'https://attacker.invalid'};

test('client mail has three distinct canonical destinations and the resolved client name',()=>{
  const [mail]=buildEmail(event,{client:'client@example.invalid'},{config:{},context});
  const links=emailLinks(event,context);
  assert.equal(links.overview,'https://visionflow-bd.github.io/portal/?access=synthetic-private-token');
  assert.equal(links.project,`${links.overview}&p=project-one`);
  assert.equal(links.action,`${links.project}#notice-notice-one`);
  assert.ok(mail.htmlBody.includes('Hello Test Partner'));assert.ok(mail.htmlBody.includes('Sample Project'));
  assert.ok(mail.htmlBody.includes('https://visionflow-bd.github.io/logo.png'));
  assert.ok(mail.htmlBody.includes('check Spam or Promotions'));
  assert.ok(!mail.htmlBody.includes('#10263c'));assert.ok(!mail.htmlBody.includes('💰'));
  assert.ok(mail.body.includes(links.overview));assert.ok(mail.body.includes(links.project));assert.ok(mail.body.includes(links.action));
  for(const secret of ['untrusted-event-token','attacker.invalid','PRIVATE CONTENT','drive.google.com'])assert.ok(!JSON.stringify(mail).includes(secret));
});

test('admin mail uses formal CEO greeting and a separate internal message',()=>{
  const [mail]=buildEmail({...event,eventType:'payment-notification'},{admin:'team@example.invalid'},{config:{},context});
  assert.ok(mail.htmlBody.includes('Dear Sir'));
  assert.ok(mail.htmlBody.includes('A payment record for Test Partner'));
  assert.ok(!mail.htmlBody.includes('Hello Test Partner'));
});

test('payment mail presents a safe bank-style summary without proof URLs',()=>{
  const paymentContext={...context,project:{...context.project,budget:1000,payments:[{amount:250,date:'2026-10-01',type:'Advance',proofUrl:'https://example.invalid/private-proof'}]}};
  const [mail]=buildEmail({...event,eventType:'payment-notification'},{client:'client@example.invalid'},{config:{},context:paymentContext});
  assert.ok(mail.htmlBody.includes('Total recorded'));
  assert.ok(mail.htmlBody.includes('BDT 250'));
  assert.ok(mail.htmlBody.includes('BDT 750'));
  assert.ok(!JSON.stringify(mail).includes('private-proof'));
});

test('payment edits and removals describe the changed transaction, not the latest payment',()=>{
  const before=[{id:'old',amount:250,date:'2026-09-01',type:'Advance'},{id:'latest',amount:500,date:'2026-10-01',type:'Final'}];
  for(const after of [[{...before[0],amount:300},before[1]],[before[1]]]){
    const bound={...context,project:{budget:1000,payments:after},source:{paymentChanges:paymentChanges(before,after)}};
    const [mail]=buildEmail(event,{client:'client@example.invalid'},{context:bound});
    assert.match(mail.body,/2026-09-01/);assert.doesNotMatch(mail.body,/Latest payment|2026-10-01/);
    assert.match(mail.body,after.length===2?/Previously recorded: BDT 250.00/:/Record removed.*BDT 250.00/);
    if(after.length===2)assert.match(mail.body,/Record updated.*BDT 300.00/);
  }
});

test('invalid money never becomes zero; overpayments are explicitly credit balances',()=>{
  for(const value of [null,undefined,'','bad','https://example.invalid/file',-1,Infinity,{},true,'1e9','1.001'])assert.equal(paymentCents(value),null);
  assert.equal(paymentTotals({budget:1000,payments:[{amount:'bad'}]}).paid,null);
  const render=project=>buildEmail(event,{client:'client@example.invalid'},{context:{...context,project}})[0];
  assert.match(render({budget:100,payments:[{amount:125.55}]}).body,/Credit balance: BDT 25.55/);
  assert.match(render({budget:'bad',payments:[{amount:5}]}).body,/Recorded balance: Not available/);
  assert.equal(paymentTotals({budget:1,payments:[{amount:0.1},{amount:0.2}]}).paid,30);
});

test('changed payment labels are escaped and cannot leak arbitrary proof or note links',()=>{
  const rows=[{id:'p',amount:10,date:'2026-10-01',type:'<img> https://example.invalid/final',note:'PRIVATE NOTE'}];
  const [mail]=buildEmail(event,{client:'client@example.invalid'},{context:{...context,project:{budget:10,payments:rows},source:{paymentChanges:paymentChanges([],rows)}}});
  assert.ok(mail.htmlBody.includes('&lt;img&gt;'));assert.ok(!mail.htmlBody.includes('<img>'));
  assert.doesNotMatch(JSON.stringify(mail),/example.invalid\/|PRIVATE NOTE/);
  const links=emailLinks(event,context);
  for(const url of [links.overview,links.project,links.action])assert.ok(mail.htmlBody.includes(url.replace(/&/g,'&amp;')));
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
  assert.ok(html.includes('Client email: unknown'));assert.ok(html.includes('&lt;script&gt;'));
});

test('client actions send a receipt to the client and a distinct alert to the administrator',()=>{
  for(const type of ['confirmation-received','objection-received','project-signed']){
    const messages=buildEmail({...event,eventType:type},{client:'c@example.invalid',admin:'a@example.invalid'},{context});
    assert.equal(messages.length,2);assert.ok(messages[0].body.includes('Your '));
    assert.ok(messages[1].body.includes('Client Test Partner'));assert.ok(!messages[1].body.includes('access='));
  }
});

test('project-mode welcome never requests a master signature',()=>{
  const [message]=buildEmail({...event,eventType:'consent-complete',projectKey:null},{client:'c@example.invalid'},{context:{...context,portal:{...context.portal,agreementMode:'project'}}});
  assert.doesNotMatch(message.body,/Master Partner|master-agreement/);assert.match(message.body,/Choose your project/);
});

test('manual reply includes a bounded escaped explanation and exact response link',()=>{
  const bound={...context,source:{schemaVersion:1,eventType:'update-notification',message:'Please review our response <script>bad</script> https://drive.google.com/file/d/private',responseTarget:{kind:'evidence',id:'feedback-1'}}};
  const [message]=buildEmail({...event,eventType:'update-notification'},{client:'c@example.invalid'},{context:bound});
  assert.match(message.body,/Please review our response/);assert.match(message.body,/#evidence-feedback-1/);
  assert.match(message.htmlBody,/&lt;script&gt;/);assert.doesNotMatch(message.htmlBody,/<script>|drive.google.com/);
});

test('wrong sender readiness stops before claiming any event rather than claiming quota exhaustion',async()=>{
  const db=createFakeFirestore({'portal_settings/notifications':{enabled:true}});
  const result=await processOutbox({firestore:db,config:{enabled:true,projectId:'demo',adminUid:'test',activationBoundary:'2026-09-30T00:00:00Z'},mail:{readiness:()=>({ok:false,code:'sender-mismatch'}),remainingQuota:()=>assert.fail('readiness first')}});
  assert.equal(result.processed,0);assert.equal(result.code,'sender-mismatch');
});

test('manual email uses the source-bound title and complete saved reply in both formats',()=>{
  const title='October <review>\r\nNew details',reply='A detailed explanation. '.repeat(30)+'\nFINAL RESPONSE PARAGRAPH';
  const bound={...context,source:{schemaVersion:1,eventType:'update-notification',title,message:reply}};
  const [client,admin]=buildEmail({...event,eventType:'update-notification'},{client:'c@example.invalid',admin:'a@example.invalid'},{context:bound});
  assert.equal(client.subject,'October <review>  New details');assert.equal(admin.subject,`[Admin] ${client.subject}`);
  assert.ok(client.body.includes(reply));assert.ok(client.htmlBody.includes('FINAL RESPONSE PARAGRAPH'));
  assert.match(client.htmlBody,/October &lt;review&gt;  New details/);assert.doesNotMatch(client.subject,/[\r\n]/);
  const [unbound]=buildEmail({...event,eventType:'update-notification'},{client:'c@example.invalid'},{context:{...bound,ok:false}});
  assert.equal(unbound.subject,'Workspace update');assert.ok(!unbound.body.includes(reply));
});
