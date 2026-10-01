import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {inspectRuntimeReadiness} from '../../../backend/apps-script/runtime/readiness.mjs';
import {loadConfig} from '../../../backend/apps-script/runtime/adapters.mjs';

function fixture() {
  const calls=[];
  return {calls,config:{projectId:'demo-runtime',adminUid:'private-admin',activationBoundary:'2026-09-30T00:00:00Z',expectedSender:'owner@example.invalid'},
    now:()=> '2026-09-30T00:00:00Z',
    scriptApp:{AuthMode:{FULL:'full'},AuthorizationStatus:{REQUIRED:'required',NOT_REQUIRED:'granted'},EventType:{CLOCK:'clock'},
      getAuthorizationInfo:()=>({getAuthorizationStatus:()=> 'granted'}),
      getProjectTriggers:()=>[{getHandlerFunction:()=> 'scheduledWorker',getEventType:()=> 'clock'}],
      getOAuthToken:()=>assert.fail('diagnostic must not read a token directly'),newTrigger:()=>assert.fail('no trigger creation')},
    session:{getEffectiveUser:()=>({getEmail:()=> 'owner@example.invalid'})},
    mailApp:{getRemainingDailyQuota:()=>7,sendEmail:()=>assert.fail('no mail')},
    firestore:{get:async path=>{calls.push(path);return {enabled:true,schemaVersion:2,secret:'private-record'};},query:async(path,options)=>{calls.push(path);assert.deepEqual(JSON.parse(JSON.stringify(options)),{orderBy:['__name__','asc'],limit:1});return [{id:'private-id',secret:'private-record'}];},
      set:()=>assert.fail('no database writes'),runTransaction:()=>assert.fail('no transactions')},
  };
}
test('owner diagnostic is bounded, read-only and never certifies a deployment',async()=>{
  const deps=fixture(),report=await inspectRuntimeReadiness(deps);
  assert.equal(report.productionReady,false);assert.equal(report.readChecksPassed,true);
  assert.equal(report.checks.senderIdentity.status,'pass');assert.equal(report.checks.ownedTriggers.status,'pass');
  assert.equal(report.checks.ownedTriggers.scheduleVerified,false);assert.equal(report.checks.mailQuota.remainingRecipients,7);
  assert.equal(deps.calls.length,6);assert.ok(report.unverified.includes('firestore-write-authorization'));
  assert.doesNotMatch(JSON.stringify(report),/private-record|private-id|private-admin|owner@example/);
});
test('invalid configuration performs no Firestore reads',async()=>{
  for(const config of [null,{}, {...fixture().config,projectId:'../wrong'}, {...fixture().config,activationBoundary:'invalid'}]){
    const deps=fixture();deps.config=config;const result=await inspectRuntimeReadiness(deps);
    assert.equal(result.checks.configuration.status,'fail');assert.equal(result.readChecksPassed,false);assert.equal(deps.calls.length,0);
  }
});
test('disabled configuration remains disabled and still supports owner preflight',async()=>{
  const deps=fixture(),before=JSON.stringify(deps.config),result=await inspectRuntimeReadiness(deps);
  assert.equal(result.checks.configuration.workerEnabled,false);assert.equal(result.checks.configuration.reviewEnabled,false);
  assert.equal(result.readChecksPassed,true);assert.equal(JSON.stringify(deps.config),before);
});
test('sender identity is unknown unless both expected and effective identities are known',async()=>{
  for(const [expected,effective,status] of [['','owner@example.invalid','unknown'],['owner@example.invalid','','unknown'],['wrong@example.invalid','owner@example.invalid','fail'],[' OWNER@EXAMPLE.INVALID ','owner@example.invalid','pass'],['a@b.invalid\ncc:bad','owner@example.invalid','unknown']]){
    const deps=fixture();deps.config.expectedSender=expected;deps.session.getEffectiveUser=()=>({getEmail:()=>effective});
    assert.equal((await inspectRuntimeReadiness(deps)).checks.senderIdentity.status,status);
  }
});
test('trigger check detects duplicates/wrong type and does not claim other-owner coverage',async()=>{
  for(const [triggers,status] of [[[],'fail'],[[{getHandlerFunction:()=> 'scheduledWorker',getEventType:()=> 'edit'}],'fail'],[[1,2].map(()=>({getHandlerFunction:()=> 'scheduledWorker',getEventType:()=> 'clock'})),'fail']]){
    const deps=fixture();deps.scriptApp.getProjectTriggers=()=>triggers;
    const result=(await inspectRuntimeReadiness(deps)).checks.ownedTriggers;
    assert.equal(result.status,status);assert.equal(result.scope,'current-user-only');
  }
});
test('required or unavailable authorization does not claim successful consent',async()=>{
  for(const [value,status] of [['required','fail'],['unexpected','unknown'],[undefined,'unknown']]){
    const deps=fixture();deps.scriptApp.getAuthorizationInfo=()=>({getAuthorizationStatus:()=>value});
    assert.equal((await inspectRuntimeReadiness(deps)).checks.authorization.status,status);
  }
});
test('zero and malformed quotas are not delivery evidence',async()=>{
  for(const [quota,status] of [[0,'fail'],[-1,'unknown'],['7','unknown'],[NaN,'unknown']]){
    const deps=fixture();deps.mailApp.getRemainingDailyQuota=()=>quota;
    const result=(await inspectRuntimeReadiness(deps)).checks.mailQuota;
    assert.equal(result.status,status);assert.equal(result.inboxDeliveryVerified,false);
  }
});
test('exceptions never leak private provider details and remaining probes still run',async()=>{
  const deps=fixture(),fail=()=>{throw Error('private-token private-record');};
  deps.scriptApp.getAuthorizationInfo=fail;deps.scriptApp.getProjectTriggers=fail;deps.session.getEffectiveUser=fail;deps.mailApp.getRemainingDailyQuota=fail;
  deps.firestore.get=fail;const report=await inspectRuntimeReadiness(deps);
  assert.equal(report.readChecksPassed,false);assert.equal(report.checks.portal_reviews.status,'pass');
  assert.doesNotMatch(JSON.stringify(report),/private-token|private-record/);
});
test('empty collections and missing settings are not mistaken for completed migration',async()=>{
  const deps=fixture();deps.firestore.get=async()=>null;deps.firestore.query=async()=>[];
  const report=await inspectRuntimeReadiness(deps);
  assert.equal(report.checks.notifications.exists,false);assert.equal(report.checks.notifications.enabled,false);
  assert.equal(report.checks.portal_public.sampleCount,0);assert.equal(report.checks.portal_public.fullInventory,false);
  assert.equal(report.productionReady,false);
});

