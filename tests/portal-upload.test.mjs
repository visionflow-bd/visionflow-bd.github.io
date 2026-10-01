import {test} from 'node:test';
import assert from 'node:assert/strict';
import {uploadPortalImage,portalImageResult,validatePortalImage} from '../portal/image-upload.js';
import {founderBranding,saveFounderBranding} from '../portal/founder-branding.js';

const asset=purpose=>`https://res.cloudinary.com/dohlemsrz/image/upload/v123/visionflow/${purpose}/synthetic.png`;
const file={type:'image/png',size:100};
function transport({immediateAuth=false}={}){
  const calls={requests:[],removed:0,aborted:0,progress:[],created:0};let listener,allowed=true;
  const xhr={upload:{},open(method,url){calls.created++;calls.method=method;calls.url=url;},send(body){calls.requests.push(body);},abort(){calls.aborted++;this.onabort?.();}};
  return {calls,xhr,setAuth(value){allowed=value;listener?.(value);},options:{authorize(){if(!allowed)throw Error('Administrator sign-in is required.');},
    observeAuth(callback){listener=callback;if(immediateAuth)callback(false);return ()=>{calls.removed++;listener=null;};},onProgress:value=>calls.progress.push(value),
    xhrFactory:()=>xhr,formFactory:()=>({fields:[],append(...args){this.fields.push(args);}})},
    respond({status=200,body={resource_type:'image',secure_url:asset('proofs')}}={}){xhr.status=status;xhr.responseText=typeof body==='string'?body:JSON.stringify(body);xhr.onload();}};
}

test('portal image types, nonempty size and purpose are checked before any request',async()=>{
  for(const purpose of ['proofs','signatures']){
    const max=(purpose==='proofs'?10:20)*1024*1024;
    assert.doesNotThrow(()=>validatePortalImage({...file,size:max},purpose));
    for(const invalid of [null,{...file,size:0},{...file,size:-1},{...file,size:max+1},{...file,size:1.5},{...file,type:'image/svg+xml'}]){
      const t=transport();await assert.rejects(uploadPortalImage(invalid,purpose,t.options));assert.equal(t.calls.created,0);
    }
  }
  assert.throws(()=>validatePortalImage(file,'unexpected'));
  assert.throws(()=>validatePortalImage({...file,type:'image/jpeg'},'signatures'));
  await assert.rejects(uploadPortalImage(file,'proofs'),/authorization/);
});

test('portal response requires an exact cloud, resource type and root folder',()=>{
  assert.equal(portalImageResult({resource_type:'image',secure_url:asset('proofs')},'proofs'),asset('proofs'));
  for(const value of [asset('signatures'),asset('proofs').replace('https:','http:'),asset('proofs').replace('dohlemsrz','foreign'),
    asset('proofs').replace('/image/','/video/'),asset('proofs').replace('/v123/','/v123/other/'),asset('proofs').replace('res.cloudinary.com','res.cloudinary.com.evil.invalid'),
    asset('proofs').replace('res.cloudinary.com','user:pass@res.cloudinary.com'),asset('proofs')+'?next=anything',asset('proofs')+'#fragment',
    asset('proofs').replace('synthetic.png',''),asset('proofs').replace('/synthetic.png','/../wrong.png')]){
    assert.throws(()=>portalImageResult({resource_type:'image',secure_url:value},'proofs'));
  }
  for(const type of ['video',undefined,'raw'])assert.throws(()=>portalImageResult({resource_type:type,secure_url:asset('proofs')},'proofs'));
});

test('upload builds the exact form, reports progress and unsubscribes only after response',async()=>{
  for(const purpose of ['proofs','signatures']){
    const t=transport(),result=uploadPortalImage(file,purpose,t.options);
    assert.equal(t.calls.requests.length,1);assert.equal(t.calls.method,'POST');
    assert.equal(t.calls.url,'https://api.cloudinary.com/v1_1/dohlemsrz/image/upload');assert.equal(t.xhr.timeout,90000);
    assert.deepEqual(t.calls.requests[0].fields,[[...(purpose==='signatures'?['file',file,'founder-signature.png']:['file',file])],['upload_preset','visionflow'],['folder',`visionflow/${purpose}`]]);
    t.xhr.upload.onprogress({lengthComputable:true,loaded:200,total:100});assert.deepEqual(t.calls.progress,[100]);assert.equal(t.calls.removed,0);
    t.respond({body:{resource_type:'image',secure_url:asset(purpose)}});assert.equal(await result,asset(purpose));assert.equal(t.calls.removed,1);
    t.xhr.onload();assert.equal(t.calls.removed,1);
  }
});

