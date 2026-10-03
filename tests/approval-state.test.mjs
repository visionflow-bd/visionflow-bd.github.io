import {test} from 'node:test';
import assert from 'node:assert/strict';
import {approvalState,approvalDeadline,deliveryApprovalFor,ensureDeliveryApprovals,downloadDecision,linkFingerprint,REVIEW_WINDOW_MS} from '../portal/approval-state.js';
import {normalizeClient,publicSnapshot} from '../portal/data.js';
import {renderReviewPanel,countdownHtml,refreshReviewCountdowns} from '../portal/review-display.js';

const T0='2026-10-03T00:00:00.000Z',t0=Date.parse(T0);
const client=()=>normalizeClient({name:'C',accessToken:'tok',projects:{k9:{name:'K9',items:[
  {n:1,t:'Intro',s:'delivered',dl:'https://drive.google.com/file/d/secretA/view'},
  {n:2,t:'Second',s:'pending',dl:''},
  {n:3,t:'Third',s:'delivered',dl:'https://drive.google.com/file/d/secretC/view'}],approvals:[]}}},'c');

test('72h window: pending, deemed at exactly 72h, explicit responses win',()=>{
  const a={id:'a',createdAt:T0};
  assert.equal(approvalDeadline(a),t0+REVIEW_WINDOW_MS);
  assert.equal(approvalState(a,null,t0+1000).state,'pending');
  assert.equal(approvalState(a,null,t0+REVIEW_WINDOW_MS-1).state,'pending');
  assert.equal(approvalState(a,null,t0+REVIEW_WINDOW_MS).state,'deemed');
  assert.equal(approvalState(a,{confirmedAt:T0},t0+REVIEW_WINDOW_MS*2).state,'confirmed');
  assert.equal(approvalState(a,{kind:'rejection-pending'},t0+REVIEW_WINDOW_MS*2).state,'rejection-pending');
  assert.equal(approvalState(a,{kind:'rejected'},t0).state,'rejected');
  assert.equal(approvalState({id:'old'},null,t0+REVIEW_WINDOW_MS*9).state,'pending','no createdAt never auto-accepts');
});

test('every delivered item gets exactly one verification request; ids are stable and links stay private',()=>{
  const c=client();
  assert.deepEqual(ensureDeliveryApprovals(c,T0),[]);
  const rows=c.projects.k9.approvals;
  assert.deepEqual(rows.map(a=>[a.id,a.kind,a.itemNumber]),[['delivery-k9-1','delivery',1],['delivery-k9-3','delivery',3]]);
  assert.deepEqual(ensureDeliveryApprovals(c,'2026-10-04T00:00:00Z'),[]);
  assert.equal(rows.length,2,'idempotent');
  const pub=JSON.stringify(publicSnapshot(c,'c'));
  assert.equal(pub.includes('secretA'),false);assert.equal(pub.includes('deliveryRef'),false);
  assert.ok(publicSnapshot(c,'c').approvalIds.includes('delivery-k9-3'));
  assert.equal(publicSnapshot(c,'c').projects.k9.approvals[0].itemNumber,1);
});

test('legacy "Deliverable N" approval is adopted without changing its id (existing confirmation stays valid)',()=>{
  const c=client();c.projects.k9.approvals.push({id:'approval-old',title:'Deliverable 1 — Delivered',desc:'x',createdAt:T0});
  ensureDeliveryApprovals(c,T0);
  const a=deliveryApprovalFor(c.projects.k9,1);
  assert.equal(a.id,'approval-old');assert.equal(a.kind,'delivery');
  assert.equal(c.projects.k9.approvals.filter(x=>x.itemNumber===1).length,1);
});

test('replacing a delivery link restarts the window and clears the old response',()=>{
  const c=client();ensureDeliveryApprovals(c,T0);
  c.projects.k9.items[0].dl='https://drive.google.com/file/d/secretA2/view';
  assert.deepEqual(ensureDeliveryApprovals(c,'2026-10-05T00:00:00.000Z'),['delivery-k9-1']);
  assert.equal(deliveryApprovalFor(c.projects.k9,1).createdAt,'2026-10-05T00:00:00.000Z');
  assert.notEqual(linkFingerprint('a'),linkFingerprint('b'));
});

