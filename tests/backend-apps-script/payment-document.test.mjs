import {test} from 'node:test';
import assert from 'node:assert/strict';
import {paymentChanges} from '../../portal/payment-notification.js';
import {paymentDocument,paymentDocumentHtml,createPaymentAttachment} from '../../backend/apps-script/payment-document.mjs';
import {createMailAdapter} from '../../backend/apps-script/runtime/adapters.mjs';

const proof='https://res.cloudinary.com/dohlemsrz/image/upload/v123/visionflow/proofs/synthetic.png';
const payment={id:'p1',amount:100,date:'2026-10-02',type:'Bank transfer',proofUrl:proof};
const document=()=>paymentDocument({ok:true,portal:{name:'Synthetic Client'},project:{name:'Demo',payments:[payment]},source:{paymentChanges:paymentChanges([],[payment])}},[['Total recorded','BDT 100.00']],'https://visionflow-bd.github.io/portal/?access=synthetic#notice-test');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1kAAAAASUVORK5CYII=','base64');
function deps(){
  const calls=[];let html='';
  return {calls,get html(){return html;},urlFetch:{fetch:(url,options)=>{calls.push({url,options});return {getResponseCode:()=>200,getBlob:()=>({getContentType:()=> 'image/png',getBytes:()=>[...png]})};}},utilities:{base64Encode:bytes=>Buffer.from(bytes).toString('base64')},htmlService:{createHtmlOutput:value=>{html=value;return {getAs:type=>{assert.equal(type,'application/pdf');return {getBytes:()=>[...Buffer.from('%PDF-synthetic')],setName:name=>({name})};}};}}};
}

test('proof document includes only the changed current proof and never payment notes',()=>{
  const doc=document();assert.equal(doc.proofs.length,1);assert.equal(doc.proofs[0].url,proof);
  const html=paymentDocumentHtml(doc,[`data:image/png;base64,${png.toString('base64')}`]);
  assert.match(html,/Supporting payment proof 1/);assert.match(html,/not bank-issued proof/);
  assert.doesNotMatch(html,/res.cloudinary.com/);
  assert.throws(()=>paymentDocumentHtml(doc,[]),/incomplete/);
  for(const url of ['http://127.0.0.1/a','https://res.cloudinary.com/evil/image/upload/visionflow/proofs/a.png',proof+'?other=secret',proof.replace('/proofs/','/signatures/'),proof.replace('/synthetic','/../synthetic')]){
    assert.throws(()=>paymentDocument({ok:true,portal:{},project:{payments:[{...payment,proofUrl:url}]},source:{paymentChanges:paymentChanges([],[payment])}},[],''),/location/);
  }
});

test('attachment embeds verified image bytes with no redirects or remote images in the PDF HTML',()=>{
  const f=deps(),pdf=createPaymentAttachment(document(),f);
  assert.equal(pdf.name,'VisionFlow-payment-record.pdf');assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].options.followRedirects,false);assert.match(f.html,/data:image\/png;base64,/);assert.doesNotMatch(f.html,/res.cloudinary.com/);
});

test('invalid content, redirects, conversion failures and deceptive MIME block attachment preparation',()=>{
  for(const response of [
    {getResponseCode:()=>302},
    {getResponseCode:()=>200,getBlob:()=>({getContentType:()=> 'text/html',getBytes:()=>[1,2,3]})},
    {getResponseCode:()=>200,getBlob:()=>({getContentType:()=> 'image/png',getBytes:()=>[60,104,116,109,108,62]})},
  ]){const f=deps();f.urlFetch.fetch=()=>response;assert.throws(()=>createPaymentAttachment(document(),f));}
  const f=deps();f.htmlService.createHtmlOutput=()=>({getAs:()=>({getBytes:()=>[1,2,3]})});
  assert.throws(()=>createPaymentAttachment(document(),f),/conversion/);
});

test('MailApp receives a PDF blob, not an arbitrary attachment supplied by a caller',async()=>{
  const sent=[],blob={name:'verified.pdf'},identity={expectedSender:'owner@example.invalid',session:{getEffectiveUser:()=>({getEmail:()=> 'owner@example.invalid'})}};
  const adapter=createMailAdapter({...identity,mailApp:{sendEmail:m=>sent.push(m)},paymentAttachment:doc=>{assert.equal(doc.schemaVersion,1);return blob;}});
  await adapter.send({to:'c@example.invalid',paymentDocument:document(),attachments:[{evil:true}]});
  assert.deepEqual(sent[0].attachments,[blob]);
  const failing=createMailAdapter({...identity,mailApp:{sendEmail:()=>assert.fail('no send after conversion failure')},paymentAttachment:()=>{throw Error('conversion');}});
  await assert.rejects(failing.send({paymentDocument:document()}),e=>e.notAccepted===true);
});
