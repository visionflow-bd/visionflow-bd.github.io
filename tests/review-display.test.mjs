import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reviewPresentation,renderReviewPanel,refreshReviewCountdowns} from '../portal/review-display.js';
const pending={status:'pending',publishedAt:'2026-09-28T00:00:00Z',policyVersion:'VF-REVIEW-72H-v1',reviewHours:72};
test('display uses exact72hours and never infers acceptance from browser clock',()=>{
  const original=JSON.stringify(pending),at=Date.parse(pending.publishedAt);
  assert.equal(reviewPresentation(pending,at).countdown,'72h 0m remaining');
  assert.equal(reviewPresentation(pending,at+72*3600000).label,'Review period ended — awaiting server decision');
  assert.equal(JSON.stringify(pending),original);
  assert.equal(reviewPresentation({...pending,reviewHours:48},at).label,'Manual review required');
  assert.equal(reviewPresentation({...pending,deadline:'2026-09-30T00:00:00Z'},at).label,'Manual review required');
});
test('explicit and deemed acceptance remain distinct; cancelled and legacy never count down',()=>{
  assert.equal(reviewPresentation({...pending,status:'client-confirmed'}).label,'Client confirmed');
  assert.match(reviewPresentation({...pending,status:'deemed-accepted'}).label,/not explicitly confirmed/);
  for(const status of ['cancelled','objected','blocked','awaiting-notification','manual-review'])assert.equal(reviewPresentation({...pending,status}).countdown,null);
  assert.equal(reviewPresentation({verifyDeadline:'2020-01-01'}).countdown,null);
});
test('review panel scopes projects and escapes dynamic content without linking arbitrary text',()=>{
  const html=renderReviewPanel({projectKey:'p',reviews:[{...pending,projectKey:'p',title:'<img onerror="bad()">'},{...pending,projectKey:'other',title:'OTHER PROJECT'}],notices:[{projectKey:'p',message:'<script>bad()</script>'}],now:Date.parse(pending.publishedAt)});
  assert.ok(html.includes('&lt;img'));assert.equal(html.includes('<script>'),false);assert.equal(html.includes('OTHER PROJECT'),false);
  assert.match(html,/not a signature, payment verification or download authorization/);
});
test('countdown DOM refresh changes text only at expiry',()=>{
  const node={dataset:{reviewCountdown:'1000'},textContent:''};
  refreshReviewCountdowns({querySelectorAll:()=>[node]},1000);
  assert.equal(node.textContent,'Review period ended — awaiting server decision');
  assert.deepEqual(node.dataset,{reviewCountdown:'1000'});
});
test('only actionable client reviews offer explicit controls; waiting windows never show a countdown',()=>{
  const reviews=[{...pending,requestId:'r1',projectKey:'p'},{requestId:'r2',projectKey:'p',status:'awaiting-review-notification'},{requestId:'r3',projectKey:'p',status:'deemed-accepted'}];
  const html=renderReviewPanel({reviews,canRespond:true,now:Date.parse(pending.publishedAt)});
  assert.equal((html.match(/data-action="confirm-review"/g)||[]).length,2);
  assert.equal((html.match(/data-review-countdown=/g)||[]).length,1);
  assert.ok(!renderReviewPanel({reviews,canRespond:false}).includes('data-action="confirm-review"'));
  assert.equal(reviewPresentation(reviews[1]).countdown,null);
});
test('review keeps original objection visible beside admin response without unsafe markup',()=>{
  const html=renderReviewPanel({reviews:[{id:'r1',requestId:'r1',status:'objected'}],confirms:[{id:'r1',requestId:'r1',kind:'rejection-pending',rejectReason:'Original <script>objection</script>'}],feedbackReviews:{r1:{response:'We will correct <img> it.',status:'in-progress'}}});
  assert.ok(html.includes('Original &lt;script&gt;objection'));assert.ok(html.includes('We will correct &lt;img&gt;'));assert.ok(html.includes('in-progress'));
  assert.ok(!html.includes('<script>'));assert.ok(!html.includes('data-action="confirm-review"'));
});
test('feedback replies are informational and never ask the client to confirm or object',()=>{
  const r={...pending,requestId:'rep1',id:'rep1',projectKey:'p',noticeKind:'feedback-reply',title:'Your feedback on "Storyboard" was reviewed'};
  const html=renderReviewPanel({reviews:[r],notices:[{id:'rep1',projectKey:'p',noticeKind:'feedback-reply',title:r.title,message:'Closed.'}],canRespond:true});
  assert.ok(html.includes('no action needed'));
  assert.ok(!html.includes('confirm-review'));assert.ok(!html.includes('reject-review'));
});
test('a custom title that imitates a feedback reply still asks the client to act',()=>{
  const r={...pending,requestId:'adv1',id:'adv1',projectKey:'p',noticeKind:'custom',title:'Your feedback on "client concern" - please confirm'};
  const html=renderReviewPanel({reviews:[r],notices:[{id:'adv1',projectKey:'p',noticeKind:'custom',title:r.title,message:'Please confirm.'}],canRespond:true});
  assert.ok(!html.includes('no action needed'));
  assert.ok(html.includes('confirm-review'));assert.ok(html.includes('reject-review'));
});
