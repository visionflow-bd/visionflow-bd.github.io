import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyAdminToken,createOutboxEvent,claimEvents,processEvent,validateConfig} from '../../backend/apps-script/worker.mjs';
import {notificationEventId} from '../../backend/apps-script/source-binding.mjs';
import {normalizeClient,publicSnapshot,prepareSecureSave} from '../../portal/data.js';
const now='2026-10-01T12:00:00Z';
const clock={now:()=>now};
const config={enabled:true,projectId:'visionflow-bd',adminUid:'admin',activationBoundary:'2026-09-28T00:00:00Z',portalHost:'https://visionflow-bd.github.io'};
// Build a canonical consent-complete fixture with all required source records.
function canonicalConsent() {
  const c=normalizeClient({name:'Test',accessToken:'token',projects:{}},'client');
  prepareSecureSave(c);
  const p=publicSnapshot(c,'client');
  const sid=p.consentTerms.version;
  return {client:c,portal:p,sourceId:sid};
}
const cc=canonicalConsent();
const event=()=>createOutboxEvent({eventType:'consent-complete',clientSlug:'client',sourceCollection:'portal_public/token/consent',sourceId:cc.sourceId,sourceVersion:cc.sourceId,portalToken:'token',reviewEpoch:0,clock});
import {createFakeFirestore} from './fake-firestore.mjs';
const store=data=>createFakeFirestore({'portal_settings/notifications':{enabled:true},...data});

test('a fabricated JWT with matching claims is never authenticated',async()=>{
  const b64=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
  const token=b64({alg:'RS256',kid:'known'})+'.'+b64({sub:'admin',email:'owner@example.invalid',aud:'visionflow-bd',iss:'https://securetoken.google.com/visionflow-bd',iat:1,exp:9999999999})+'.forged';
  assert.equal(await verifyAdminToken(token,{config,fetchCerts:async()=>({known:'not-a-real-certificate'})}),null);
});
test('stable IDs are single Firestore document IDs, not nested collection paths',()=>{
  const e=event();assert.equal(e.id.includes('/'),false);assert.ok(e.id.length<1500);
  assert.notEqual(e.id,createOutboxEvent({eventType:'consent-complete',clientSlug:'client',sourceCollection:'portal_public/token/other',sourceId:'terms',sourceVersion:'v1',clock}).id);
});
test('retry backoff is enforced before claiming',async()=>{
  const e={...event(),status:'retry',nextRetryAfter:'2026-10-02T00:00:00Z'};
  const fs=store({['portal_outbox/'+e.id]:e});
  assert.deepEqual(await claimEvents({firestore:fs,clock,workerId:'w'}),[]);
});
test('deferred oldest events cannot starve a later ready notification',async()=>{
  const fs=store();
  for(let i=0;i<41;i++)await fs.set('portal_outbox/a-'+String(i).padStart(2,'0'),{status:'retry',retryCount:0,nextRetryAfter:'2026-11-01T00:00:00Z'});
  await fs.set('portal_outbox/z-ready',{status:'queued',retryCount:0,createdAt:now});
  assert.equal((await claimEvents({firestore:fs,clock,workerId:'first'})).length,0);
  const second=await claimEvents({firestore:fs,clock,workerId:'second'});assert.equal(second.length,1);assert.equal(second[0].id,'z-ready');
});
test('expired sending becomes reconciliation, never queued for another send',async()=>{
  const e={...event(),status:'sending',leasedBy:'dead',leasedUntil:'2026-10-01T11:00:00Z'};
  const fs=store({['portal_outbox/'+e.id]:e});
  assert.deepEqual(await claimEvents({firestore:fs,clock,workerId:'w'}),[]);
  assert.equal(fs.records['portal_outbox/'+e.id].status,'needs-reconciliation');
});
test('successful handoff remains terminal even when dedup log is absent',async()=>{
  const e={...event(),status:'sent-unconfirmed'};
  const fs=store({['portal_outbox/'+e.id]:e});
  assert.deepEqual(await claimEvents({firestore:fs,clock,workerId:'w'}),[]);
});
test('two simultaneous claims cannot both acquire one event',async()=>{
  const e=event(),fs=store({['portal_outbox/'+e.id]:e});
  const results=await Promise.all(['a','b'].map(workerId=>claimEvents({firestore:fs,clock,workerId})));
  assert.equal(results.flat().length,1);
});
test('notificationEventId has six components including projectKey',()=>{
  const id=notificationEventId({eventType:'delivery-notification',clientSlug:'c',sourceCollection:'portal_public/t/notices',sourceId:'n1',sourceVersion:'v1',projectKey:'p1'});
  const parts=JSON.parse(decodeURIComponent(id));
  assert.equal(parts.length,6);
  assert.deepEqual(parts,['delivery-notification','c','portal_public/t/notices','n1','v1','p1']);
});
test('invalid date and noncanonical mail CTA host fail configuration validation',()=>{
  assert.equal(validateConfig({...config,activationBoundary:'yesterday'}).valid,false);
  assert.equal(validateConfig({...config,portalHost:'https://evil.example'}).valid,false);
});
test('activation uses trusted configuration even if event omits its boundary',async()=>{
  const e={...event(),createdAt:'2020-01-01T00:00:00Z'};
  const fs=store({['portal_outbox/'+e.id]:e});let sent=0;
  const [claimed]=await claimEvents({firestore:fs,clock,workerId:'w'});
  const result=await processEvent(claimed,{firestore:fs,mail:{remainingQuota:async()=>100,send:async()=>sent++},clock,config});
  assert.equal(result.status,'skipped-pre-activation');assert.equal(sent,0);
});

