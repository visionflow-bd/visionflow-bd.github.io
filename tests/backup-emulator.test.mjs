import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBackupRest} from '../backend/backup/rest.mjs';
import {exportSnapshot,validateBackup} from '../backend/backup/snapshot.mjs';
import {planRestore,applyRestore,rollbackRestore} from '../backend/backup/restore.mjs';
import {toFirestoreValue as encode} from '../backend/apps-script/runtime/adapters.mjs';

test('real REST full snapshot, paused restore, exact types and guarded rollback',{timeout:60000},async()=>{
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8088');
  // This emulator's GET query parser drops readTime and rejects ListDocuments
  // with an epoch timestamp. Keep production strict; omit only this unsupported
  // emulator parameter here. Unit tests assert forwarding, live export uses it.
  const emulatorFetch=(url,options)=>{const target=new URL(url);assert.equal(target.origin,'http://127.0.0.1:8088');target.searchParams.delete('readTime');return fetch(target,options);};
  const projectId='demo-visionflow-backup',adapter=createBackupRest({projectId,origin:'http://127.0.0.1:8088',getToken:async()=> 'owner',pageSize:1,fetchImpl:emulatorFetch}),root=adapter.database+'/documents/';
  const fields={...encode({name:'Synthetic backup record',nested:{label:'2026-09-30'},active:true}).mapValue.fields,time:{timestampValue:'2026-09-29T12:00:00.123456Z'},big:{integerValue:'9223372036854775807'},bytes:{bytesValue:'AAECAw=='},ref:{referenceValue:root+'custom/other'},point:{geoPointValue:{latitude:23.5,longitude:90.5}}};
  let seeded=await adapter.commit([{update:{name:root+'custom/parent/nested/child',fields},currentDocument:{exists:false}},{update:{name:root+'custom/other',fields:{v:{integerValue:'3'}}},currentDocument:{exists:false}},{update:{name:root+'portal_clients/anchor',fields:{name:{stringValue:'Synthetic anchor'}}},currentDocument:{exists:false}}]);
  const backup=await exportSnapshot(adapter);await validateBackup(JSON.parse(JSON.stringify(backup)));
  assert.equal(backup.documents.length,3);assert.deepEqual(backup.missingParents,[root+'custom/parent']);
  assert.deepEqual(backup.documents.find(d=>d.name.endsWith('/child')).fields,fields);
  await adapter.commit([{delete:root+'custom/parent/nested/child',currentDocument:{updateTime:seeded.writeResults[0].updateTime}}]);
  const serverTime=await adapter.readTime();
  await adapter.commit([{update:{name:root+'portal_settings/recovery',fields:encode({active:true,operationId:'emulator-recovery',gatesVerified:true}).mapValue.fields},updateTransforms:[{fieldPath:'startedAt',setToServerValue:'REQUEST_TIME'}],currentDocument:{exists:false}}]);
  // Only this synthetic emulator fixture backdates the lock to exercise the
  // ten-minute quiescence gate without a real-time wait or any production access.
  const lock=await adapter.get(root+'portal_settings/recovery');lock.fields.startedAt={timestampValue:new Date(Date.parse(serverTime)-601000).toISOString()};
  await adapter.commit([{update:{name:lock.name,fields:lock.fields},currentDocument:{updateTime:lock.updateTime}}]);
  const current=await exportSnapshot(adapter),plan=await planRestore(backup,current);
  const commits=[],journal={start:async()=>{},prepare:async()=>{},commit:async(_index,data)=>commits.push(data),complete:async()=>{}};
  const result=await applyRestore(plan,{adapter,journal,operationId:'emulator-recovery'});assert.equal(result.verified,true);
  assert.deepEqual((await adapter.get(root+'custom/parent/nested/child')).fields,fields);
  assert.equal((await adapter.get(root+'portal_settings/notifications')).fields.enabled.booleanValue,false);
  const receipts=commits.flatMap(c=>c.documents);
  await rollbackRestore(plan,receipts,{adapter,journal:{...journal,commit:async()=>{}},operationId:'emulator-recovery'});
  assert.equal(await adapter.get(root+'custom/parent/nested/child'),null);
  assert.equal((await adapter.get(root+'custom/other')).fields.v.integerValue,'3');
  assert.equal((await adapter.get(root+'portal_settings/recovery')).fields.active.booleanValue,true);
});