test('verify-to-download gate',()=>{
  const c=client();ensureDeliveryApprovals(c,T0);const p=publicSnapshot(c,'c').projects.k9;
  const item=p.items.find(i=>i.n===1),none=()=>null;
  assert.deepEqual([downloadDecision(p,item,none,t0).allowed,downloadDecision(p,item,none,t0).reason],[false,'pending']);
  assert.equal(downloadDecision(p,item,()=>({confirmedAt:T0}),t0).allowed,true);
  assert.equal(downloadDecision(p,item,()=>({kind:'rejection-pending'}),t0).allowed,false);
  assert.equal(downloadDecision(p,item,()=>({kind:'rejected'}),t0+REVIEW_WINDOW_MS*3).allowed,false,'rejected never auto-unlocks');
  assert.equal(downloadDecision(p,item,none,t0+REVIEW_WINDOW_MS).reason,'deemed');
  assert.equal(downloadDecision(p,p.items.find(i=>i.n===2),none,t0).allowed,false,'no file, no download');
  const legacy={items:[{n:5,hasDelivery:true}],approvals:[]};
  assert.equal(downloadDecision(legacy,legacy.items[0],none,t0).reason,'legacy');
});

test('review history shows each update once, newest first, with older entries collapsed',()=>{
  const mk=(i,status='awaiting-notification')=>({id:`r${i}`,requestId:`r${i}`,projectKey:'k9',title:`Update ${i}`,status,createdAt:new Date(t0+i*1000).toISOString()});
  const reviews=[1,2,3,4,5,6].map(i=>mk(i)),notices=reviews.map(r=>({id:r.id,projectKey:'k9',title:r.title,message:`Message ${r.id}`,createdAt:r.createdAt}));
  const html=renderReviewPanel({reviews,notices,projectNames:{k9:'K9'},now:t0});
  assert.equal((html.match(/id="review-r/g)||[]).length,6);assert.equal((html.match(/id="notice-/g)||[]).length,0);
  assert.ok(html.indexOf('Update 6')<html.indexOf('Update 1'));
  assert.match(html,/Show 2 older updates/);assert.match(html,/K9/);assert.match(html,/Message r6/);
  const admin=renderReviewPanel({reviews,notices,canManage:true,now:t0});
  assert.equal(admin.includes('not a signature'),false,'client legal footer is not shown to admin');
});

test('approval countdown carries its own expiry text',()=>{
  const html=countdownHtml(t0+3600000,t0,'Counted as accepted');
  assert.match(html,/data-expired-text="Counted as accepted"/);
  const node={dataset:{reviewCountdown:String(t0),expiredText:'Counted as accepted'},textContent:''};
  refreshReviewCountdowns({querySelectorAll:()=>[node]},t0+1);assert.equal(node.textContent,'Counted as accepted');
  assert.equal(countdownHtml(t0,t0+1),'');
});

test('a dismissed rejection closes the item for good: no timer, no pending state, delivery released',()=>{
  const c=client();ensureDeliveryApprovals(c,T0);
  const a=deliveryApprovalFor(c.projects.k9,1);
  const rejection={kind:'rejection-pending',rejectReason:'wrong colour'};
  assert.equal(approvalState(a,rejection,t0+1000).state,'rejection-pending');
  Object.assign(a,{closure:'dismissed',closedAt:'2026-10-03T01:00:00.000Z',closeReason:'Agreed earlier.'});
  // Long after the original 72h window it stays closed (never "deemed" or "pending").
  assert.equal(approvalState(a,rejection,t0+5*REVIEW_WINDOW_MS).state,'dismissed');
  assert.equal(approvalState(a,null,t0).state,'dismissed');
  const d=downloadDecision(c.projects.k9,{n:1,hasDelivery:true},()=>rejection,t0);
  assert.equal(d.allowed,true);assert.equal(d.reason,'dismissed');
  // The closure is published to the client view so both sides agree.
  const pub=publicSnapshot(c,'c').projects.k9.approvals.find(x=>x.id===a.id);
  assert.equal(pub.closure,'dismissed');assert.equal(pub.closeReason,'Agreed earlier.');
});

test('a new delivery file after a dismissal starts a fresh item window instead of reviving the old one',()=>{
  const c=client();ensureDeliveryApprovals(c,T0);
  const a=deliveryApprovalFor(c.projects.k9,1);
  Object.assign(a,{closure:'dismissed',closedAt:T0,closeReason:'x'});
  c.projects.k9.items[0].dl='https://drive.google.com/file/d/secretA-v2/view';
  const later='2026-10-10T00:00:00.000Z',restarted=ensureDeliveryApprovals(c,later);
  assert.deepEqual(restarted,[a.id]);
  assert.equal(a.closure,undefined);assert.equal(a.createdAt,later);
  assert.equal(approvalState(a,null,Date.parse(later)+1000).state,'pending');
});

test('a confirmed rejection stays closed and keeps the download locked',()=>{
  const c=client();ensureDeliveryApprovals(c,T0);
  const d=downloadDecision(c.projects.k9,{n:1,hasDelivery:true},()=>({kind:'rejected',rejectReason:'r'}),t0+5*REVIEW_WINDOW_MS);
  assert.equal(d.allowed,false);assert.equal(d.reason,'rejected');
});
