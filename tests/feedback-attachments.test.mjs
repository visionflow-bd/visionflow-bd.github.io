import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareFeedbackAttachments,attachmentMeta,attachmentDownloadBytes,validateAttachmentSubmission,ATTACHMENT_BYTES} from '../portal/feedback-attachments.js';
import {submitReviewEvidence} from '../portal/review-submissions.js';
import {buildProjectReport} from '../portal/report.js';
import {normalizeClient} from '../portal/data.js';
const context={id:'feedback-one',collection:'confirms',projectKey:'p',itemNumber:1,timestamp:'synthetic'};
const file=(name='notes.txt',body='Please revise the ending.')=>new File([body],name);
const prepared=()=>prepareFeedbackAttachments([file()],context);
test('bounded documents preserve exact bytes, Unicode text, digest and source metadata',async()=>{
  const body='Feedback \u09ac\u09be\u0982\u09b2\u09be';
  const [record]=await prepareFeedbackAttachments([file('notes.txt',body)],context);
  assert.equal(record.content,Buffer.from(body).toString('base64'));
  assert.equal(record.feedbackId,context.id);assert.equal(record.projectKey,'p');
  assert.equal(record.id,'feedback-one-a1');assert.match(record.sha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(Buffer.from(await attachmentDownloadBytes(record,attachmentMeta(record),context)),Buffer.from(body));
  assert.equal(Object.hasOwn(attachmentMeta(record),'content'),false);
});
test('unsupported types, deceptive filenames, bad magic, sizes, UTF-8 and count fail before write',async()=>{
  for(const f of [file('x.html'),file('x.svg'),file('../x.pdf'),file('x\u202Efdp.pdf'),file('fake.pdf'),file('empty.txt',''),file('binary.txt',new Uint8Array([255])),file('nul.txt','\0'),file('huge.txt','a'.repeat(ATTACHMENT_BYTES+1))])await assert.rejects(prepareFeedbackAttachments([f],context));
  await assert.rejects(prepareFeedbackAttachments([file(),file(),file(),file()],context),/at most 3/);
  const [max]=await prepareFeedbackAttachments([file('max.txt','a'.repeat(ATTACHMENT_BYTES))],context);
  assert.equal(max.size,ATTACHMENT_BYTES);assert.equal((await attachmentDownloadBytes(max,attachmentMeta(max),context)).length,ATTACHMENT_BYTES);
});
test('download rejects changed bytes, digest, metadata and cross-project/source substitution',async()=>{
  const [r]=await prepared(),meta=attachmentMeta(r);
  for(const patch of [{content:Buffer.from('x'.repeat(r.size)).toString('base64')},{size:1},{sha256:'0'.repeat(64)},{feedbackId:'other'},{feedbackCollection:'feedback'},{projectKey:'other'},{name:'other.txt'}])await assert.rejects(attachmentDownloadBytes({...r,...patch},meta,context));
});
test('actual submission helper commits source, all files, guard and outbox atomically',async()=>{
  const records=await prepared(),data={kind:'feedback',projectKey:'p',itemNumber:1,message:'Review',attachments:records.map(attachmentMeta)};
  const root='portal_public/token',writes=new Map();
  await submitReviewEvidence({root,collection:'confirms',id:context.id,data,attachments:records,timestamp:context.timestamp,transaction:fn=>fn({get:async p=>p===root?{eventQueueVersion:1,clientSlug:'client'}:p.endsWith('/review_guards/p')?{revision:2}:null,set:(p,d)=>writes.set(p,d)})});
  assert.equal(writes.size,4);assert.deepEqual(writes.get(`${root}/attachments/${records[0].id}`),records[0]);
  assert.equal(writes.get(`${root}/review_guards/p`).revision,3);
  assert.ok([...writes.keys()].some(p=>p.startsWith('portal_outbox/')));
  assert.throws(()=>validateAttachmentSubmission({...context,records:[],attachments:data.attachments}));
  assert.throws(()=>validateAttachmentSubmission({...context,records,attachments:[{...data.attachments[0],id:'other'}]}));
});
test('report includes escaped attachment metadata without content, hashes or download credentials',()=>{
  const c=normalizeClient({name:'Client',projects:{p:{name:'Project',items:[]}}},'c');
  const html=buildProjectReport({client:c,project:c.projects.p,feedback:[{message:'Review',attachments:[{name:'<img>.txt',size:14,content:'SECRET-BYTES',sha256:'SECRET-HASH',url:'https://private.invalid/token'}]}]});
  assert.match(html,/&lt;img&gt;\.txt \(14 bytes\)/);assert.doesNotMatch(html,/SECRET-BYTES|SECRET-HASH|private\.invalid/);
});
