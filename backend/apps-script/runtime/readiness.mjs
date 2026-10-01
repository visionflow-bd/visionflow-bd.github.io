import {validateConfig} from '../worker.mjs';

// Owner/editor diagnostic only. No writes, mail handoffs, trigger installation,
// authorization URLs or private document values may escape into this report.
export async function inspectRuntimeReadiness({config, firestore, scriptApp, session, mailApp, now=()=>new Date().toISOString()}) {
  const report={schemaVersion:1,checkedAt:now(),mode:'read-only',productionReady:false,checks:{},unverified:[
    'deployed-version-and-source-match','other-owners-triggers','trigger-schedule-and-execution',
    'firestore-write-authorization','deployed-security-rules','complete-migration',
    'inbox-delivery','sender-routing','external-file-permissions','user-acceptance',
  ]};
  const checks=report.checks;
  const valid=validateConfig(config).valid&&/^[a-z][a-z0-9-]{4,62}$/.test(config?.projectId||'');
  checks.configuration={status:valid?'pass':'fail',workerEnabled:config?.enabled===true,reviewEnabled:config?.reviewStateReady===true};
  try {
    const required=scriptApp.AuthorizationStatus?.REQUIRED,granted=scriptApp.AuthorizationStatus?.NOT_REQUIRED;
    const status=scriptApp.getAuthorizationInfo(scriptApp.AuthMode.FULL).getAuthorizationStatus();
    checks.authorization={status:granted!==undefined&&status===granted?'pass':required!==undefined&&status===required?'fail':'unknown'};
  } catch { checks.authorization={status:'unknown'}; }
  try {
    const normalize=value=>typeof value==='string'?value.trim().toLowerCase():'';
    const expected=normalize(config?.expectedSender),effective=normalize(session.getEffectiveUser().getEmail());
    const email=value=>/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value);
    checks.senderIdentity={status:email(expected)&&email(effective)?expected===effective?'pass':'fail':'unknown',expectedConfigured:email(expected),effectiveIdentityAvailable:email(effective)};
  } catch { checks.senderIdentity={status:'unknown',expectedConfigured:false,effectiveIdentityAvailable:false}; }
  try {
    const triggers=scriptApp.getProjectTriggers();
    if(!Array.isArray(triggers))throw Error('Invalid trigger inventory.');
    const matches=triggers.filter(trigger=>trigger.getHandlerFunction()==='scheduledWorker');
    const clockType=scriptApp.EventType?.CLOCK;
    const isClock=matches.length===1&&clockType!==undefined&&matches[0].getEventType()===clockType;
    checks.ownedTriggers={status:isClock?'pass':'fail',total:triggers.length,workerCount:matches.length,scope:'current-user-only',scheduleVerified:false};
  } catch { checks.ownedTriggers={status:'unknown',scope:'current-user-only',scheduleVerified:false}; }
  try {
    const quota=mailApp.getRemainingDailyQuota();
    if(!Number.isSafeInteger(quota)||quota<0)throw Error('Invalid quota.');
    checks.mailQuota={status:quota>0?'pass':'fail',remainingRecipients:quota,inboxDeliveryVerified:false};
  } catch { checks.mailQuota={status:'unknown',inboxDeliveryVerified:false}; }
  const inspectRead=async(key,read,summarize)=>{
    if(!valid){checks[key]={status:'not-run'};return;}
    try {checks[key]={status:'pass',...summarize(await read())};}
    catch(error) {
      // Status codes aid owner diagnosis without exposing provider bodies,
      // document contents, OAuth tokens or arbitrary exception messages.
      checks[key]={status:'fail'};
      if(Number.isInteger(error?.httpCode)&&error.httpCode>=400&&error.httpCode<=599)checks[key].httpCode=error.httpCode;
      if(['IAM_PERMISSION_DENIED','ACCESS_TOKEN_SCOPE_INSUFFICIENT','SERVICE_DISABLED','CONSUMER_INVALID'].includes(error?.reason))checks[key].reason=error.reason;
    }
  };
  await inspectRead('recovery',()=>firestore.get('portal_settings/recovery'),value=>({active:value?.active===true}));
  await inspectRead('notifications',()=>firestore.get('portal_settings/notifications'),value=>({exists:!!value,schemaVersion:Number.isSafeInteger(value?.schemaVersion)?value.schemaVersion:null,enabled:value?.enabled===true}));
  for(const collection of ['portal_clients','portal_public','portal_outbox','portal_reviews']) {
    await inspectRead(collection,()=>firestore.query(collection,{orderBy:['__name__','asc'],limit:1}),value=>{
      if(!Array.isArray(value))throw Error('Invalid query response.');
      return {sampleCount:value.length,fullInventory:false};
    });
  }
  // A successful GET/empty query is deliberately not labelled write, migration,
  // sender-routing or production readiness. Enabling remains a separate action.
  report.readChecksPassed=['recovery','notifications','portal_clients','portal_public','portal_outbox','portal_reviews'].every(key=>checks[key].status==='pass');
  return report;
}
