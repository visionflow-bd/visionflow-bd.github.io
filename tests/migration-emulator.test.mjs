import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planSecureMigration} from '../portal/migration.js';

// The REST commit itself is exercised, not a mocked transaction implementation.
// Never allow this test to target any production project or network endpoint.
test('migration REST commit is atomic, preserves timestamps and rejects concurrent changes',{timeout:30000},async()=>{
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8088');
  const base='http://127.0.0.1:8088/v1/projects/demo-visionflow-migration/databases/(default)/documents';
  const root='projects/demo-visionflow-migration/databases/(default)/documents';
  const encode=x=>x===null?{nullValue:null}:typeof x==='string'?{stringValue:x}:typeof x==='boolean'?{booleanValue:x}:typeof x==='number'?{integerValue:String(x)}:Array.isArray(x)?{arrayValue:{values:x.map(encode)}}:{mapValue:{fields:Object.fromEntries(Object.entries(x).map(([k,v])=>[k,encode(v)]))}};
  const decode=x=>x.mapValue?Object.fromEntries(Object.entries(x.mapValue.fields||{}).map(([k,v])=>[k,decode(v)])):x.arrayValue?(x.arrayValue.values||[]).map(decode):x.integerValue!==undefined?Number(x.integerValue):x.timestampValue??x.stringValue??x.booleanValue??null;
  const request=(suffix,method='GET',body)=>fetch(base+suffix,{method,headers:{Authorization:'Bearer owner','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const commit=writes=>request(':commit','POST',{writes});
  const token='migration-emulator-token',name=root+'/portal_clients/migration-test',publicName=root+'/portal_public/'+token;
  const client={name:'Synthetic migration',accessToken:token,_revision:2,projects:{project:{name:'Project',rate:400,budget:400,items:[{n:1,s:'delivered',dl:'https://example.invalid/private-file'}],payments:[{id:'p1',amount:200}]}}};
  const fields=encode(client).mapValue.fields;fields.evidenceAt={timestampValue:'2026-09-01T10:20:30.123456Z'};
  let response=await commit([{update:{name,fields}},{update:{name:publicName,fields:encode({clientSlug:'migration-test',enabled:true,portalVersion:5}).mapValue.fields}}]);
  assert.equal(response.ok,true,await response.text());
  const read=async suffix=>{const r=await request(suffix);assert.equal(r.ok,true);return r.json();};
  let privateDocument=await read('/portal_clients/migration-test'),publicDocument=await read('/portal_public/'+token);
  const options={encode,decode,now:'2026-09-28T02:00:00.000Z',deliveryDocuments:[]};
  let plan=planSecureMigration(privateDocument,publicDocument,options);
  // Another owner edit after planning must reject the WHOLE migration commit.
  response=await commit([{update:{name,fields:{_revision:encode(3)}},updateMask:{fieldPaths:['_revision']}}]);assert.equal(response.ok,true);
  response=await commit(plan.writes);assert.equal(response.ok,false);
  assert.equal(decode((await read('/portal_public/'+token)).fields.portalVersion),5);
  assert.equal((await request('/portal_public/'+token+'/deliveries/project')).status,404);
  privateDocument=await read('/portal_clients/migration-test');plan=planSecureMigration(privateDocument,publicDocument,options);
  response=await commit(plan.writes);assert.equal(response.ok,true,await response.text());
  const migrated=await read('/portal_clients/migration-test'),published=await read('/portal_public/'+token),manifest=await read('/portal_public/'+token+'/deliveries/project');
  assert.deepEqual(migrated.fields.evidenceAt,privateDocument.fields.evidenceAt);
  assert.deepEqual(migrated.fields.projects.mapValue.fields.project.mapValue.fields.payments,privateDocument.fields.projects.mapValue.fields.project.mapValue.fields.payments);
  assert.equal(JSON.stringify(published).includes('private-file'),false);
  assert.equal(decode(manifest.fields.links)['1'],'https://example.invalid/private-file');
  assert.equal(planSecureMigration(migrated,published,{...options,deliveryDocuments:[manifest]}).alreadyCurrent,true);
});
