import {test} from 'node:test';
import assert from 'node:assert/strict';
import {exportSnapshot,validateBackup,fingerprint,stable} from '../backend/backup/snapshot.mjs';
import {planRestore,applyRestore,rollbackRestore} from '../backend/backup/restore.mjs';
import {createBackupRest} from '../backend/backup/rest.mjs';
import {toFirestoreValue as encode} from '../backend/apps-script/runtime/adapters.mjs';
import {mkdtemp,readdir,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileJournal,writePrivateJson,readCommittedJournal} from '../backend/backup/journal.mjs';
const database='projects/demo-backup/databases/(default)',root=database+'/documents/',at='2026-09-30T12:00:00.123456Z';
const fields={time:{timestampValue:'2026-09-29T12:13:14.123456789Z'},integer:{integerValue:'9223372036854775807'},binary:{bytesValue:'AAE='},point:{geoPointValue:{latitude:23,longitude:90}},ref:{referenceValue:root+'x/y'},number:{doubleValue:'NaN'},string:{stringValue:'2026-09-30T00:00:00Z'},nested:{mapValue:{fields:{time:{stringValue:'not-a-timestamp'},array:{arrayValue:{values:[{nullValue:null},{booleanValue:true}]}}}}}};
function fixture(initial={}){
  const docs=new Map(Object.entries(initial).map(([path,fields])=>[root+path,{name:root+path,fields:structuredClone(fields),createTime:at,updateTime:at}]));
  const readTimes=[],commits=[];let sequence=0;
  const adapter={database,readTime:async()=> '2026-09-30T12:20:00Z',
    collectionIds:async(parent,time)=>{readTimes.push(time);const prefix=root+(parent?parent+'/':'');return [...new Set([...docs.keys()].filter(n=>n.startsWith(prefix)).map(n=>n.slice(prefix.length).split('/')[0]))];},
    documents:async(collection,time)=>{readTimes.push(time);const prefix=root+collection+'/',found=new Map();for(const [name,doc]of docs){if(!name.startsWith(prefix))continue;const rest=name.slice(prefix.length),first=rest.split('/')[0],parent=prefix+first;found.set(parent,docs.get(parent)||{name:parent});}return [...found.values()];},
    get:async name=>structuredClone(docs.get(name)||null),
    commit:async writes=>{
      for(const w of writes){const current=docs.get(w.update?.name||w.delete);if(w.currentDocument.exists===false?!!current:current?.updateTime!==w.currentDocument.updateTime)throw Error('conflict');}
      const commitTime=`2026-09-30T12:21:00.${String(++sequence).padStart(6,'0')}Z`;
      for(const w of writes){if(w.delete)docs.delete(w.delete);else docs.set(w.update.name,{...structuredClone(w.update),updateTime:commitTime});}
      commits.push(writes);return {commitTime,writeResults:writes.map(()=>({updateTime:commitTime}))};
    }};
  const journal={entries:[],start:async function(data){this.entries.push(['start',data]);},prepare:async function(index,data){this.entries.push(['prepare',index,data]);},commit:async function(index,data){this.entries.push(['commit',index,data]);},complete:async function(data){this.entries.push(['complete',data]);}};
  const lock=()=>docs.set(root+'portal_settings/recovery',{name:root+'portal_settings/recovery',updateTime:at,fields:{active:{booleanValue:true},operationId:{stringValue:'restore-test'},gatesVerified:{booleanValue:true},startedAt:{timestampValue:at}}});
  return {docs,readTimes,commits,adapter,journal,lock,snapshot:()=>exportSnapshot(adapter)};
}
test('full snapshot traverses unknown collections and missing parents, preserving every Firestore wire type',async()=>{
  const f=fixture({'custom/orphan/deep/evidence':fields,'portal_clients/c':{name:{stringValue:'Synthetic'}}});
  const backup=await f.snapshot(),roundTrip=JSON.parse(JSON.stringify(backup));await validateBackup(roundTrip);
  assert.deepEqual(backup.documents.find(d=>d.name.endsWith('/evidence')).fields,fields);
  assert.deepEqual(backup.missingParents,[root+'custom/orphan']);
  assert.equal(new Set(f.readTimes).size,1);assert.equal(f.readTimes[0],backup.readTime);
  assert.deepEqual(backup.collections,['custom','custom/orphan/deep','portal_clients']);
});
test('partial/oversized/tampered exports and foreign targets fail closed',async()=>{
  const f=fixture({'custom/a':fields});await assert.rejects(exportSnapshot(f.adapter,{maxBytes:1}),/limit/);
  const backup=await f.snapshot();backup.documents[0].fields.secret={stringValue:'changed'};await assert.rejects(validateBackup(backup),/checksum/);
  const g=fixture({'custom/a':fields});g.adapter.collectionIds=async()=>{throw Error('403');};await assert.rejects(g.snapshot(),/403/);
  await assert.rejects(validateBackup(await f.snapshot(),{database:'projects/foreign/databases/(default)'}),/different/);
});
test('restore migrates legacy public snapshots with paused sharing and preserves financial/wire evidence',async()=>{
  const client=encode({name:'Client',accessToken:'token',projects:{p:{name:'Project',rate:400,budget:40000,items:[{n:1,s:'delivered',dl:'https://private.invalid/final'}]}}}).mapValue.fields;
  client.evidence=fields.time;
  const source=fixture({'portal_clients/c':client,'portal_public/token':encode({portalVersion:5,enabled:true,raw:'https://private.invalid/final'}).mapValue.fields});
  const plan=await planRestore(await source.snapshot(),await fixture().snapshot());
  assert.deepEqual(plan.conflicts,[]);const publicDoc=plan.operations.find(o=>o.name===root+'portal_public/token'),privateDoc=plan.operations.find(o=>o.name===root+'portal_clients/c');
  assert.equal(publicDoc.after.portalVersion.integerValue,'7');assert.equal(publicDoc.after.enabled.booleanValue,false);
  assert.equal(JSON.stringify(publicDoc).includes('private.invalid'),false);
  assert.deepEqual(privateDoc.after.evidence,fields.time);assert.equal(privateDoc.after.projects.mapValue.fields.p.mapValue.fields.rate.integerValue,'400');
  assert.equal(privateDoc.after.accessEnabled.booleanValue,false);
  assert.ok(plan.operations.some(o=>o.name===root+'portal_public/token/deliveries/p'));
});
test('restore cancels old review windows, quarantines pending email, retains sent evidence and current-only data',async()=>{
  const backup=await fixture({'portal_outbox/new':{status:{stringValue:'queued'},leasedBy:{stringValue:'old'}},'portal_outbox/sent':{status:{stringValue:'queued'}},'portal_reviews/r':{status:{stringValue:'pending'}},'portal_backend_state/cursor':{lastId:{stringValue:'old'}}}).snapshot();
  const current=await fixture({'portal_outbox/sent':{status:{stringValue:'sent-unconfirmed'},recipientClient:{stringValue:'private@example.invalid'}},'newer/data':fields}).snapshot();
  const plan=await planRestore(backup,current);assert.equal(plan.conflicts.length,0);
  assert.equal(plan.operations.find(o=>o.name===root+'portal_outbox/new').after.status.stringValue,'needs-reconciliation');
  assert.equal(plan.operations.some(o=>o.name===root+'portal_outbox/sent'),false);
  assert.equal(plan.operations.find(o=>o.name===root+'portal_reviews/r').after.status.stringValue,'cancelled');
  assert.equal(plan.operations.some(o=>o.name.includes('portal_backend_state')),false);
  assert.equal(plan.operations.some(o=>o.name===root+'newer/data'),false);
});
test('newer immutable evidence is never replaced and business conflicts need an exact approved path',async()=>{
  const old=await fixture({'portal_public/t/confirms/id':fields,'site/main':{title:{stringValue:'Old'}}}).snapshot();
  const current=await fixture({'portal_public/t/confirms/id':{message:{stringValue:'New'}},'site/main':{title:{stringValue:'New'}}}).snapshot();
  assert.equal((await planRestore(old,current)).conflicts.length,2);
  const plan=await planRestore(old,current,{replacePaths:['site/main']});assert.deepEqual(plan.conflicts,[{path:'portal_public/t/confirms/id',reason:'immutable-newer-evidence'}]);
  await assert.rejects(planRestore(old,current,{replacePaths:['portal_public/t/confirms/id']}),/protected/);
});
test('recovery advances admin revisions and review epoch beyond both current and backup values',async()=>{
  const old=await fixture({'portal_clients/c':encode({name:'Old',_revision:2,reviewEpoch:1,accessToken:'t'}).mapValue.fields,'portal_public/t':encode({portalVersion:7,reviewEpoch:1,enabled:true}).mapValue.fields}).snapshot();
  const current=await fixture({'portal_clients/c':encode({name:'New',_revision:20,reviewEpoch:8,accessToken:'t'}).mapValue.fields,'portal_public/t':encode({portalVersion:7,reviewEpoch:8,enabled:true}).mapValue.fields}).snapshot();
  const plan=await planRestore(old,current,{replacePaths:['portal_clients/c','portal_public/t']});assert.equal(plan.conflicts.length,0);
  const client=plan.operations.find(o=>o.name===root+'portal_clients/c').after,portal=plan.operations.find(o=>o.name===root+'portal_public/t').after;
  assert.equal(client._revision.integerValue,'21');assert.equal(client.reviewEpoch.integerValue,'9');assert.equal(portal.reviewEpoch.integerValue,'9');
});
test('restoring a replaced token pauses current-only links and refuses cross-client token collisions',async()=>{
  const old=await fixture({'portal_clients/c':encode({name:'Old',accessToken:'old'}).mapValue.fields,'portal_public/old':encode({portalVersion:7,enabled:true,clientSlug:'c'}).mapValue.fields}).snapshot();
  const current=await fixture({'portal_clients/c':encode({name:'Current',accessToken:'new'}).mapValue.fields,'portal_public/new':encode({portalVersion:7,enabled:true,clientSlug:'c'}).mapValue.fields}).snapshot();
  const plan=await planRestore(old,current,{replacePaths:['portal_clients/c']});assert.equal(plan.conflicts.length,0);
  assert.equal(plan.operations.find(o=>o.name===root+'portal_public/new').after.enabled.booleanValue,false);
  const collision=await fixture({'portal_clients/other':encode({accessToken:'old'}).mapValue.fields}).snapshot();
  await assert.rejects(planRestore(old,collision),/another current client/);
});
test('apply and rollback use durable pre-commit journals, exact versions and byte-identical wire types',async()=>{
  const source=await fixture({'custom/doc':fields}).snapshot(),f=fixture();f.lock();
  const plan=await planRestore(source,await f.snapshot());
  const result=await applyRestore(plan,{...f,operationId:'restore-test'});assert.equal(result.verified,true);
  assert.deepEqual((await f.adapter.get(root+'custom/doc')).fields,fields);
  assert.equal(f.journal.entries[1][0],'prepare');assert.equal(f.journal.entries[2][0],'commit');
  const committed=f.journal.entries.filter(e=>e[0]==='commit').flatMap(e=>e[2].documents);
  await rollbackRestore(plan,committed,{...f,operationId:'restore-test'});
  assert.equal(await f.adapter.get(root+'custom/doc'),null);assert.equal((await f.adapter.get(root+'portal_settings/recovery')).fields.active.booleanValue,true);
});
test('changed targets, absent/young lock, uncertain commit and changed rollback target never silently continue',async()=>{
  const source=await fixture({'custom/doc':fields}).snapshot(),f=fixture();
  let plan=await planRestore(source,await f.snapshot());await assert.rejects(applyRestore(plan,{...f,operationId:'restore-test'}),/lock/);
  f.lock();f.docs.get(root+'portal_settings/recovery').fields.startedAt={timestampValue:'2026-09-30T12:19:59Z'};
  await assert.rejects(applyRestore(plan,{...f,operationId:'restore-test'}),/ten/);f.lock();
  f.docs.set(root+'custom/doc',{name:root+'custom/doc',fields,updateTime:at});await assert.rejects(applyRestore(plan,{...f,operationId:'restore-test'}),/changed/);assert.equal(f.commits.length,0);
  f.docs.delete(root+'custom/doc');const realCommit=f.adapter.commit;f.adapter.commit=async writes=>{await realCommit(writes);throw Error('uncertain transport');};
  await assert.rejects(applyRestore(plan,{...f,operationId:'restore-test'}),/uncertain/);assert.equal(f.journal.entries.at(-1)[0],'prepare');assert.equal(f.commits.length,1);
  f.adapter.commit=realCommit;
  await assert.rejects(rollbackRestore(plan,[{name:root+'custom/doc',updateTime:at}],{...f,operationId:'restore-test'}),/newer/);
});
test('REST backup is constrained, pages through exact read time and redacts provider errors',async()=>{
  assert.throws(()=>createBackupRest({projectId:'production',origin:'http://127.0.0.1:8088'}),/Only/);
  const calls=[],adapter=createBackupRest({projectId:'demo-backup',getToken:async()=> 'test-only',fetchImpl:async(url,options)=>{calls.push({url,options});const second=JSON.parse(options.body||'{}').pageToken;return {ok:true,json:async()=>second?{collectionIds:['last']}:{collectionIds:['first'],nextPageToken:'next'}};}});
  assert.deepEqual(await adapter.collectionIds('',at),['first','last']);
  for(const call of calls){assert.equal(JSON.parse(call.options.body).readTime,at);assert.equal(call.options.redirect,'error');}
  const failed=createBackupRest({projectId:'demo-backup',getToken:async()=> 'private-token',fetchImpl:async()=>({ok:false,status:403,text:async()=> 'SECRET'})});
  await assert.rejects(failed.get(root+'custom/doc'),error=>!error.message.includes('SECRET')&&!error.message.includes('private-token'));
});
test('maintenance unlock racing a batch rejects the entire restore commit',async()=>{
  const source=await fixture({'custom/doc':fields}).snapshot(),f=fixture();f.lock();
  const plan=await planRestore(source,await f.snapshot()),commit=f.adapter.commit;
  f.adapter.commit=async writes=>{f.docs.get(root+'portal_settings/recovery').updateTime='changed';return commit(writes);};
  await assert.rejects(applyRestore(plan,{...f,operationId:'restore-test'}),/conflict/);
  assert.equal(await f.adapter.get(root+'custom/doc'),null);
});
test('durable journal refuses overwrite, wrong plans and uncertain prepared batches',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'vf-backup-journal-')),target=path.join(directory,'journal'),plan={digest:'plan',database};
  try{
    const journal=fileJournal(target);await journal.start({planDigest:plan.digest,database,operationId:'test'});
    await journal.prepare(0,{names:[root+'custom/doc']});
    await assert.rejects(readCommittedJournal(target,plan),/uncertain/);
    await assert.rejects(journal.prepare(0,{}),/EEXIST/);
    await journal.commit(0,{documents:[{name:root+'custom/doc',updateTime:at}]});
    assert.equal((await readCommittedJournal(target,plan)).committed.length,1);
    await assert.rejects(readCommittedJournal(target,{...plan,digest:'other'}),/belong/);
    await journal.complete({documents:1});
  }finally{
    // Delete only this test's exact, enumerated files; no recursive Temp cleanup.
    for(const file of await readdir(target))await unlink(path.join(target,file));await rmdir(target);await rmdir(directory);
  }
});
