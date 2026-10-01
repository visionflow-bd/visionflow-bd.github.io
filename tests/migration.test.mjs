import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planSecureMigration} from '../portal/migration.js';
import {clone} from '../portal/data.js';
const encode=x=>x===null?{nullValue:null}:typeof x==='string'?{stringValue:x}:typeof x==='boolean'?{booleanValue:x}:typeof x==='number'?{integerValue:String(x)}:Array.isArray(x)?{arrayValue:{values:x.map(encode)}}:{mapValue:{fields:Object.fromEntries(Object.entries(x).map(([k,v])=>[k,encode(v)]))}};
const decode=x=>x.mapValue?Object.fromEntries(Object.entries(x.mapValue.fields||{}).map(([k,v])=>[k,decode(v)])):x.arrayValue?(x.arrayValue.values||[]).map(decode):x.integerValue!==undefined?Number(x.integerValue):x.stringValue!==undefined?x.stringValue:x.booleanValue!==undefined?x.booleanValue:null;
const base='projects/demo-visionflow-migration/databases/(default)/documents';
const fixture=()=>({name:base+'/portal_clients/shishir',updateTime:'2026-09-28T00:00:00.000Z',fields:encode({name:'Synthetic client',accessToken:'synthetic-token',_revision:8,projects:{k9:{name:'K9',rate:400,budget:40000,items:[{n:1,dl:'https://example.invalid/final'}],payments:[{id:'p',amount:7000}],approvals:[]}}}).mapValue.fields});
const options={decode,encode,now:'2026-09-28T01:00:00.000Z',deliveryDocuments:[]};
test('migration preserves raw financial/history fields and requires source updateTime',()=>{
  const source=fixture(),copy=clone(source),plan=planSecureMigration(source,null,options);
  assert.deepEqual(source,copy);assert.equal(plan.writes.length,3);
  const privateFields=plan.writes[0].update.fields.projects.mapValue.fields.k9.mapValue.fields;
  for(const key of ['rate','budget','payments','items'])assert.deepEqual(privateFields[key],copy.fields.projects.mapValue.fields.k9.mapValue.fields[key]);
  assert.equal(decode(plan.writes[0].update.fields._revision),9);
  assert.equal(plan.writes[0].currentDocument.updateTime,source.updateTime);
  assert.deepEqual(plan.writes[1].currentDocument,{exists:false});
  assert.equal(JSON.stringify(plan.writes[1]).includes('https://example.invalid/final'),false);
  assert.equal(plan.writes[2].update.fields.links.mapValue.fields['1'].stringValue,'https://example.invalid/final');
});
test('migration rerun of its committed result is a no-op',()=>{
  const first=planSecureMigration(fixture(),null,options);
  const privateDocument={...first.writes[0].update,updateTime:'2026-09-28T01:00:00.000Z'};
  const publicDocument={...first.writes[1].update,updateTime:'2026-09-28T01:00:00.000Z'};
  const deliveryDocuments=first.writes.slice(2).map(w=>({...w.update,updateTime:privateDocument.updateTime}));
  const repeat=planSecureMigration(privateDocument,publicDocument,{...options,deliveryDocuments});
  assert.equal(repeat.alreadyCurrent,true);assert.equal(repeat.writes.length,0);
});
test('current version does not hide a missing manifest or a stale public snapshot',()=>{
  const first=planSecureMigration(fixture(),null,options),updateTime=options.now;
  const privateDocument={...first.writes[0].update,updateTime},publicDocument={...first.writes[1].update,updateTime};
  const repair=planSecureMigration(privateDocument,publicDocument,options);
  assert.equal(repair.alreadyCurrent,false);assert.equal(repair.manifestCount,1);
  assert.deepEqual(repair.writes[2].currentDocument,{exists:false});
  const deliveryDocuments=first.writes.slice(2).map(w=>({...w.update,updateTime}));
  publicDocument.fields.projects.mapValue.fields.k9.mapValue.fields.scope=encode('Stale public scope');
  const stale=planSecureMigration(privateDocument,publicDocument,{...options,deliveryDocuments});
  assert.equal(stale.alreadyCurrent,false);assert.equal(stale.manifestCount,0);
  assert.equal(stale.writes[1].currentDocument.updateTime,updateTime);
});
test('manifest repairs use exact updateTime preconditions and do not mutate source',()=>{
  const first=planSecureMigration(fixture(),null,options),updateTime=options.now;
  const privateDocument={...first.writes[0].update,updateTime},publicDocument={...first.writes[1].update,updateTime};
  const existing={...clone(first.writes[2].update),updateTime};
  existing.fields.links=encode({'1':'https://example.invalid/stale'});
  const copy=clone(existing),plan=planSecureMigration(privateDocument,publicDocument,{...options,deliveryDocuments:[existing]});
  assert.equal(plan.writes[2].currentDocument.updateTime,updateTime);assert.deepEqual(existing,copy);
  assert.equal(plan.writes[2].update.fields.links.mapValue.fields['1'].stringValue,'https://example.invalid/final');
});
test('uninspected, unversioned, foreign and legacy manifests fail closed',()=>{
  assert.throws(()=>planSecureMigration(fixture(),null,{...options,deliveryDocuments:undefined}),/complete delivery/);
  for(const name of [base+'/portal_public/other/deliveries/k9',base+'/portal_public/synthetic-token/deliveries/k9/extra']){
    assert.throws(()=>planSecureMigration(fixture(),null,{...options,deliveryDocuments:[{name,updateTime:options.now}]}),/manifest source/);
  }
  const legacy={name:base+'/portal_public/synthetic-token/deliveries/k9-1',updateTime:options.now,fields:{}};
  assert.throws(()=>planSecureMigration(fixture(),null,{...options,deliveryDocuments:[legacy]}),/legacy delivery/);
  assert.throws(()=>planSecureMigration(fixture(),{name:base+'/portal_public/synthetic-token',fields:{}},options),/versioned public/);
});
test('migration size guard counts UTF-8 bytes, including Bangla',()=>{
  const source=fixture();source.fields.privateNote=encode('ক'.repeat(310000));
  assert.throws(()=>planSecureMigration(source,null,options),/too large/);
});
test('migration fails closed on paused-public mismatch, recovery or wrong client binding',()=>{
  const source=fixture(),publicDocument={name:base+'/portal_public/synthetic-token',updateTime:source.updateTime,fields:encode({clientSlug:'shishir',enabled:false,portalVersion:5}).mapValue.fields};
  assert.throws(()=>planSecureMigration(source,publicDocument,options),/paused/);
  const recovering=fixture();recovering.fields.accessRotation=encode({from:'old'});
  assert.throws(()=>planSecureMigration(recovering,null,options),/recovery/);
  publicDocument.fields.enabled=encode(true);publicDocument.fields.clientSlug=encode('different-client');
  assert.throws(()=>planSecureMigration(source,publicDocument,options),/another client/);
});
