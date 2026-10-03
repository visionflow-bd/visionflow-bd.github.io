import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {buildEmail,emailLinks} from '../backend/apps-script/worker.mjs';
import {paymentChanges} from '../portal/payment-notification.js';
import {paymentDocumentHtml} from '../backend/apps-script/payment-document.mjs';

test('isolated email and payment PDF layout at desktop/mobile sizes',{timeout:60000},async()=>{
  const require=createRequire(import.meta.url),{chromium}=require(process.env.VF_BROWSER_MODULES?path.join(process.env.VF_BROWSER_MODULES,'playwright'):'playwright');
  const output=process.env.VF_EMAIL_ARTIFACTS;if(!output)throw Error('Set VF_EMAIL_ARTIFACTS to a task-specific directory on D:.');
  await mkdir(output,{recursive:true});
  const browser=await chromium.launch({headless:true,channel:'chrome'});
  try{
    const page=await browser.newPage({viewport:{width:820,height:1100}});
    const logo=await readFile(new URL('../logo.png',import.meta.url));
    await page.route('https://visionflow-bd.github.io/logo.png',route=>route.fulfill({body:logo,contentType:'image/png'}));
    const before=[{id:'p1',amount:250,date:'2026-10-01',type:'Advance'}],after=[{...before[0],amount:350,proofUrl:'https://res.cloudinary.com/dohlemsrz/image/upload/v123/visionflow/proofs/synthetic.png'}];
    const context={ok:true,portalToken:'synthetic-only',portal:{name:'Synthetic Partner',clientSlug:'synthetic'},project:{name:'Brand Film / October',budget:1000,payments:after},source:{schemaVersion:1,eventType:'payment-notification',paymentChanges:paymentChanges(before,after)}};
    const event={eventType:'payment-notification',projectKey:'film',sourceId:'payment-update'};
    const [client,admin]=buildEmail(event,{client:'client@example.invalid',admin:'admin@example.invalid'},{context});
    for(const [name,message] of [['client',client],['admin',admin]]){
      await page.setViewportSize({width:820,height:1100});await page.setContent(message.htmlBody);await page.locator('img').evaluate(img=>img.decode());
      const links=emailLinks(event,context,name);
      assert.equal(await page.getByRole('link',{name:'All projects',exact:true}).getAttribute('href'),links.overview);
      assert.equal(await page.getByRole('link',{name:'Review this update',exact:true}).getAttribute('href'),links.action);
      assert.equal(await page.locator('img').evaluate(img=>img.naturalWidth>0),true);
      await page.screenshot({path:path.join(output,`${name}-desktop.png`),fullPage:true});
      await writeFile(path.join(output,`${name}-preview.html`),message.htmlBody);
      await page.setViewportSize({width:360,height:850});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Email must not overflow mobile');
      await page.screenshot({path:path.join(output,`${name}-mobile.png`),fullPage:true});
    }
    await page.setViewportSize({width:700,height:430});
    await page.setContent('<div style="padding:45px;font:22px Georgia;background:#f3f6f7;border:8px solid #0f766e"><h1>SYNTHETIC PAYMENT PROOF</h1><p>Layout test only - no real transaction</p><p>Amount: BDT 350.00</p><p>Date: 2026-10-01</p><p>Reference: EXAMPLE-001</p></div>');
    const proof=(await page.screenshot()).toString('base64');
    await page.setContent(paymentDocumentHtml(client.paymentDocument,[`data:image/png;base64,${proof}`]));
    await page.pdf({path:path.join(output,'payment-record-synthetic.pdf'),format:'A4',printBackground:true,preferCSSPageSize:true});
    assert.equal(await page.getByText('Supporting payment proof 1',{exact:true}).count(),1);
  }finally{await browser.close();}
});