test('expired or superseded owner cannot send even with an old claimed object',async()=>{
  const e=event(),fs=store({['portal_outbox/'+e.id]:e});
  const [claimed]=await claimEvents({firestore:fs,clock,workerId:'old'});
  await fs.set('portal_outbox/'+e.id,{leasedBy:'new'},{merge:true});
  const mail={remainingQuota:async()=>100,send:async()=>assert.fail('stale owner sent mail')};
  assert.equal((await processEvent(claimed,{firestore:fs,mail,clock,config})).status,'lease-lost');
  await fs.set('portal_outbox/'+e.id,{leasedBy:'old',leasedUntil:'2000-01-01T00:00:00Z'},{merge:true});
  assert.equal((await processEvent(claimed,{firestore:fs,mail,clock,config})).status,'lease-lost');
});

test('two executions holding the same lease cannot both send',async()=>{
  const e=event(),fs=store({['portal_outbox/'+e.id]:e,
    ['portal_public/token/consent/'+cc.sourceId]:{termsVersion:cc.sourceId,termsSnapshot:cc.portal.consentTerms,agreedAt:'2026-10-01T11:00:00Z'},
    'portal_clients/client':{...cc.client,email:'synthetic@example.invalid'},
    'portal_public/token':cc.portal,
  });
  const [claimed]=await claimEvents({firestore:fs,clock,workerId:'same'});let sends=0;
  const adapters={firestore:fs,clock,config,mail:{remainingQuota:async()=>100,send:async()=>sends++}};
  const results=await Promise.all([processEvent(claimed,adapters),processEvent(claimed,adapters)]);
  assert.equal(sends,1);assert.equal(results.filter(r=>r.status==='lease-lost').length,1);
});
test('maintenance acquired immediately before send authorization prevents provider handoff',async()=>{
  const e=event(),fs=store({['portal_outbox/'+e.id]:e,
    ['portal_public/token/consent/'+cc.sourceId]:{termsVersion:cc.sourceId,termsSnapshot:cc.portal.consentTerms,agreedAt:'2026-10-01T11:00:00Z'},
    'portal_clients/client':{...cc.client,email:'synthetic@example.invalid'},'portal_public/token':cc.portal});
  const [claimed]=await claimEvents({firestore:fs,clock,workerId:'same'});let sends=0;
  const result=await processEvent(claimed,{firestore:fs,clock,config,mail:{remainingQuota:async()=>{await fs.set('portal_settings/recovery',{active:true});return 100;},send:async()=>sends++}});
  assert.equal(result.status,'recovery-paused');assert.equal(sends,0);
});

test('crash after mail acceptance and before status commit never automatically resends',async()=>{
  const e=event(),fs=store({['portal_outbox/'+e.id]:e,
    ['portal_public/token/consent/'+cc.sourceId]:{termsVersion:cc.sourceId,termsSnapshot:cc.portal.consentTerms,agreedAt:'2026-10-01T11:00:00Z'},
    'portal_clients/client':{...cc.client,email:'synthetic@example.invalid'},
    'portal_public/token':cc.portal,
  });
  const set=fs.set;
  fs.set=async(p,v,o)=>{if(v.status==='sent-unconfirmed')throw Error('simulated connection loss');return set(p,v,o);};
  const [claimed]=await claimEvents({firestore:fs,clock,workerId:'crashes'});let sends=0;
  await processEvent(claimed,{firestore:fs,clock,config,mail:{remainingQuota:async()=>100,send:async()=>sends++}});
  assert.equal(fs.records['portal_outbox/'+e.id].status,'sending');
  const later={now:()=> '2026-10-01T12:06:00Z'};
  assert.deepEqual(await claimEvents({firestore:fs,clock:later,workerId:'recovery'}),[]);
  assert.equal(fs.records['portal_outbox/'+e.id].status,'needs-reconciliation');assert.equal(sends,1);
});

test('ambiguous provider error is not classified as a safe retry',async()=>{
  const e=event(),fs=store({['portal_outbox/'+e.id]:e,
    ['portal_public/token/consent/'+cc.sourceId]:{termsVersion:cc.sourceId,termsSnapshot:cc.portal.consentTerms,agreedAt:'2026-10-01T11:00:00Z'},
    'portal_clients/client':{...cc.client,email:'synthetic@example.invalid'},
    'portal_public/token':cc.portal,
  });
  const [claimed]=await claimEvents({firestore:fs,clock,workerId:'w'});
  const result=await processEvent(claimed,{firestore:fs,clock,config,mail:{remainingQuota:async()=>100,send:async()=>{throw Error('request timed out');}}});
  assert.equal(result.status,'needs-reconciliation');
  assert.deepEqual(await claimEvents({firestore:fs,clock:{now:()=> '2026-10-01T12:06:00Z'},workerId:'next'}),[]);
});
