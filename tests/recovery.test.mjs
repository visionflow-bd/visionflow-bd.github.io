import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext as vmRun } from 'node:vm';
import { nextReviewEpoch, retainedReviewRecord, belongsToReviewProject } from '../portal/review-lifecycle.js';
import { prepareNotificationSave } from '../portal/notification-publication.js';
const runInNewContext=(code,context)=>vmRun(code,{nextReviewEpoch,retainedReviewRecord,belongsToReviewProject,now:()=> '2026-09-28T00:00:00Z',...context});
import { Timestamp } from 'firebase/firestore';
import { normalizeClient, publicSnapshot, prepareSecureSave, sameRecord, clone, itemsOf, money } from '../portal/data.js';
import { ensureDeliveryApprovals } from '../portal/approval-state.js';

// Exercise the actual application functions, with Firestore and the DOM replaced
// by explicit in-memory boundaries. These complement, not replace, browser/rules QA.
const source = readFileSync(new URL('../portal/workspace.js', import.meta.url), 'utf8');
const section = (start, end) => {
  const begin = source.indexOf(start), finish = source.indexOf(end, begin + start.length);
  assert.ok(begin >= 0 && finish > begin, `Missing source boundary: ${start}`);
  return source.slice(begin, finish);
};
const recoverySource = section('async function deletePublicRecords(', 'const archivePreview =')
  + section('function trashEntry(', 'function renderTrash(')
  + section('function assertTrashRestorePossible(', 'function openArchivedRows(');
const rotationSource = section('const ROTATION_BATCH_SIZE=', 'async function purgeClient(');
const purgeSource = section('async function claimClientPurge(', 'function download(');
const purgeTrashSource = section('async function purgeTrash(', 'function openArchivedRows(');
const largeArchiveSource = section('async function deletePublicRecords(', 'const archivePreview =');
const project = name => ({ name, items:[{ n:1, s:'pending' }], payments:[], approvals:[] });

test('private client links use an auth-isolated Firebase app',()=>{
  assert.match(source,/const initialAccess = new URLSearchParams\(location\.search\)\.get\('access'\)/);
  assert.match(source,/initialAccess \? initializeApp\(firebaseConfig,'client-view'\) : initializeApp\(firebaseConfig\)/);
  assert.match(source,/if\(initialAccess\)startClient\(initialAccess\);else onAuthStateChanged/);
});

test('browser DOMException numeric codes cannot break the error display',()=>{
  const message=runInNewContext(section('function errorMessage(', 'function fail(')+';errorMessage;',{});
  assert.equal(message({code:0,message:'The image could not be decoded.'}),'The image could not be decoded.');
  assert.equal(message({code:18,message:'Access blocked'}),'Access blocked');
  assert.equal(message(null),'Could not complete this action. Please retry.');
  assert.match(message({code:'firestore/permission-denied'}),/Access could not be verified/);
});
test('render routing preserves a mail deep link, and hostile hashes are not CSS selectors',()=>{
  const location={pathname:'/portal/',hash:'#notice-specific-update'},calls=[];
  const ctx={location,state:{mode:'client',token:'test-token',projectKey:'p'},URLSearchParams,history:{replaceState:(_a,_b,url)=>calls.push(url)}};
  const setRoute=runInNewContext(section('function setRoute(', 'function clientUrl(')+';setRoute;',ctx);
  setRoute();assert.equal(calls[0],'/portal/?access=test-token&p=p#notice-specific-update');
  let target;
  const hashScroll=runInNewContext(section('function hashScroll(', 'function render(')+';hashScroll;',{location,document:{getElementById:id=>{target=id;return null;}},setTimeout:()=>{}});
  hashScroll();assert.equal(target,'notice-specific-update');
  location.hash='#%ZZ';assert.doesNotThrow(hashScroll);
});