test('failed read exposes only a bounded numeric HTTP code, never its provider body',async()=>{
  for(const code of [403,503,'private-token',200,999]){
    const deps=fixture();deps.firestore.get=async()=>{throw Object.assign(Error('private-token private-record'),{httpCode:code,body:'secret'});};
    const report=await inspectRuntimeReadiness(deps);
    assert.equal(report.checks.recovery.httpCode,[403,503].includes(code)?code:undefined);
    assert.equal(report.readChecksPassed,false);assert.doesNotMatch(JSON.stringify(report),/private-token|private-record|secret/);
  }
});

test('readiness report keeps fixed failure reasons but rejects arbitrary reason text',async()=>{
  for(const reason of ['IAM_PERMISSION_DENIED','SERVICE_DISABLED','private-token']){
    const deps=fixture();deps.firestore.get=async()=>{throw Object.assign(Error('private-record'),{httpCode:403,reason});};
    const report=await inspectRuntimeReadiness(deps);
    assert.equal(report.checks.recovery.reason,reason==='private-token'?undefined:reason);
    assert.doesNotMatch(JSON.stringify(report),/private-token|private-record/);
  }
});
test('built owner entrypoint logs only sanitized diagnostics and is not public',async()=>{
  const deps=fixture(),logs=[];
  const context={Session:deps.session,ScriptApp:deps.scriptApp,MailApp:deps.mailApp,UrlFetchApp:{},Logger:{log:value=>logs.push(value)},PropertiesService:{getScriptProperties:()=>({getProperties:()=>({}),getProperty:()=>''})},ContentService:{MimeType:{JSON:'json'},createTextOutput:body=>({body,setMimeType(){return this;}})}};
  runInNewContext(readFileSync('backend/apps-script/runtime/Code.gs','utf8'),context);
  context.loadConfig_runtime=()=>deps.config;context.createFirestoreAdapter_runtime=()=>deps.firestore;
  const result=await context.ownerReadinessCheck();assert.equal(result.productionReady,false);assert.equal(logs.length,1);
  assert.equal(JSON.parse(logs[0]).readChecksPassed,true);
  const reads=deps.calls.length;
  assert.equal(JSON.parse(context.doPost({postData:{contents:'{"action":"ownerReadinessCheck"}'}}).body).ok,false);
  assert.equal(JSON.parse(context.doGet({parameter:{action:'ownerReadinessCheck'}}).body).status,'healthy');
  assert.equal(deps.calls.length,reads);assert.equal(logs.length,1);
});
test('expected sender remains diagnostic-only and required identity scope is declared locally',()=>{
  const props={EXPECTED_SENDER:'owner@example.invalid'},config=loadConfig({propertiesService:{getScriptProperties:()=>({getProperties:()=>props})}});
  assert.equal(config.expectedSender,props.EXPECTED_SENDER);assert.equal(config.enabled,false);
  const manifest=JSON.parse(readFileSync('backend/apps-script/appsscript.json','utf8'));
  assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/userinfo.email'));
});
