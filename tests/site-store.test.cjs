const {test}=require('node:test');
const assert=require('node:assert/strict');
const store=require('../site/store.js');
const fixture=()=>({site:{agency:{name:'Agency',tagline:'Before'},contact:{phone:'123'}},portfolio:[{id:'one',title:'Original'}],meta:{updatedAt:2,revision:3}});
function harness(current){const writes=[];return {writes,transaction:fn=>fn({get:async()=>current,set:(path,data)=>writes.push({path,data})})};}

test('site saves preserve independent remote edits without trusting browser clocks',async()=>{
  const base=fixture(),draft=store.clone(base),remote=fixture();draft.site.agency.name='Local';remote.site.contact.phone='456';remote.meta.updatedAt=9999999999999;
  const h=harness(remote),result=await store.save({base,draft,transaction:h.transaction,now:()=>1});
  assert.equal(result.site.agency.name,'Local');assert.equal(result.site.contact.phone,'456');assert.equal(result.meta.revision,4);assert.equal(result.meta.updatedAt,1);
  assert.equal(base.site.agency.name,'Agency');assert.equal(h.writes.length,1);
});
test('same-field changes, stale list edits and remote deletion reject without writes',async()=>{
  for(const change of [value=>value.site.agency.name='Remote',value=>delete value.site.agency]){
    const base=fixture(),draft=store.clone(base),remote=fixture();draft.site.agency.name='Local';change(remote);const h=harness(remote);
    await assert.rejects(store.save({base,draft,transaction:h.transaction}),{code:'site/conflict'});assert.equal(h.writes.length,0);
  }
  const base=fixture(),draft=store.clone(base),remote=fixture();draft.portfolio[0].title='Local';remote.portfolio=[];const h=harness(remote);
  await assert.rejects(store.save({base,draft,transaction:h.transaction}),{code:'site/conflict'});assert.equal(h.writes.length,0);
});
test('local deletion and independent remote addition merge without defaults resurrecting deleted data',()=>{
  assert.deepEqual(store.merge({a:{x:1},b:1},{b:1},{a:{x:1},b:2,c:3}),{b:2,c:3});
  assert.deepEqual(store.merge({a:[]},{a:[]},{a:[],b:4}),{a:[],b:4});
});
test('site save strips private fields and handles key order or duplicate completion',async()=>{
  const base=fixture(),draft=store.clone(base);draft.site.agency.name='Updated';draft.leads=[{private:'secret'}];draft.notifications={secret:'relay'};draft.site.notifications={secret:'nested'};
  const remote=store.clone(draft),h=harness(remote),result=await store.save({base,draft,transaction:h.transaction});
  assert.equal(result.leads,undefined);assert.equal(result.notifications,undefined);assert.equal(result.site.notifications,undefined);
  assert.ok(store.equal({x:1,y:2},{y:2,x:1}));assert.equal(result.site.agency.name,'Updated');
});
test('missing cloud document or corrupt revision cannot publish local defaults',async()=>{
  for(const remote of [null,{...fixture(),meta:{revision:-1}},{...fixture(),meta:{revision:Number.MAX_SAFE_INTEGER}}]){
    const h=harness(remote);await assert.rejects(store.save({base:fixture(),draft:fixture(),transaction:h.transaction}));assert.equal(h.writes.length,0);
  }
});
test('transaction retry recomputes against fresh server state and propagates permission failure',async()=>{
  const base=fixture(),draft=store.clone(base);draft.site.agency.name='Updated';let calls=0;
  const remote=fixture();await store.save({base,draft,transaction:async fn=>{await fn({get:async()=>remote,set:()=>{}});remote.site.contact.phone='New';calls++;const result=await fn({get:async()=>remote,set:(_p,data)=>assert.equal(data.site.contact.phone,'New')});calls++;return result;}});
  assert.equal(calls,2);
  await assert.rejects(store.save({base,draft,transaction:()=>Promise.reject(Object.assign(Error('denied'),{code:'permission-denied'}))}),{code:'permission-denied'});
});

test('editing a missing default field creates only the explicit change and still detects a race',async()=>{
  const raw={site:{agency:{name:'Stored'}},meta:{revision:1}},view={site:{agency:{name:'Stored',tagline:'Default'},academy:{name:'Display only'}},portfolio:[],meta:{revision:1}},draft=store.clone(view);
  draft.site.agency.tagline='Explicit';
  const desired=store.projectDraft(raw,view,draft);
  assert.deepEqual(desired,{site:{agency:{name:'Stored',tagline:'Explicit'}},meta:{revision:1}});
  assert.deepEqual(store.projectDraft(raw,view,view),raw);
  const h=harness(raw),saved=await store.save({base:raw,draft:desired,transaction:h.transaction});
  assert.equal(saved.site.agency.tagline,'Explicit');assert.equal(saved.site.academy,undefined);assert.equal(saved.portfolio,undefined);
  const remote=store.clone(raw);remote.site.agency.tagline='Remote';
  await assert.rejects(store.save({base:raw,draft:desired,transaction:harness(remote).transaction}),{code:'site/conflict'});
});
