import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {initializeTestEnvironment} from '@firebase/rules-unit-testing';
import {doc,setDoc,getDoc,getDocs,collection,updateDoc} from 'firebase/firestore';
import {normalizeClient,publicSnapshot,prepareSecureSave,clone} from '../portal/data.js';
import {verifyFounderEditor} from './helpers/founder-browser.mjs';

// Run only with the local Firestore emulator. No real client or email is used.
test('real browser: consent, one master signature, gated download, changed-project acknowledgement and mobile', {timeout:120000}, async()=>{
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8088');
  const require=createRequire(import.meta.url);
  const {chromium}=require(process.env.VF_BROWSER_MODULES?path.join(process.env.VF_BROWSER_MODULES,'playwright'):'playwright');
  const root=path.resolve(import.meta.dirname,'..'),projectId='demo-visionflow-browser';
  const rules=await readFile(path.join(root,'firestore.rules'),'utf8');
  const environment=await initializeTestEnvironment({projectId,firestore:{rules}});
  async function emulatorRules(content){const r=await fetch(`http://127.0.0.1:8088/emulator/v1/projects/${projectId}:securityRules`,{method:'PUT',body:JSON.stringify({rules:{files:[{content}]}})});assert.equal(r.ok,true,await r.text());}
  const token='browser-test-only-0123456789abcdef0123456789abcdef';
  let client=normalizeClient({name:'Synthetic Browser Client',accessToken:token,projects:{first:{name:'First Project',rate:400,budget:400,items:[{n:1,t:'Synthetic video',s:'delivered',dl:'https://example.invalid/authorized-final'}]},second:{name:'Second Project',rate:500,budget:500,items:[{n:1,s:'pending'}]}}},'browser-client');
  async function save(next,previous={}){const manifests=prepareSecureSave(next,previous);await environment.withSecurityRulesDisabled(async c=>{
    await setDoc(doc(c.firestore(),'site/main'),{});
    await setDoc(doc(c.firestore(),'portal_clients',next.slug),next);
    await setDoc(doc(c.firestore(),'portal_public',token),publicSnapshot(next,next.slug));
    for(const m of manifests)await setDoc(doc(c.firestore(),'portal_public',token,...m.path),m.data);
  });}
  await save(client);
  const server=createServer(async(req,res)=>{try{
    const url=new URL(req.url,'http://localhost'),relative=decodeURIComponent(url.pathname==='/'?'/portal/index.html':url.pathname);
    const file=path.resolve(root,'.'+relative+(relative.endsWith('/')?'index.html':''));
    if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
    let body=await readFile(file);
    if(file===path.join(root,'portal','workspace.js')){
      let source=body.toString().replace('getFirestore, collection','getFirestore, connectFirestoreEmulator, collection');
      source=source.replace("projectId:'visionflow-bd'",`projectId:'${projectId}'`);
      source=source.replace('db = getFirestore(firebaseApp);',"db = getFirestore(firebaseApp); connectFirestoreEmulator(db,'127.0.0.1',8088,initialAccess?{}:{mockUserToken:{sub:'m1PGSw7ViEb1xOJoj8INQllra3p1',email:'shihabjessore7@gmail.com'}});");
      source=source.replace('else onAuthStateChanged(auth,async user=>{',"else (callback=>callback({uid:'m1PGSw7ViEb1xOJoj8INQllra3p1'}))(async user=>{");
      source=source.replace('observeAuth:listener=>onAuthStateChanged(auth,user=>listener(user?.uid===ADMIN_UID))','observeAuth:listener=>{listener(true);return ()=>{};}');
      body=Buffer.from(source);
    }
    res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.css':'text/css','.png':'image/png'})[path.extname(file)]||'application/octet-stream');res.end(body);
  }catch{res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({channel:'msedge',headless:true});
    const context=await browser.newContext(),page=await context.newPage(),errors=[];
    await context.route('https://example.invalid/**',route=>route.fulfill({contentType:'text/html',body:'Synthetic authorized delivery'}));
    page.on('pageerror',e=>errors.push(e.message));
    const url=`http://127.0.0.1:${server.address().port}/portal/?access=${token}`;
    await page.goto(url+'#master-agreement');
    await page.locator('#consent-checkbox').waitFor();
    assert.equal(await page.locator('#consent-submit').isDisabled(),true);
    await page.locator('.consent-scroll').evaluate(el=>{el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll'));});
    await page.locator('#consent-checkbox').check();
    // Reject a real server write; optimistic local events must not grant entry.
    await emulatorRules(rules.replace("data.type == 'terms-acceptance'","false && data.type == 'terms-acceptance'"));
    await page.locator('#consent-submit').click();
    await page.getByText('Your consent could not be saved. Check your connection and retry.',{exact:true}).waitFor();
    assert.equal(await page.locator('[data-action="master-sign"]').count(),0);
    assert.equal(await page.locator('#consent-submit').isEnabled(),true);
    await emulatorRules(rules);
    await page.locator('#consent-submit').click();
    await page.locator('[data-action="master-sign"]').waitFor();
    assert.equal(new URL(page.url()).hash,'#master-agreement','Consent/render must preserve the exact email destination');
    if(process.env.VF_BROWSER_SCREENSHOTS){await mkdir(process.env.VF_BROWSER_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.VF_BROWSER_SCREENSHOTS,'welcome.png'),fullPage:true});}
    assert.equal((await page.content()).includes('authorized-final'),false);
    // PDF/report must be available without enumerating protected deliveries.
    await page.locator('[data-action="open-project"][data-project="first"]').first().click();
    await page.locator('[data-action="report"]').first().click();
    const reportFrame=page.frameLocator('iframe.report-frame');
    await reportFrame.getByText('Master signature pending.',{exact:true}).waitFor();
    const reportDownload=page.waitForEvent('download',{timeout:90000});
    await reportFrame.getByRole('button',{name:'Download PDF',exact:true}).click();
    const reportBytes=await readFile(await (await reportDownload).path());
    assert.equal(reportBytes.subarray(0,5).toString(),'%PDF-','Portal report iframe must produce a real PDF download');
    assert.ok(reportBytes.length>5000,'Portal report PDF must not be an empty placeholder');
    await page.locator('[data-action="close-modal"]').first().click();
    await page.locator('[data-action="master-sign"]').first().click();
    await page.locator('#f-name').fill('Synthetic Test Signer');
    const box=await page.locator('#signatureCanvas').boundingBox();
    await page.mouse.move(box.x+20,box.y+40);await page.mouse.down();await page.mouse.move(box.x+130,box.y+70,{steps:12});await page.mouse.up();
    await page.locator('#modalForm input[name="agree"]').check();
    await page.locator('#modalForm button[type="submit"]').click();
    await page.locator('#modalLayer').waitFor({state:'hidden'});
    await page.locator('[data-action="tab-log"]').first().click();
    await page.locator('[data-action="gated-download"]').waitFor();
    const popupPromise=page.waitForEvent('popup');await page.locator('[data-action="gated-download"]').first().click();
    const popup=await popupPromise;await popup.waitForURL('https://example.invalid/authorized-final');
    assert.equal(popup.url(),'https://example.invalid/authorized-final');await popup.close();
    // A second device uses stored consent/master, not localStorage.
    const secondContext=await browser.newContext({viewport:{width:390,height:844}}),mobile=await secondContext.newPage();
    await mobile.goto(url+'&p=second');await mobile.locator('#master-agreement').waitFor();
    assert.equal(await mobile.locator('#consent-checkbox').count(),0);
    assert.equal(await mobile.locator('[data-action="master-sign"]').count(),0);
    assert.ok(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'Mobile must not overflow horizontally');
    if(process.env.VF_BROWSER_SCREENSHOTS)await mobile.screenshot({path:path.join(process.env.VF_BROWSER_SCREENSHOTS,'mobile-signed.png'),fullPage:true});
    const next=clone(client);next.projects.first.budget=450;await save(next,client);client=next;
    await page.locator('[data-action="sign-required"]').waitFor();await page.locator('[data-action="sign-required"]').first().click();
    await page.getByRole('heading',{name:'Review project particulars'}).waitFor();
    assert.equal(await page.locator('#signatureCanvas').count(),0,'Acknowledgement never asks for a new drawing');
    if(process.env.VF_BROWSER_SCREENSHOTS)await page.screenshot({path:path.join(process.env.VF_BROWSER_SCREENSHOTS,'project-acknowledgement.png'),fullPage:true});
    await page.locator('#modalForm input[name="agree"]').check();await page.locator('#modalForm button[type="submit"]').click();
    await page.locator('[data-action="gated-download"]').waitFor();
    const publicData=publicSnapshot(client,client.slug);
    await environment.withSecurityRulesDisabled(async c=>{
      assert.equal((await getDoc(doc(c.firestore(),'portal_public',token,'agreements',publicData.masterAgreement.version))).exists(),true);
      assert.equal((await getDoc(doc(c.firestore(),'portal_public',token,'acknowledgements',publicData.projects.first.ackId))).exists(),true);
      const events=(await getDocs(collection(c.firestore(),'portal_outbox'))).docs.map(d=>d.data());
      assert.deepEqual(events.map(e=>e.eventType).sort(),['consent-complete','master-signed','project-acknowledged']);
      await setDoc(doc(c.firestore(),'portal_public',token,'review_guards','first'),{revision:0});
      await setDoc(doc(c.firestore(),'portal_public',token,'reviews','display-test'),{projectKey:'first',title:'Synthetic 72-hour review',status:'pending',publishedAt:new Date().toISOString(),policyVersion:'VF-REVIEW-72H-v1',reviewHours:72});
      await setDoc(doc(c.firestore(),'portal_public',token,'notices','display-test'),{projectKey:'first',title:'Delivery notice',message:'Synthetic visible update'});
    });
    await page.getByText('Synthetic 72-hour review',{exact:true}).waitFor();
    await page.getByText('Synthetic visible update',{exact:true}).waitFor();
    assert.match(await page.locator('[data-review-countdown]').textContent(),/remaining/);
    await environment.withSecurityRulesDisabled(async c=>{await updateDoc(doc(c.firestore(),'portal_public',token,'reviews','display-test'),{status:'deemed-accepted'});});
    await page.getByText('Deemed accepted — not explicitly confirmed',{exact:true}).waitFor();
    assert.equal(await page.locator('[data-review-countdown]').count(),0);
    await page.locator('[data-action="tab-overview"]').first().click();
    await page.locator('[data-action="feedback-project"]').first().click();
    await page.locator('#f-message').fill('Please revise this synthetic delivery before acceptance.');
    const feedbackBytes=Buffer.from('Private synthetic attachment.');
    await page.locator('#f-attachments').setInputFiles({name:'revision-notes.txt',mimeType:'text/plain',buffer:feedbackBytes});
    await page.locator('#modalForm button[type="submit"]').click();
    await page.locator('#modalLayer').waitFor({state:'hidden'});
    await page.getByText('Please revise this synthetic delivery before acceptance.',{exact:true}).waitFor();
    const attachmentButton=page.locator('[data-action="download-feedback-attachment"]').first(),downloadEvent=page.waitForEvent('download');
    await attachmentButton.click();const attachmentDownload=await downloadEvent;
    assert.equal(attachmentDownload.suggestedFilename(),'revision-notes.txt');
    assert.deepEqual(await readFile(await attachmentDownload.path()),feedbackBytes);
    await environment.withSecurityRulesDisabled(async c=>{
      const guard=(await getDoc(doc(c.firestore(),'portal_public',token,'review_guards','first'))).data();
      assert.equal(guard.revision,1);
      const response=(await getDoc(doc(c.firestore(),'portal_public',token,'confirms',guard.lastSubmissionId))).data();
      assert.equal(response.kind,'feedback');assert.equal(response.projectKey,'first');
      assert.equal(response.attachments.length,1);assert.equal(response.attachments[0].name,'revision-notes.txt');
      const attached=(await getDoc(doc(c.firestore(),'portal_public',token,'attachments',response.attachments[0].id))).data();
      assert.equal(attached.content,feedbackBytes.toString('base64'));
      assert.equal(attached.uploadedAt.toMillis(),response.submittedAt.toMillis());
      assert.equal(response.submittedAt.toMillis(),guard.updatedAt.toMillis());
    });
    // Exact review controls commit their own immutable response and shared state.
    await environment.withSecurityRulesDisabled(async c=>{
      await updateDoc(doc(c.firestore(),'portal_public',token),{'projects.first.notificationRevision':1});
      for(const id of ['browser-confirm','browser-object'])await setDoc(doc(c.firestore(),'portal_public',token,'reviews',id),{
        requestId:id,projectKey:'first',sourceVersion:'revision-1',projectRevision:1,reviewEpoch:0,status:'awaiting-review-notification',revision:0,title:id,
      });
    });
    await page.locator('[data-action="confirm-review"][data-id="browser-confirm"]').click();
    await page.locator('#modalForm input[type="checkbox"]').check();
    await page.locator('#modalForm button[type="submit"]').click();await page.locator('#modalLayer').waitFor({state:'hidden'});
    await page.locator('#review-browser-confirm').getByText('Client confirmed',{exact:true}).waitFor();
    await page.locator('[data-action="reject-review"][data-id="browser-object"]').click();
    await page.locator('#f-reason').fill('Please correct this specific update before proceeding.');
    await page.locator('#modalForm button[type="submit"]').click();await page.locator('#modalLayer').waitFor({state:'hidden'});
    await page.locator('#review-browser-object').getByText('Objection received',{exact:true}).waitFor();
    await environment.withSecurityRulesDisabled(async c=>{
      const decision=(await getDoc(doc(c.firestore(),'portal_public',token,'confirms','browser-object'))).data();
      assert.equal(decision.kind,'rejection-pending');assert.equal(decision.requestId,'browser-object');
      assert.equal((await getDoc(doc(c.firestore(),'portal_public',token,'review_guards','first'))).data().revision,3);
      assert.equal((await getDocs(collection(c.firestore(),'portal_outbox'))).size,6);
    });
    await page.locator('[data-action="tab-log"]').first().click();
    await environment.withSecurityRulesDisabled(async c=>{await updateDoc(doc(c.firestore(),'portal_public',token,'agreements',publicData.masterAgreement.version),{revoked:true});});
    await page.locator('[data-action="sign-required"]').waitFor();
    assert.equal(await page.locator('[data-action="gated-download"]').count(),0,'Revocation removes download actions');
    // Admin role is injected ONLY by this local test server, never production.
    const adminContext=await browser.newContext(),adminPage=await adminContext.newPage();
    adminPage.on('pageerror',error=>errors.push(error.message));
    await adminPage.goto(`http://127.0.0.1:${server.address().port}/portal/`);
    await verifyFounderEditor(adminPage,{
      readSite:async()=>{let value;await environment.withSecurityRulesDisabled(async c=>{value=(await getDoc(doc(c.firestore(),'site/main'))).data();});return value;},
      updateSite:value=>environment.withSecurityRulesDisabled(async c=>updateDoc(doc(c.firestore(),'site/main'),value)),
    });
    await adminPage.locator('[data-action="email-settings"]').click();
    assert.equal(await adminPage.locator('input[name="enabled"]').isChecked(),false);
    await adminPage.locator('input[name="enabled"]').check();
    await adminPage.locator('#f-adminEmail').fill('synthetic-team@example.invalid');
    await adminPage.locator('#f-clientSenderName').fill('Synthetic Client Desk');
    await adminPage.locator('#f-clientReplyTo').fill('synthetic-reply@example.invalid');
    await adminPage.locator('#modalForm button[type="submit"]').click();await adminPage.locator('#modalLayer').waitFor({state:'hidden'});
    await adminPage.locator('[data-action="notification-status"]').click();
    await adminPage.getByRole('heading',{name:'Notification queue',exact:true}).waitFor();
    await adminPage.getByText('confirmation-received',{exact:true}).first().waitFor();
    assert.equal(await adminPage.locator('#modalContent').textContent().then(t=>t.includes(token)),false,'Queue status must not display client token');
    await adminPage.locator('[data-action="close-modal"]').first().click();
    await adminPage.locator('[data-action="open-client"][data-client="browser-client"]').click();
    await adminPage.locator('[data-action="open-project"][data-project="first"]').click();
    await adminPage.locator('[data-action="edit-project"]').click();
    await adminPage.locator('#f-scope').fill('Synthetic changed scope for atomic admin save.');
    await adminPage.locator('#modalForm button[type="submit"]').click();
    await adminPage.getByText('Synthetic changed scope for atomic admin save.',{exact:true}).first().waitFor();
    await environment.withSecurityRulesDisabled(async c=>{
      const prefs=(await getDoc(doc(c.firestore(),'portal_settings','notifications'))).data();
      assert.equal(prefs.enabled,true);assert.equal(prefs.clientSenderName,'Synthetic Client Desk');assert.equal(prefs.clientReplyTo,'synthetic-reply@example.invalid');
      assert.equal(prefs.clientWebhookUrl,undefined);
      const reviews=(await getDocs(collection(c.firestore(),'portal_reviews'))).docs.map(d=>d.data());
      assert.equal(reviews.length,1);assert.equal(reviews[0].status,'awaiting-notification');assert.equal(reviews[0].publishedAt,undefined);
      const current=(await getDoc(doc(c.firestore(),'portal_public',token))).data();
      assert.equal(current.projects.first.notificationRevision,reviews[0].projectRevision);
    });
    if(await adminPage.locator('#modalLayer').isVisible())await adminPage.locator('[data-action="close-modal"]').first().click();
    await adminPage.locator('[data-action="review-feedback"][data-id="browser-object"]').click();
    await adminPage.locator('#f-response').fill('Synthetic correction is now ready for your new review.');
    await adminPage.locator('#f-status').selectOption('resolved');
    await adminPage.locator('#modalForm button[type="submit"]').click();await adminPage.locator('#modalLayer').waitFor({state:'hidden'});
    await adminPage.getByText('Synthetic correction is now ready for your new review.',{exact:true}).first().waitFor();
    await environment.withSecurityRulesDisabled(async c=>{
      assert.equal((await getDoc(doc(c.firestore(),'portal_public',token,'reviews','browser-object'))).data().status,'objected','Response must retain original objection outcome');
      assert.equal((await getDocs(collection(c.firestore(),'portal_reviews'))).size,2,'Admin response should publish a new bound update');
    });
    // Recycle/restore must preserve file bytes and the original immutable source.
    const feedbackId=await adminPage.locator('[data-action="download-feedback-attachment"]').first().getAttribute('data-id');
    await adminPage.locator(`[data-action="review-feedback"][data-id="${feedbackId}"]`).click();
    await adminPage.locator('[data-action="archive-feedback"]').click();
    await adminPage.locator('dialog [data-choice="continue"]').click();
    await adminPage.locator('#modalLayer').waitFor({state:'hidden'});
    await environment.withSecurityRulesDisabled(async c=>{
      assert.equal((await getDocs(collection(c.firestore(),'portal_public',token,'attachments'))).size,0);
      assert.equal((await getDoc(doc(c.firestore(),'portal_public',token,'feedback',feedbackId))).exists(),false);
    });
    // The committed transaction may resolve before the server-confirmed listener renders.
    await adminPage.locator('[data-action="download-feedback-attachment"]').waitFor({state:'detached'});
    assert.equal(await adminPage.locator('[data-action="download-feedback-attachment"]').count(),0);
    await adminPage.locator('[data-action="trash"]').click();
    await adminPage.locator('[data-action="preview-trash"]').click();
    await adminPage.locator('#modalLayer summary').filter({hasText:'revision-notes.txt'}).waitFor();
    assert.equal((await adminPage.locator('#modalLayer').textContent()).includes(feedbackBytes.toString('base64')),false);
    const archivedDownload=adminPage.waitForEvent('download');
    await adminPage.locator('[data-action="download-archived-attachment"]').click();
    assert.deepEqual(await readFile(await (await archivedDownload).path()),feedbackBytes);
    await adminPage.locator('[data-action="close-modal"]').first().click();
    await adminPage.locator('[data-action="restore-trash"]').click();
    await adminPage.getByText('The recycle bin is empty.',{exact:true}).waitFor();
    await adminPage.goto(`http://127.0.0.1:${server.address().port}/portal/?c=browser-client&p=first`);
    const restoredDownload=adminPage.waitForEvent('download');
    await adminPage.locator('[data-action="download-feedback-attachment"]').first().click();
    assert.deepEqual(await readFile(await (await restoredDownload).path()),feedbackBytes);
    await adminContext.close();
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));await environment.cleanup();}
});
