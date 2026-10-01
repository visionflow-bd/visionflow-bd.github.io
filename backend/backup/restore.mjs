import {fingerprint,stable,validateBackup,documentPath,validFields} from './snapshot.mjs';
import {planSecureMigration} from '../../portal/migration.js';
import {fromFirestoreValue as decode,toFirestoreValue as encode} from '../apps-script/runtime/adapters.mjs';
const copy=value=>JSON.parse(JSON.stringify(value));
const fieldsObject=fields=>decode({mapValue:{fields:fields||{}}});
const pausedReview=new Set(['pending','blocked','awaiting-notification','awaiting-review-notification']);
const completedMail=new Set(['sent','sent-unconfirmed','sent-partial','deduplicated','skipped-pre-activation']);
const immutable=path=>/^portal_public\/[^/]+\/(sigs|confirms|feedback|consent|agreements|acknowledgements|attachments)\//.test(path)||path.startsWith('portal_backend_events/')||path.startsWith('portal_archives/');

function quarantine(path,fields,at){
  const result=copy(fields);
  if(/^portal_clients\/[^/]+$/.test(path))result.accessEnabled=encode(false);
  if(/^portal_public\/[^/]+$/.test(path))result.enabled=encode(false);
  if(path==='portal_settings/notifications')result.enabled=encode(false);
  if(path.startsWith('portal_outbox/')&&!completedMail.has(result.status?.stringValue)){
    result.status=encode('needs-reconciliation');result.recoveryReason=encode('restored-no-automatic-resend');
    delete result.leasedBy;delete result.leasedUntil;delete result.nextRetryAfter;
  }
  if((path.startsWith('portal_reviews/')||/^portal_public\/[^/]+\/reviews\//.test(path))&&pausedReview.has(result.status?.stringValue)){
    result.status=encode('cancelled');result.cancelledAt=encode(at);result.cancellationReason=encode('backup-restored');
  }
  return result;
}
function desiredDocuments(backup){
  const desired=new Map(backup.documents.map(d=>[d.name,copy(d)])),at=backup.readTime;
  for(const document of backup.documents){
    const path=documentPath(document.name,backup.database);
    if(path==='portal_settings/recovery'||path.startsWith('portal_backend_state/')){desired.delete(document.name);continue;}
    desired.get(document.name).fields=quarantine(path,document.fields||{},at);
  }
  for(const document of [...desired.values()]){
    const relative=documentPath(document.name,backup.database);if(!/^portal_clients\/[^/]+$/.test(relative))continue;
    const client=fieldsObject(document.fields),publicName=`${backup.database}/documents/portal_public/${client.accessToken}`;
    if(!client.accessToken)continue;
    const previous=desired.get(publicName);
    // Retain interrupted v7 recovery jobs exactly (and paused) for their own
    // resume logic. Legacy snapshots must be rebuilt through secure migration.
    if(previous?.fields?.portalVersion?.integerValue==='7')continue;
    const manifests=[...desired.values()].filter(d=>d.name.startsWith(publicName+'/deliveries/'));
    const migrated=planSecureMigration(document,previous,{decode,encode,now:at,deliveryDocuments:manifests});
    for(const write of migrated.writes)desired.set(write.update.name,{...write.update,updateTime:at});
  }
  const settings=`${backup.database}/documents/portal_settings/notifications`;
  if(!desired.has(settings))desired.set(settings,{name:settings,fields:{enabled:encode(false)},updateTime:at});
  return desired;
}
export async function planRestore(backup,current,{replacePaths=[]}={}){
  await validateBackup(backup);await validateBackup(current,{database:backup.database});
  if(!Array.isArray(replacePaths)||new Set(replacePaths).size!==replacePaths.length)throw Error('Invalid replacement choices.');
  const replacements=new Set(replacePaths),live=new Map(current.documents.map(d=>[d.name,d])),desired=desiredDocuments(backup),conflicts=[],operations=[],safetyOnly=new Set(),sourceTokens=new Map();
  // Recovery must invalidate old drafts/timers, even when a later owner resumes
  // sharing. Never rewind concurrency revisions to an older backup's number.
  for(const [name,target] of desired){
    if(!/^portal_clients\/[^/]+$/.test(documentPath(name,backup.database)))continue;
    const before=live.get(name);
    for(const key of ['_revision','reviewEpoch']){
      const values=[target.fields[key],before?.fields?.[key]].map(v=>v===undefined?0:Number(v.integerValue));
      if(values.some(v=>!Number.isSafeInteger(v)||v<0)||Math.max(...values)>=Number.MAX_SAFE_INTEGER)throw Error('Invalid concurrency revision requires manual reconciliation.');
      target.fields[key]=encode(Math.max(...values)+1);
    }
    target.fields._lastMutationId=encode(`restore-${backup.digest.slice(0,16)}-${current.digest.slice(0,16)}`);
    const token=target.fields.accessToken?.stringValue,portal=token?desired.get(`${backup.database}/documents/portal_public/${token}`):null;
    if(token){if(sourceTokens.has(token))throw Error('Backup has shared client tokens; reconcile ownership before recovery.');sourceTokens.set(token,name);}
    if(portal)portal.fields.reviewEpoch=copy(target.fields.reviewEpoch);
    const slug=name.split('/').at(-1),currentToken=before?.fields?.accessToken?.stringValue;
    for(const doc of current.documents){
      const relative=documentPath(doc.name,backup.database);
      if(!/^portal_public\/[^/]+$/.test(relative)||desired.has(doc.name))continue;
      if(doc.fields?.clientSlug?.stringValue!==slug&&relative!==`portal_public/${currentToken}`)continue;
      desired.set(doc.name,{...copy(doc),fields:quarantine(relative,doc.fields,backup.readTime)});safetyOnly.add(doc.name);
    }
  }
  for(const document of current.documents){
    if(!/^portal_clients\/[^/]+$/.test(documentPath(document.name,current.database)))continue;
    const owner=sourceTokens.get(document.fields?.accessToken?.stringValue);
    if(owner&&owner!==document.name)throw Error('A restored token belongs to another current client. Reconcile ownership first.');
  }
  for(const [name,target] of desired){
    const path=documentPath(name,backup.database),before=live.get(name)||null;
    let after=target.fields;
    // Preserve current worker evidence and settings; never rewind a sent log,
    // queue outcome, or an unknown current recipient configuration.
    if(before&&(path.startsWith('portal_outbox/')||path.startsWith('portal_backend_events/')||path==='portal_settings/notifications'))after=quarantine(path,before.fields,backup.readTime);
    if(before&&stable(before.fields||{})===stable(after||{}))continue;
    const original=backup.documents.find(d=>d.name===name);
    const unchangedSource=before&&original&&stable(before.fields||{})===stable(original.fields||{});
    if(before&&!unchangedSource&&!safetyOnly.has(name)&&path!=='portal_settings/notifications'&&!path.startsWith('portal_outbox/')){
      const protectedEvidence=immutable(path);
      if(protectedEvidence||!replacements.has(path)){conflicts.push({path,reason:protectedEvidence?'immutable-newer-evidence':'explicit-replacement-required'});continue;}
    }
    validFields(after);
    operations.push({name,before,after});
  }
  for(const path of replacements)if(!desired.has(`${backup.database}/documents/${path}`)||immutable(path))throw Error('Replacement choice is absent or protected evidence.');
  const body={format:'visionflow-restore-plan',version:1,database:backup.database,sourceDigest:backup.digest,currentDigest:current.digest,
    plannedAt:new Date().toISOString(),sourceReadTime:backup.readTime,conflicts,
    safety:{sharing:'paused',email:'disabled',restoredQueues:'manual-reconciliation',oldReviews:'cancelled',deleteUnlisted:false},
    retainedCurrentDocuments:current.documents.filter(d=>!desired.has(d.name)).length,
    operations:operations.sort((a,b)=>a.name.localeCompare(b.name))};
  return {...body,digest:await fingerprint(body)};
}
export async function validatePlan(plan){
  if(plan?.format!=='visionflow-restore-plan'||plan.version!==1||!Array.isArray(plan.operations)||!Array.isArray(plan.conflicts))throw Error('Unsupported restore plan.');
  const {digest,...body}=plan;if(await fingerprint(body)!==digest)throw Error('Restore plan checksum changed.');
  if(plan.conflicts.length)throw Error('Unresolved restore conflicts. No data was written.');
  const names=new Set();
  for(const op of plan.operations){
    const path=documentPath(op.name,plan.database);
    if(names.has(op.name)||path==='portal_settings/recovery'||path.startsWith('portal_backend_state/'))throw Error('Invalid restore target.');names.add(op.name);
    validFields(op.after);if(op.before){if(op.before.name!==op.name||!op.before.updateTime)throw Error('Missing restore precondition.');validFields(op.before.fields||{});}
  }
  return plan;
}
export async function recoveryReady(adapter,operationId){
  const lock=await adapter.get(`${adapter.database}/documents/portal_settings/recovery`);
  const data=fieldsObject(lock?.fields),serverTime=await adapter.readTime();
  if(data.active!==true||data.operationId!==operationId||data.gatesVerified!==true||!lock.updateTime)throw Error('A verified recovery lock for this operation is required.');
  if(!data.startedAt?.toMillis||Date.parse(serverTime)-data.startedAt.toMillis()<600000)throw Error('Wait at least ten server-timed minutes for in-flight workers to stop before restoring.');
  const outbox=await adapter.documents('portal_outbox',serverTime);
  if(outbox.some(d=>['sending','processing'].includes(d.fields?.status?.stringValue)))throw Error('An in-flight or uncertain send requires manual reconciliation before recovery.');
  return lock;
}
function batches(operations){
  const result=[];let group=[],bytes=0;
  for(const op of operations){const size=new TextEncoder().encode(JSON.stringify(op)).byteLength;if(size>7000000)throw Error('Restore document exceeds the batch budget.');
    if(group.length>=100||bytes+size>7000000){result.push(group);group=[];bytes=0;}group.push(op);bytes+=size;}
  if(group.length)result.push(group);return result;
}
// Journal writes MUST be durable before/after each commit. No blind retry after
// transport ambiguity; the retained plan + journal allow manual reconciliation.
export async function applyRestore(plan,{adapter,journal,operationId}){
  await validatePlan(plan);if(plan.database!==adapter.database)throw Error('Restore target database mismatch.');
  const lock=await recoveryReady(adapter,operationId);
  // Preflight every target before the first mutation, then exact-version CAS
  // also protects each individual commit from IAM writers outside portal rules.
  for(const op of plan.operations){const current=await adapter.get(op.name);if((current?.updateTime||null)!==(op.before?.updateTime||null))throw Error('Target changed since planning. Re-export and review a new plan.');}
  await journal.start({planDigest:plan.digest,database:plan.database,operationId,lockUpdateTime:lock.updateTime});
  let index=0;
  for(const group of batches(plan.operations)){
    const prior=await adapter.get(lock.name);if(prior?.updateTime!==lock.updateTime)throw Error('Recovery lock changed. Stop and inspect the journal.');
    const writes=group.map(op=>({update:{name:op.name,fields:op.after},currentDocument:op.before?{updateTime:op.before.updateTime}:{exists:false}}));
    writes.push({update:{name:lock.name,fields:lock.fields},currentDocument:{updateTime:lock.updateTime}});
    await journal.prepare(index,{names:group.map(op=>op.name)});
    const result=await adapter.commit(writes);
    if(result.writeResults?.length!==group.length+1||result.writeResults.some(r=>!r.updateTime))throw Error('Commit result is uncertain. Inspect the journal before continuing.');
    lock.updateTime=result.writeResults.at(-1).updateTime;
    await journal.commit(index,{lockUpdateTime:lock.updateTime,documents:group.map((op,i)=>({name:op.name,updateTime:result.writeResults[i].updateTime}))});index++;
  }
  for(const op of plan.operations){const current=await adapter.get(op.name);if(!current||stable(current.fields||{})!==stable(op.after))throw Error('Post-restore verification failed. Keep maintenance enabled.');}
  if((await adapter.get(lock.name))?.updateTime!==lock.updateTime)throw Error('Recovery lock changed during verification.');
  await journal.complete({batches:index,documents:plan.operations.length});
  return {verified:true,documents:plan.operations.length,maintenanceActive:true};
}
export async function rollbackRestore(plan,committed,{adapter,journal,operationId}){
  await validatePlan(plan);if(plan.database!==adapter.database)throw Error('Rollback database mismatch.');
  const lock=await recoveryReady(adapter,operationId);
  const byName=new Map(plan.operations.map(op=>[op.name,op])),seen=new Set(),operations=[];
  for(const record of committed){const op=byName.get(record.name);if(!op||seen.has(record.name)||!record.updateTime)throw Error('Invalid rollback journal.');seen.add(record.name);
    const current=await adapter.get(op.name);if(current?.updateTime!==record.updateTime||stable(current?.fields||{})!==stable(op.after))throw Error('A restored target has newer data. Rollback must not overwrite it.');
    operations.push({op,updateTime:record.updateTime});}
  await journal.start({planDigest:plan.digest,database:plan.database,operationId,rollback:true});let index=0;
  for(const group of batches(operations)){
    if((await adapter.get(lock.name))?.updateTime!==lock.updateTime)throw Error('Recovery lock changed. Keep maintenance enabled and inspect the rollback journal.');
    const writes=group.map(({op,updateTime})=>op.before?{update:{name:op.name,fields:op.before.fields||{}},currentDocument:{updateTime}}:{delete:op.name,currentDocument:{updateTime}});
    writes.push({update:{name:lock.name,fields:lock.fields},currentDocument:{updateTime:lock.updateTime}});
    await journal.prepare(index,{names:group.map(({op})=>op.name)});
    const result=await adapter.commit(writes);
    if(result.writeResults?.length!==group.length+1||!result.writeResults.at(-1).updateTime)throw Error('Rollback commit is uncertain. Inspect the journal.');
    lock.updateTime=result.writeResults.at(-1).updateTime;
    await journal.commit(index,{commitTime:result.commitTime,lockUpdateTime:lock.updateTime});index++;
  }
  for(const {op} of operations){const current=await adapter.get(op.name);if(op.before?stable(current?.fields)!==stable(op.before.fields):current!==null)throw Error('Rollback verification failed. Keep maintenance enabled.');}
  if((await adapter.get(lock.name))?.updateTime!==lock.updateTime)throw Error('Recovery lock changed during rollback verification.');
  await journal.complete({batches:index,documents:operations.length});return {verified:true,documents:operations.length,maintenanceActive:true};
}