test('upload rejects non-2xx, malformed, foreign and misleading provider success without retrying',async()=>{
  for(const response of [{status:0},{status:199},{status:302},{status:429},{status:500},{body:'private-provider-invalid-json'},
    {body:{secure_url:asset('proofs')}},{body:{resource_type:'image',secure_url:asset('signatures')}}]){
    const t=transport(),result=uploadPortalImage(file,'proofs',t.options);t.respond(response);
    await assert.rejects(result,error=>!error.message.includes('private-provider'));assert.equal(t.calls.requests.length,1);assert.equal(t.calls.removed,1);
  }
});

test('network, timeout and cancellation stay uncertain and never retry',async()=>{
  for(const event of ['onerror','ontimeout','onabort']){
    const t=transport(),result=uploadPortalImage(file,'proofs',t.options);t.xhr[event]();
    await assert.rejects(result,/media library before retrying/);assert.equal(t.calls.requests.length,1);assert.equal(t.calls.removed,1);
  }
});

test('admin auth loss before or during upload cannot send or resolve late success',async()=>{
  const initial=transport();initial.setAuth(false);await assert.rejects(uploadPortalImage(file,'proofs',initial.options),/Administrator/);assert.equal(initial.calls.created,0);
  const synchronous=transport({immediateAuth:true});await assert.rejects(uploadPortalImage(file,'proofs',synchronous.options),/access ended/);
  assert.equal(synchronous.calls.requests.length,0);assert.equal(synchronous.calls.removed,1);
  const t=transport(),result=uploadPortalImage(file,'proofs',t.options);t.setAuth(false);
  await assert.rejects(result,/access ended/);assert.equal(t.calls.aborted,1);assert.equal(t.calls.removed,1);
  t.respond();assert.equal(t.calls.removed,1);assert.equal(t.calls.requests.length,1);
});

const fallback={signatureUrl:asset('signatures'),name:'Original founder',title:'Founder'};
const baseline={site:{agency:{founderName:fallback.name,founderTitle:fallback.title,founderSignature:fallback.signatureUrl},contact:{phone:'Keep'}},meta:{revision:4}};
function brandingHarness(current=structuredClone(baseline)){
  let writes=0,allowed=true;
  return {current,writes:()=>writes,setAuth:value=>{allowed=value;},options:{expected:fallback,next:{...fallback,name:'Updated'},fallback,authorize(){if(!allowed)throw Error('No admin');},now:()=>100,
    transaction:async fn=>fn({get:async()=>current,update(path,fields){assert.equal(path,'site/main');writes++;for(const [key,value] of Object.entries(fields)){
      const parts=key.split('.');let target=current;for(const part of parts.slice(0,-1))target=target[part]??={};target[parts.at(-1)]=value;
    }}})}};
}

test('founder transaction preserves unrelated fields and advances the shared site revision',async()=>{
  const h=brandingHarness();h.current.site.contact.phone='Newer independent edit';
  await saveFounderBranding(h.options);assert.equal(h.current.site.agency.founderName,'Updated');
  assert.equal(h.current.site.contact.phone,'Newer independent edit');assert.equal(h.current.meta.revision,5);assert.equal(h.current.meta.updatedAt,100);assert.equal(h.writes(),1);
  assert.equal(founderBranding({founderSignature:''},fallback).signatureUrl,'','Intentional removal must not restore the fallback image');
});

test('stale founder edits, missing document, invalid input and auth loss do not write',async()=>{
  const changed=brandingHarness();changed.current.site.agency.founderSignature=asset('signatures').replace('synthetic','new');
  await assert.rejects(saveFounderBranding(changed.options),/changed elsewhere/);assert.equal(changed.writes(),0);
  const missing=brandingHarness(null);await assert.rejects(saveFounderBranding(missing.options),/missing/);assert.equal(missing.writes(),0);
  const invalid=brandingHarness();invalid.options.next.name='';await assert.rejects(saveFounderBranding(invalid.options),/authorized name/);assert.equal(invalid.writes(),0);
  const loggedOut=brandingHarness();loggedOut.setAuth(false);await assert.rejects(saveFounderBranding(loggedOut.options),/No admin/);assert.equal(loggedOut.writes(),0);
  const staleAuth=brandingHarness(),original=staleAuth.options.transaction;staleAuth.options.transaction=fn=>{staleAuth.setAuth(false);return original(fn);};
  await assert.rejects(saveFounderBranding(staleAuth.options),/No admin/);assert.equal(staleAuth.writes(),0);
});
