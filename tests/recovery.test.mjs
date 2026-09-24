import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { normalizeClient, publicSnapshot, clone, itemsOf, money } from '../portal/data.js';

// Exercise the actual application functions, with Firestore and the DOM replaced
// by explicit in-memory boundaries. These complement, not replace, browser/rules QA.
const source = readFileSync(new URL('../portal/workspace.js', import.meta.url), 'utf8');
const section = (start, end) => {
  const begin = source.indexOf(start), finish = source.indexOf(end, begin + start.length);
  assert.ok(begin >= 0 && finish > begin, `Missing source boundary: ${start}`);
  return source.slice(begin, finish);
};
const recoverySource = section('function trashEntry(', 'function renderTrash(')
  + section('async function restoreTrash(', 'function openArchivedRows(');
const project = name => ({ name, items:[{ n:1, s:'pending' }], payments:[], approvals:[] });

test('private client links use an auth-isolated Firebase app',()=>{
  assert.match(source,/const initialAccess = new URLSearchParams\(location\.search\)\.get\('access'\)/);
  assert.match(source,/initialAccess \? initializeApp\(firebaseConfig,'client-view'\) : initializeApp\(firebaseConfig\)/);
  assert.match(source,/if\(initialAccess\)startClient\(initialAccess\);else onAuthStateChanged/);
});

function recoveryHarness() {
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
  const state = { clientKey:'client', projectKey:'p', clients:{ client:c } };
  let saves = 0, sequence = 0;
  const context = {
    state, clone, itemsOf, money, requireAdmin:()=>{},
    client:()=>state.clients.client,
    uid:prefix=>`${prefix}-${++sequence}`, now:()=> '2026-09-24T00:00:00.000Z',
    $:()=>({ hidden:true }), finishModal:()=>{},
    allRecords:async()=>clone(records),
    projectSigs:()=>records.filter(r=>r.collection==='sigs' && (r.projectKey===state.projectKey || r.id===state.projectKey)),
    requests:()=>records.filter(r=>r.collection==='feedback' && r.projectKey===state.projectKey),
    confirmation:a=>records.find(r=>r.collection==='confirms' && r.id===a.id),
    saveClient:async(next,_message,ops=[])=>{
      saves++;
      for(const op of ops) {
        const index = records.findIndex(r=>r.collection===op.path[0] && r.id===op.path[1]);
        if(index>=0)records.splice(index,1);
        if(!op.delete)records.push({ ...clone(op.data), collection:op.path[0], id:op.path[1] });
      }
      state.clients[next.slug] = clone(next);
    },
  };
  const api = runInNewContext(`${recoverySource}; ({ archive, restoreTrash });`, context);
  return { ...api, state, records, saves:()=>saves, entry:()=>Object.entries(state.clients.client.trash)[0] };
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
  assert.equal(entry.records.length,4);
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

test('approval archive/restore includes the existing confirmation',async()=>{
  const h = recoveryHarness();
  await h.archive('approval',{ dataset:{ id:'approval' } });
  assert.equal(h.state.clients.client.projects.p.approvals.length,0);
  assert.equal(h.records.some(r=>r.id==='approval'),false);
  const [id] = h.entry();
  await h.restoreTrash('client',id);
  assert.equal(h.state.clients.client.projects.p.approvals[0].id,'approval');
  assert.equal(h.records.find(r=>r.id==='approval').confirmedAt,'2026-09-24T00:00:00.000Z');
});

test('recovery refuses project collisions and missing parents without writing',async()=>{
  const h = recoveryHarness();
  await h.archive('project',{ dataset:{} });
  const [id] = h.entry();
  h.state.clients.client.projects.p = project('Replacement');
  await assert.rejects(h.restoreTrash('client',id),/already uses this label/);
  assert.equal(h.saves(),1);
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
    state, normalizeClient,publicSnapshot, requireAdmin:()=>{}, now:()=> '2026-09-24T00:00:00.000Z',
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
  await assert.rejects(h.saveClient(c,'Saved',Array.from({length:431},()=>({}))),/too large/);
  assert.equal(h.writes(),0);
});