test('legacy public relay migration deletes nested fields instead of writing blank copies',()=>{
  const emailSettings=section('async function openEmailSettings(', 'function openPayment(');
  assert.match(emailSettings,/batch\.update\(doc\(db,'site','main'\)/);
  assert.match(emailSettings,/['"]site\.notifications\.emailWebhookUrl['"]:deleteField\(\)/);
  assert.doesNotMatch(emailSettings,/['"]site\.notifications\.emailWebhookUrl['"]:''/);
});

function recoveryHarness({afterFirstSave} = {}) {
  const c = normalizeClient({ name:'Recovery test', accessToken:'private-token', projects:{ p:project('Primary'), other:project('Other') } }, 'client');
  c.projects.p.payments.push({ id:'payment', amount:100, date:'2026-09-24' });
  c.projects.p.approvals.push({ id:'approval', title:'Confirm' });
  c.signatureReviews.sig = { state:'verified', message:'Original review' };
  c.feedbackReviews.feedback = { status:'resolved', response:'Original answer' };
  c.feedbackReviews.unrelated = { status:'new' };
  const records = [
    { collection:'sigs', id:'sig', projectKey:'p', name:'Signer' },
    { collection:'sigs', id:'p', name:'Legacy signer' },
    { collection:'confirms', id:'approval', confirmedAt:'2026-09-24T00:00:00.000Z' },
    { collection:'feedback', id:'feedback', projectKey:'p', message:'Please revise' },
    { collection:'feedback', id:'other-feedback', projectKey:'other', message:'Keep this' },
    { collection:'sigs', id:'main', image:'Legacy unlinked image' },
  ];
  const state = { clientKey:'client', projectKey:'p', clients:{ client:c } }, archiveStore=new Map();
  let saves = 0, sequence = 0, lastOperations = [];
  const context = {
    state, clone, itemsOf, money, requireAdmin:()=>{},notify:()=>{},MAX_SAVE_OPERATIONS:498,
    db:{}, doc:(_db,...path)=>path,
    getDoc:async path=>{const record=records.find(row=>row.collection===path.at(-2)&&row.id===path.at(-1));return {exists:()=>Boolean(record),data:()=>clone(record),id:record?.id};},
    client:()=>state.clients.client,
    uid:prefix=>`${prefix}-${++sequence}`, now:()=> '2026-09-24T00:00:00.000Z',
    $:()=>({ hidden:true }), finishModal:()=>{},
    allRecords:async()=>clone(records),
    deletePublicRecords:async(_token,stored)=>{for(const record of stored){const index=records.findIndex(row=>row.collection===record.collection&&row.id===record.id);if(index>=0)records.splice(index,1);}},
    writeBatch:()=>{const deletes=[];return {delete:path=>deletes.push(path),commit:async()=>{for(const [,token,collection,id] of deletes){const index=records.findIndex(row=>row.collection===collection&&row.id===id);if(index>=0)records.splice(index,1);}}};},
    archivePreview:record=>{const {image,...preview}=record;return clone(preview);},
    stageTrashRecords:async(_clientKey,trashId,entry)=>{const archiveKey=entry.archiveKey||trashId,stored=clone(entry.records||[]);archiveStore.set(archiveKey,stored);entry.archiveKey=archiveKey;entry.archivedRecordCount=stored.length;entry.archivedRecordIds=stored.map(record=>record.id);entry.records=[];},
    archivedTrashRecords:async(_clientKey,entry)=>clone(entry.archiveKey?archiveStore.get(entry.archiveKey)||[]:entry.records||[]),
    restorePublicRecords:async(_accessToken,stored)=>{for(const record of stored){const index=records.findIndex(row=>row.collection===record.collection&&row.id===record.id);if(index>=0)records[index]=clone(record);else records.push(clone(record));}},
    deleteArchivedTrashRecords:async(_clientKey,entry)=>{if(entry.archiveKey)archiveStore.delete(entry.archiveKey);},
    projectSigs:()=>records.filter(r=>r.collection==='sigs' && (r.projectKey===state.projectKey || r.id===state.projectKey)),
    requests:()=>records.filter(r=>r.collection==='feedback' && r.projectKey===state.projectKey),
    confirmation:a=>records.find(r=>r.collection==='confirms' && r.id===a.id),
    saveClient:async(next,_message,ops=[])=>{
      saves++;
      lastOperations = clone(ops);
      for(const op of ops) {
        const index = records.findIndex(r=>r.collection===op.path[0] && r.id===op.path[1]);
        if(index>=0)records.splice(index,1);
        if(!op.delete)records.push({ ...clone(op.data), collection:op.path[0], id:op.path[1] });
      }
      state.clients[next.slug] = clone(next);
      if(saves===1)afterFirstSave?.(records);
      return clone(next);
    },
  };
  const api = runInNewContext(`${recoverySource}; ({ archive, restoreTrash });`, context);
  return { ...api, state, records, saves:()=>saves, lastOperations:()=>clone(lastOperations), entry:()=>Object.entries(state.clients.client.trash)[0], archived:entry=>clone(entry.archiveKey?archiveStore.get(entry.archiveKey)||[]:entry.records||[]) };
}

test('project archive/restore round-trips linked and legacy records and their reviews', async()=>{
  const h = recoveryHarness();
  const before = clone(h.state.clients.client);
  const originalRecords = clone(h.records);
  await h.archive('project', { dataset:{} });
  assert.equal(h.state.clients.client.projects.p, undefined);
  assert.equal(h.state.projectKey, null);
  assert.equal(h.records.length,2);
  assert.ok(h.records.some(r=>r.id==='other-feedback'));
  assert.ok(h.records.some(r=>r.id==='main'));
  assert.equal(h.state.clients.client.signatureReviews.sig, undefined);
  assert.equal(h.state.clients.client.feedbackReviews.feedback, undefined);
  assert.equal(h.state.clients.client.feedbackReviews.unrelated.status, 'new');
  const [id, entry] = h.entry();
  assert.equal(h.archived(entry).length,4);
  assert.equal(JSON.stringify(publicSnapshot(h.state.clients.client,'client')).includes('Original answer'), false);
  await h.restoreTrash('client',id);
  assert.deepEqual(h.state.clients.client, before);
  const stable = rows => rows.sort((a,b)=>`${a.collection}/${a.id}`.localeCompare(`${b.collection}/${b.id}`));
  assert.deepEqual(stable(h.records),stable(originalRecords));
});

test('generic legacy archive restores an unlinked record and both review maps',async()=>{
  const h = recoveryHarness(), c = h.state.clients.client;
  c.signatureReviews.main = { state:'pending' };
  c.feedbackReviews.main = { response:'Legacy review' };
  await h.archive('record',{ dataset:{ id:'main',collection:'sigs' } });
  assert.equal(h.records.some(r=>r.id==='main'),false);
  assert.equal(h.state.clients.client.signatureReviews.main,undefined);
  const [id] = h.entry();
  await h.restoreTrash('client',id);
  assert.equal(h.records.filter(r=>r.id==='main').length,1);
  assert.equal(h.state.clients.client.signatureReviews.main.state,'pending');
  assert.equal(h.state.clients.client.feedbackReviews.main.response,'Legacy review');
});

test('signature and feedback recovery preserve administrator review edits',async()=>{
  for(const [kind,id,col,map,field,value] of [
    ['signature','sig','sigs','signatureReviews','state','verified'],
    ['feedback','feedback','feedback','feedbackReviews','response','Original answer'],
  ]) {
    const h = recoveryHarness();
    await h.archive(kind,{ dataset:{ id,collection:col } });
    assert.equal(h.records.some(r=>r.id===id && r.collection===col),false);
    const [trashId] = h.entry();
    await h.restoreTrash('client',trashId);
    assert.equal(h.records.filter(r=>r.id===id && r.collection===col).length,1);
    assert.equal(h.state.clients.client[map][id][field],value);
  }
});

test('feedback archive preserves exact original evidence and attached bytes without display-derived fields',async()=>{
  const h=recoveryHarness(),record={collection:'confirms',id:'objection',projectKey:'p',kind:'rejection-pending',requestId:'objection',rejectReason:'Original reason',confirmedAt:Timestamp.fromDate(new Date('2026-09-30T00:00:00Z'))};
  h.records.push(record);
  await h.archive('feedback',{dataset:{id:'objection',collection:'confirms'}});
  const [id,entry]=h.entry();assert.equal(sameRecord(h.archived(entry),[record]),true);
  assert.equal(Object.hasOwn(h.archived(entry)[0],'message'),false);
  await h.restoreTrash('client',id);assert.deepEqual(h.records.find(r=>r.id==='objection'),record);
  const original=clone(h.records.find(r=>r.id==='feedback')),attachment={collection:'attachments',id:'feedback-a1',feedbackCollection:'feedback',feedbackId:'feedback',projectKey:'p',content:'cHJpdmF0ZQ==',name:'notes.txt',size:7};
  original.attachments=[{id:attachment.id,name:attachment.name,size:7}];Object.assign(h.records.find(r=>r.id==='feedback'),original);h.records.push(attachment);
  await h.archive('feedback',{dataset:{id:'feedback',collection:'feedback'}});
  const [id2,entry2]=h.entry();assert.equal(sameRecord(h.archived(entry2),[original,attachment]),true);assert.equal(h.records.some(r=>r.id===attachment.id),false);
  await h.restoreTrash('client',id2);assert.deepEqual(h.records.find(r=>r.id===attachment.id),attachment);
});
test('signature UI archive does not require a collection data attribute',async()=>{
  const h=recoveryHarness();await h.archive('signature',{dataset:{id:'sig'}});assert.equal(h.records.some(r=>r.id==='sig'),false);
});

test('approval archive/restore includes the existing confirmation',async()=>{
  const h = recoveryHarness();
  await h.archive('approval',{ dataset:{ id:'approval' } });
  assert.equal(h.state.clients.client.projects.p.approvals.length,0);
  assert.equal(h.records.some(r=>r.id==='approval'),false);
  const [id] = h.entry();
  await h.restoreTrash('client',id);
  assert.equal(h.state.clients.client.projects.p.approvals[0].id,'approval');
  assert.equal(h.records.find(r=>r.id==='approval').confirmedAt,'2026-09-24T00:00:00.000Z');
  assert.equal(h.lastOperations().filter(op=>op.path[0]==='confirms'&&op.path[1]==='approval').length,0,'records are restored in a separately resumable batch');
});

test('archive and restore retain Firestore Timestamp instances',async()=>{
  const h = recoveryHarness();
  const submittedAt = Timestamp.fromMillis(Date.UTC(2026,8,24,12,30));
  h.records.find(record=>record.collection==='confirms'&&record.id==='approval').submittedAt=submittedAt;
  await h.archive('approval',{ dataset:{ id:'approval' } });
  const [id,entry] = h.entry();
  assert.equal(h.archived(entry)[0].submittedAt,submittedAt);
  await h.restoreTrash('client',id);
  const restored=h.records.find(record=>record.collection==='confirms'&&record.id==='approval');
  assert.equal(restored.submittedAt,submittedAt);
  assert.equal(typeof restored.submittedAt.toDate,'function');
});

test('approval archive retains a confirmation that arrives during archival',async()=>{
  const h = recoveryHarness({afterFirstSave:records=>records.push({collection:'confirms',id:'approval',projectKey:'p',confirmedAt:'2026-09-24T00:00:01.000Z'})});
  await h.archive('approval',{ dataset:{ id:'approval' } });
  const [id,entry] = h.entry();
  assert.equal(h.archived(entry).filter(record=>record.collection==='confirms'&&record.id==='approval').length,1);
  assert.equal(h.records.some(record=>record.collection==='confirms'&&record.id==='approval'),false);
  await h.restoreTrash('client',id);
  assert.equal(h.records.find(record=>record.collection==='confirms'&&record.id==='approval').confirmedAt,'2026-09-24T00:00:01.000Z');
});

test('recovery refuses project collisions and missing parents without writing',async()=>{
  const h = recoveryHarness();
  await h.archive('project',{ dataset:{} });
  const [id] = h.entry();
  h.state.clients.client.projects.p = project('Replacement');
  await assert.rejects(h.restoreTrash('client',id),/already uses this label/);
  assert.equal(h.saves(),2);
  assert.ok(h.state.clients.client.trash[id]);
  const payment = recoveryHarness();
  await payment.archive('payment',{ dataset:{ id:'payment' } });
  const [paymentId] = payment.entry();
  delete payment.state.clients.client.projects.p;
  await assert.rejects(payment.restoreTrash('client',paymentId),/Restore the parent project first/);
  assert.equal(payment.saves(),1);
});

test('client archive disables public access and preserves the prior sharing preference',async()=>{
  const h = recoveryHarness();
  h.state.clients.client.accessEnabled = false;
  await h.archive('client',{ dataset:{} });
  assert.equal(h.state.clients.client._deleted,true);
  assert.equal(h.state.clients.client.accessEnabled,false);
  assert.equal(publicSnapshot(h.state.clients.client,'client').enabled,false);
  assert.equal(h.records.length,6);
});

function largeArchiveHarness() {
  const c=normalizeClient({name:'Large archive',accessToken:'private-token',projects:{p:project('Primary')}},'client');
  const records=Array.from({length:499},(_,index)=>({collection:'feedback',id:`feedback-${index}`,projectKey:'p',message:`request ${index}`}));
  const state={clientKey:'client',projectKey:'p',clients:{client:c}},archiveStore=new Map(),saves=[];
  const context={
    state,clone,itemsOf,money,requireAdmin:()=>{},notify:()=>{},MAX_SAVE_OPERATIONS:498,uid:prefix=>`${prefix}-one`,db:{},doc:(_db,...path)=>path,$:()=>({hidden:true}),now:()=> '2026-09-27T00:00:00.000Z',
    client:()=>state.clients.client,allRecords:async()=>clone(records),archivePreview:record=>clone(record),
    archivedTrashRecords:async(_clientKey,entry)=>clone(archiveStore.get(entry.archiveKey)||entry.records||[]),
    stageTrashRecords:async(_clientKey,trashId,entry)=>{archiveStore.set(trashId,clone(entry.records));entry.archiveKey=trashId;entry.archivedRecordCount=entry.records.length;entry.archivedRecordIds=entry.records.map(record=>record.id);entry.records=[];},
    deleteArchivedTrashRecords:async()=>{},
    writeBatch:()=>{const deletes=[];return {delete:path=>deletes.push(path),commit:async()=>{for(const [,token,collection,id] of deletes){if(token!=='private-token')continue;const index=records.findIndex(record=>record.collection===collection&&record.id===id);if(index>=0)records.splice(index,1);}}};},
    saveClient:async(next,message,operations=[])=>{saves.push({next:clone(next),message,operations:clone(operations)});state.clients[next.slug]=clone(next);return clone(next);},
    resumeLargeArchive:async()=>{const current=clone(state.clients.client),entry=current.trash[current.archiveState.trashId];assert.equal(current.accessEnabled,false);assert.equal(entry.archivedRecordCount,499);records.splice(0,records.length);current.accessEnabled=current.archiveState.previousAccessEnabled;delete current.archiveState;state.clients[current.slug]=current;return true;},
  };
  const api=runInNewContext(`${recoverySource}; ({ archive });`,context);
  return {...api,state,records,archiveStore,saves};
}

test('large archive pauses sharing, moves records externally, and resumes automatically',async()=>{
  const h=largeArchiveHarness();
  await h.archive('project',{dataset:{}});
  assert.equal(h.saves[0].next.accessEnabled,false);
  assert.equal(h.saves[0].next.archiveState.kind,'large-archive');
  assert.equal(h.saves[0].operations.length,0);
  assert.equal(h.archiveStore.get(h.saves[0].next.archiveState.trashId).length,499);
  assert.equal(h.records.length,0);
  assert.equal(h.state.clients.client.accessEnabled,undefined);
  assert.equal(h.state.clients.client.archiveState,undefined);
});

function largeResumeHarness() {
  const c=normalizeClient({accessToken:'private-token',accessEnabled:false,projects:{},trash:{'trash-one':{kind:'project',projectKey:'p',value:{approvals:[]},archiveKey:'trash-one',archivedRecordCount:9,archivedRecordIds:Array.from({length:9},(_,index)=>`record-${index}`)}},archiveState:{kind:'large-archive',trashId:'trash-one',previousAccessEnabled:true}},'client');
  const source=Array.from({length:9},(_,index)=>({collection:'feedback',id:`record-${index}`,projectKey:'p',message:`request ${index}`}));
  const archive=new Map([['trash-one',clone(source)]]),state={clients:{client:c}};
  let injected=false,saves=0;
  const context={
    state,clone,client:()=>state.clients.client,requireAdmin:()=>{},db:{},uid:prefix=>`${prefix}-one`,allRecords:async()=>clone(source),archivedTrashRecords:async(_clientKey,entry)=>clone(archive.get(entry.archiveKey)||[]),
    stageTrashRecords:async(_clientKey,trashId,entry)=>{const stored=clone(entry.records||[]);archive.set(trashId,stored);entry.archiveKey=trashId;entry.archivedRecordCount=stored.length;entry.archivedRecordIds=stored.map(record=>record.id);entry.records=[];},
    saveClient:async(next)=>{saves++;state.clients[next.slug]=clone(next);return clone(next);},doc:(_db,...path)=>path,
    writeBatch:()=>{const deletes=[];return {delete:path=>deletes.push(path),commit:async()=>{for(const [,token,collection,id] of deletes){if(token!=='private-token')continue;const index=source.findIndex(record=>record.collection===collection&&record.id===id);if(index>=0)source.splice(index,1);}if(!injected){injected=true;source.push({collection:'feedback',id:'arrived-after-pause',projectKey:'p',message:'late request'});}}};},
  };
  const api=runInNewContext(`${largeArchiveSource}; ({ resumeLargeArchive });`,context);
  return {...api,state,source,archive,saves:()=>saves};
}

test('large archive resume retains a submission that arrives during its pause window',async()=>{
  const h=largeResumeHarness();
  await h.resumeLargeArchive();
  assert.equal(h.source.length,0);
  assert.equal(h.state.clients.client.accessEnabled,true);
  assert.equal(h.state.clients.client.archiveState,undefined);
  assert.equal(h.archive.get('trash-one').length,10);
  assert.ok(h.archive.get('trash-one').some(record=>record.id==='arrived-after-pause'));
  assert.equal(h.saves(),2);
});

function rotationHarness({recordCount=215,failFirstTransfer=false}={}) {
  const c=normalizeClient({name:'Rotation test',accessToken:'old-token',projects:{}},'client');
  const records=new Map([['old-token',Array.from({length:recordCount},(_,index)=>({
    collection:index%3===0?'sigs':index%3===1?'confirms':'feedback',id:`record-${index}`,projectKey:'project',message:`record ${index}`,
  }))]]);
  const parents=new Map([['old-token',{enabled:true}]]),notifications=[],sourceReads=[];
  const state={clients:{client:c}};let firstSave=true,failed=false,batches=0,finished=0;
  const context={
    state,clone,publicSnapshot,db:{},requireAdmin:()=>{},client:()=>state.clients.client,newToken:()=> 'new-token',now:()=> '2026-09-27T00:00:00.000Z',
    notify:(message,error)=>notifications.push({message,error}),finishModal:()=>{finished++;},
    allRecords:async token=>{sourceReads.push({token,enabled:parents.get(token)?.enabled});return clone(records.get(token)||[]);},
    saveClient:async(next,_notice,operations=[])=>{
      const saved=clone(next);state.clients[saved.slug]=saved;parents.set(saved.accessToken,publicSnapshot(saved,saved.slug));
      for(const operation of operations){if(!operation.path.length)parents.set(operation.token,clone(operation.data));}
      if(firstSave){firstSave=false;records.get('old-token').push({collection:'feedback',id:'arrived-during-rotation',projectKey:'project',message:'late request'});}
      return clone(saved);
    },
    doc:(_db,...path)=>path,
    writeBatch:()=>{
      const operations=[];
      return {set:(path,data)=>operations.push({kind:'set',path,data:clone(data)}),delete:path=>operations.push({kind:'delete',path}),commit:async()=>{
        batches++;
        if(failFirstTransfer&&!failed&&operations.some(operation=>operation.kind==='set'&&operation.path.length===4)){failed=true;throw new Error('simulated transfer interruption');}
        for(const operation of operations){const [,token,collection,id]=operation.path;if(operation.path.length===2){if(operation.kind==='delete')parents.delete(token);continue;}const rows=records.get(token)||[];if(operation.kind==='delete'){const index=rows.findIndex(row=>row.collection===collection&&row.id===id);if(index>=0)rows.splice(index,1);}else{const index=rows.findIndex(row=>row.collection===collection&&row.id===id),record={...clone(operation.data),collection,id};if(index>=0)rows[index]=record;else rows.push(record);}records.set(token,rows);}
      }};
    },
  };
  const api=runInNewContext(`${rotationSource}; ({ rotateLink });`,context);
  return {...api,state,records,parents,notifications,sourceReads,batches:()=>batches,finished:()=>finished};
}

test('private-link rotation disables first, moves a late submission, and chunks large workspaces',async()=>{
  const h=rotationHarness();
  await h.rotateLink();
  assert.equal(h.state.clients.client.accessToken,'new-token');
  assert.equal(h.state.clients.client.accessRotation,undefined);
  assert.equal(h.parents.has('old-token'),false);
  assert.equal(h.parents.get('new-token').enabled,true);
  assert.equal(h.sourceReads[0].enabled,false);
  assert.equal(h.records.get('old-token').length,0);
  assert.equal(h.records.get('new-token').length,216);
  assert.ok(h.records.get('new-token').some(record=>record.id==='arrived-during-rotation'));
  assert.ok(h.batches()>2,'large workspaces are transferred in multiple safe batches');
  assert.equal(h.finished(),1);
});
test('rotation preserves attachment identity and bytes with its parent submission',async()=>{
  const h=rotationHarness({recordCount:0}),original={collection:'attachments',id:'f-a1',feedbackId:'f',feedbackCollection:'confirms',projectKey:'p',content:'cHJpdmF0ZQ=='};
  h.records.get('old-token').push(clone(original));await h.rotateLink();
  assert.deepEqual(h.records.get('new-token').find(r=>r.id===original.id),original);
});

test('interrupted private-link rotation keeps its protected source and resumes without a second link',async()=>{
  const h=rotationHarness({recordCount:1,failFirstTransfer:true});
  await assert.rejects(h.rotateLink(),/simulated transfer interruption/);
  assert.equal(h.state.clients.client.accessToken,'new-token');
  assert.equal(h.state.clients.client.accessRotation.from,'old-token');
  assert.equal(h.parents.get('old-token').enabled,false);
  assert.equal(h.records.get('old-token').length,2);
  await h.rotateLink();
  assert.equal(h.state.clients.client.accessRotation,undefined);
  assert.equal(h.parents.has('old-token'),false);
  assert.equal(h.records.get('new-token').length,2);
  assert.ok(h.records.get('new-token').some(record=>record.id==='arrived-during-rotation'));
});

function purgeHarness({recordCount=401,failSecondBatch=false}={}) {
  const c=normalizeClient({_deleted:true,accessToken:'old-token',projects:{}},'client');
  const records=Array.from({length:recordCount},(_,index)=>({collection:'feedback',id:`record-${index}`}));
  const state={clients:{client:c}};let artifactBatches=0,failed=false,clientDeleted=false,parentDeleted=false,saves=0;
  const context={
    state,clone,db:{},now:()=> '2026-09-27T00:00:00.000Z',allRecords:async()=>clone(records),notify:()=>{},
    saveClient:async(next,_notice,_operations,options)=>{assert.equal(options?.allowRecovery,true);saves++;state.clients[next.slug]=clone(next);return clone(next);},
    deleteAllClientArchives:async()=>{},
    writeBatch:()=>{const operations=[];return {delete:path=>operations.push(path),commit:async()=>{
      const artifactOperations=operations.filter(path=>path.length===4);
      if(artifactOperations.length){artifactBatches++;if(failSecondBatch&&!failed&&artifactBatches===2){failed=true;throw new Error('simulated purge interruption');}for(const [,token,collection,id] of artifactOperations){const index=records.findIndex(record=>record.collection===collection&&record.id===id);if(index>=0)records.splice(index,1);}}
      for(const path of operations.filter(path=>path.length===2)){if(path[0]==='portal_public')parentDeleted=true;if(path[0]==='portal_clients')clientDeleted=true;}
    }};},
    doc:(_db,...path)=>path,
  };
  const api=runInNewContext(`${purgeSource}; ({ purgeClient });`,context);
  return {...api,state,records,saves:()=>saves,status:()=>({artifactBatches,clientDeleted,parentDeleted})};
}

test('permanent client deletion claims first and safely resumes after a partial cleanup',async()=>{
  const h=purgeHarness({failSecondBatch:true});
  await assert.rejects(h.purgeClient('client'),/simulated purge interruption/);
  assert.equal(h.saves(),1);
  assert.equal(h.state.clients.client.purgeState.status,'purging');
  assert.equal(h.records.length,1);
  await h.purgeClient('client');
  assert.equal(h.saves(),1,'retry resumes the existing purge claim');
  assert.equal(h.records.length,0);
  assert.equal(h.state.clients.client,undefined);
  assert.deepEqual(h.status(),{artifactBatches:3,clientDeleted:true,parentDeleted:true});
});

function purgeTrashHarness({restoreState=false,archiveState=false}={}) {
  const c=normalizeClient({accessToken:'private-token',projects:{p:project('Primary')},trash:{'trash-one':{kind:'feedback',label:'Client request',projectKey:'p',value:{id:'feedback-one',collection:'feedback'},archiveKey:'trash-one',archivedRecordCount:1,restoreState:restoreState?{status:'restoring'}:undefined}},archiveState:archiveState?{kind:'large-archive',trashId:'trash-one',previousAccessEnabled:true}:undefined},'client');
  if(!restoreState)delete c.trash['trash-one'].restoreState;if(!archiveState)delete c.archiveState;
  const state={clients:{client:c}},records=[{collection:'feedback',id:'feedback-one',projectKey:'p',message:'restored before interruption'}],archive=new Map([['trash-one',clone(records)]]),saves=[];
  const context={state,clone,requireAdmin:()=>{},confirmAction:async()=>true,client:()=>state.clients.client,now:()=> '2026-09-27T00:00:00.000Z',archivedTrashRecords:async(_key,entry)=>clone(archive.get(entry.archiveKey)||entry.records||[]),deletePublicRecords:async(_token,stored)=>{for(const record of stored){const index=records.findIndex(row=>row.collection===record.collection&&row.id===record.id);if(index>=0)records.splice(index,1);}},deleteArchivedTrashRecords:async(_key,entry)=>{archive.delete(entry.archiveKey);},saveClient:async(next,_message,_ops,_options)=>{saves.push(clone(next));state.clients[next.slug]=clone(next);return clone(next);},render:()=>{}};
  const api=runInNewContext(`${purgeTrashSource}; ({ purgeTrash });`,context);
  return {...api,state,records,archive,saves:()=>saves};
}

test('partial restore blocks a racing permanent delete until recovery is finished',async()=>{
  const h=purgeTrashHarness({restoreState:true});
  await assert.rejects(h.purgeTrash('client','trash-one'),/Restore is in progress/);
  assert.equal(h.records.length,1,'a pending restore is never raced by permanent deletion');
  assert.ok(h.state.clients.client.trash['trash-one']);
  assert.equal(h.saves.length,0);
});

test('purging an old archive never deletes newer live evidence with the same ID',async()=>{
  const h=purgeTrashHarness();
  h.records[0].message='Newly submitted evidence after the original was archived';
  await h.purgeTrash('client','trash-one');
  assert.equal(h.records.length,1);
  assert.equal(h.records[0].message,'Newly submitted evidence after the original was archived');
  assert.equal(h.archive.size,0);
  assert.equal(h.state.clients.client.trash['trash-one'],undefined);
});

test('derived delivery manifests cannot be archived as client submissions',async()=>{
  const h=recoveryHarness();h.records.push({collection:'deliveries',id:'p',projectKey:'p',version:3,links:{1:'https://example.invalid/final'}});
  await assert.rejects(h.archive('record',{dataset:{id:'p',collection:'deliveries'}}),/managed by the project/);
  assert.equal(h.saves(),0);
  assert.ok(h.records.find(r=>r.collection==='deliveries'));
});

test('restore uses atomic collision checks, preserves new consent and skips cached manifests',async()=>{
  const live=new Map(),writes=[];
  const context={db:{},ARCHIVE_RECORD_BATCH_SIZE:8,sameRecord,doc:(_db,...path)=>path.join('/'),runTransaction:async(_db,callback)=>{
    const staged=[];
    await callback({get:async ref=>({exists:()=>live.has(ref),data:()=>live.get(ref)}),set:(ref,data)=>staged.push([ref,data])});
    for(const [ref,data]of staged){live.set(ref,clone(data));writes.push(ref);}
  }};
  const restore=runInNewContext(`${section('async function restorePublicRecords(', 'async function deleteArchivedTrashRecords(')};restorePublicRecords;`,context);
  const old={collection:'consent',id:'v1',termsSnapshot:{version:'v1'},agreedAt:Timestamp.fromMillis(1234)};
  const ref='portal_public/token/consent/v1';
  live.set(ref,{termsSnapshot:{version:'v1'},agreedAt:Timestamp.fromMillis(5678)});
  await assert.rejects(restore('token',[old]),/newer submission/);
  assert.equal(live.get(ref).agreedAt.toMillis(),5678);assert.equal(writes.length,0);
  live.clear();await restore('token',[old,{collection:'deliveries',id:'p',version:1,links:{1:'stale'}}]);
  assert.equal(writes.length,1);assert.equal(live.size,1);
  await restore('token',[old]);assert.equal(writes.length,1,'Identical restore is an idempotent retry');
  const attachment={collection:'attachments',id:'feedback-a1',content:'cHJpdmF0ZQ==',feedbackId:'feedback'};
  await restore('token',[attachment]);
  assert.equal(live.get('portal_public/token/attachments/feedback-a1').id,'feedback-a1');
  assert.equal(live.get('portal_public/token/attachments/feedback-a1').content,attachment.content);
  const pending={collection:'reviews',id:'r1',projectKey:'p',status:'pending',revision:2,publishedAt:'2026-09-20T00:00:00Z'};
  await restore('token',[pending],'2026-09-28T00:00:00Z');
  const restored=live.get('portal_public/token/reviews/r1');
  assert.equal(restored.status,'cancelled');assert.equal(restored.revision,3);
  assert.equal(restored.cancellationReason,'archive-restored');
  await restore('token',[pending],'2026-09-28T00:00:00Z');
  assert.equal(live.get('portal_public/token/reviews/r1').revision,3,'Resuming a restore is deterministic');
});

test('review guards are archived with their project and cannot be removed standalone',async()=>{
  const h=recoveryHarness();
  h.records.push({collection:'review_guards',id:'p',revision:5},{collection:'reviews',id:'r1',projectKey:'p',status:'objected',revision:2});
  await assert.rejects(h.archive('record',{dataset:{id:'p',collection:'review_guards'}}),/managed by the project/);
  await h.archive('project',{dataset:{}});
  assert.equal(h.records.some(r=>r.collection==='review_guards'&&r.id==='p'),false);
  assert.ok(h.archived(h.entry()[1]).some(r=>r.collection==='review_guards'&&r.revision===5));
});

test('link replacement cancels pending timers and retains explicit outcome evidence',async()=>{
  const h=rotationHarness({recordCount:0});
  h.records.get('old-token').push({collection:'reviews',id:'pending',status:'pending',revision:1},{collection:'reviews',id:'explicit',status:'client-confirmed',revision:4,decidedAt:'2026-09-25T00:00:00Z'},{collection:'review_guards',id:'p',revision:7});
  await h.rotateLink();
  const moved=h.records.get('new-token');
  assert.equal(moved.find(r=>r.id==='pending').status,'cancelled');
  assert.equal(moved.find(r=>r.id==='pending').cancellationReason,'private-link-replaced');
  assert.equal(moved.find(r=>r.id==='explicit').decidedAt,'2026-09-25T00:00:00Z');
  assert.equal(moved.find(r=>r.id==='explicit').revision,4);
  assert.equal(moved.find(r=>r.collection==='review_guards').revision,7);
});

test('private epoch advances once for interruption and never rolls backwards from a draft',async()=>{
  const original=normalizeClient({name:'Epoch',accessToken:'token',reviewEpoch:3,projects:{}},'client');
  const h=transactionHarness(original,{repeat:true}),paused=clone(original);paused.accessEnabled=false;paused.reviewEpoch=0;
  await h.saveClient(paused);assert.equal(h.state.clients.client.reviewEpoch,4);
  assert.equal(nextReviewEpoch({...h.state.clients.client,accessEnabled:true},h.state.clients.client),4);
  assert.equal(nextReviewEpoch({...original,_deleted:true},original),4);
  assert.equal(nextReviewEpoch({...original,accessToken:'replacement',accessRotation:{from:'token'}},original),4);
  assert.equal(nextReviewEpoch({...original,name:'renamed'},original),3);
});

test('an active protected archive cannot be restored or permanently deleted from its bin entry',async()=>{
  const h=purgeTrashHarness({archiveState:true});
  await assert.rejects(h.purgeTrash('client','trash-one'),/protected archive is still in progress/);
  const recovery=recoveryHarness();
  await recovery.archive('project',{dataset:{}});
  const [id]=recovery.entry();
  recovery.state.clients.client.archiveState={kind:'large-archive',trashId:id,previousAccessEnabled:true};
  await assert.rejects(recovery.restoreTrash('client',id),/protected archive is still in progress/);
});

function confirmationHarness() {
  const listeners = {}, paragraph = {}, initialButton = { focus:()=>{} };
  let removed = false, closed = false, shown = false, focusReturns = 0;
  const dialog = {
    querySelector:selector=>selector==='p'?paragraph:initialButton,
    addEventListener:(type,fn)=>listeners[type]=fn,
    showModal:()=>{shown=true;}, close:()=>{closed=true;}, remove:()=>{removed=true;},
  };
  const document = { activeElement:{ focus:()=>{focusReturns++;} }, createElement:()=>dialog, body:{ append:()=>{} } };
  const confirmAction = runInNewContext(`${section('function confirmAction(', 'function openClientForm(')}; confirmAction;`,{document});
  return { confirmAction, listeners, paragraph, dialog, status:()=>({removed,closed,shown,focusReturns}) };
}

test('custom confirmation safely inserts text and returns Continue without a native prompt',async()=>{
  const h = confirmationHarness(), promise = h.confirmAction('<img src=x onerror=bad>');
  assert.equal(h.paragraph.textContent,'<img src=x onerror=bad>');
  assert.ok(!h.dialog.innerHTML.includes('onerror'));
  h.listeners.click({ target:{ closest:()=>({dataset:{choice:'continue'}}) } });
  assert.equal(await promise,true);
  assert.deepEqual(h.status(),{ removed:true,closed:true,shown:true,focusReturns:1 });
});

test('custom confirmation Cancel and Escape resolve false and restore focus',async()=>{
  for(const escape of [true,false]) {
    const h = confirmationHarness(), promise = h.confirmAction('Archive?');
    let prevented = false;
    if(escape)h.listeners.cancel({ preventDefault:()=>{prevented=true;} });
    else h.listeners.click({ target:{ closest:()=>({dataset:{choice:'cancel'}}) } });
    assert.equal(await promise,false);
    assert.equal(h.status().focusReturns,1);
    if(escape)assert.equal(prevented,true);
  }
});

function transactionHarness(current,{repeat=false}={}) {
  let server = current, writes = 0;
  const state = {clients:{}}, context = {
    state, normalizeClient,publicSnapshot,prepareSecureSave,prepareNotificationSave,ensureDeliveryApprovals,serverTimestamp:()=>Timestamp.fromDate(new Date('2026-09-24T00:00:00.000Z')), requireAdmin:()=>{},recoveryPending:c=>Boolean(c?.accessRotation||c?.archiveState||c?.purgeState||Object.values(c?.trash||{}).some(entry=>entry?.restoreState||entry?.purgeState)), now:()=> '2026-09-24T00:00:00.000Z',MAX_SAVE_OPERATIONS:498,
    uid:()=> 'save-unique',newToken:()=> 'new-token',db:{},notify:()=>{},
    doc:(_db,...path)=>path.join('/'),
    runTransaction:async(_db,callback)=>{
      const tx={get:async()=>({ exists:()=>Boolean(server),data:()=>server }),
        set:(path,data)=>{writes++;if(path.startsWith('portal_clients/'))server=clone(data);},delete:()=>{writes++;}};
      await callback(tx);
      if(repeat)await callback(tx);
    },
  };
  const saveClient = runInNewContext(`${section('async function saveClient(', 'function modal(')}; saveClient;`,context);
  return { saveClient,state,writes:()=>writes };
}

test('save retry recognizes its committed mutation and does not double-write or bump revision',async()=>{
  const c=normalizeClient({accessToken:'token'},'client'),h=transactionHarness(c,{repeat:true});
  await h.saveClient(c);
  assert.equal(h.writes(),2);
  assert.equal(h.state.clients.client._revision,1);
  assert.equal(h.state.clients.client._lastMutationId,'save-unique');
});

test('save rejects stale revisions and oversized operations before any write',async()=>{
  const c=normalizeClient({accessToken:'token'},'client'),h=transactionHarness({...c,_revision:2});
  await assert.rejects(h.saveClient(c),/changed in another tab/);
  assert.equal(h.writes(),0);
  await assert.rejects(h.saveClient(c,'Saved',Array.from({length:499},()=>({}))),/too large/);
  assert.equal(h.writes(),0);
  const claimed=transactionHarness({...c,purgeState:{status:'purging'}});
  await assert.rejects(claimed.saveClient(c),/Permanent deletion is already in progress/);
  assert.equal(claimed.writes(),0);
  const rotating=transactionHarness({...c,accessRotation:{from:'old-token'}});
  await assert.rejects(rotating.saveClient(c),/protected recovery task is in progress/);
  assert.equal(rotating.writes(),0);
});
