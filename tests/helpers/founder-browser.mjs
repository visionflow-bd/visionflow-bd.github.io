import assert from 'node:assert/strict';

// Called only by the local emulator journey. Cloudinary is intercepted here;
// the production upload endpoint must never receive synthetic test data.
export async function verifyFounderEditor(page,{readSite,updateSite}){
  const context=page.context(),uploads=[];
  const image=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=120;
    const ctx=canvas.getContext('2d');ctx.strokeStyle='#17233a';ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(15,60);ctx.lineTo(80,20);ctx.lineTo(100,95);ctx.lineTo(290,35);ctx.stroke();
    return canvas.toDataURL('image/png');
  });
  const uploaded='https://res.cloudinary.com/dohlemsrz/image/upload/v123/visionflow/signatures/synthetic.png';
  await context.route('https://api.cloudinary.com/**',async route=>{
    uploads.push(route.request().postDataBuffer());
    await route.fulfill({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'application/json',body:JSON.stringify({resource_type:'image',secure_url:uploaded})});
  });
  await context.route(uploaded,route=>route.fulfill({contentType:'image/png',body:Buffer.from(image.split(',')[1],'base64')}));
  const inputFile={name:'synthetic-signature.png',mimeType:'image/png',buffer:Buffer.from(image.split(',')[1],'base64')};
  const open=async()=>{await page.locator('[data-action="founder-signature"]').click();await page.locator('#f-founderName').waitFor();};
  const submit=()=>page.locator('#modalForm [type="submit"]');
  const close=()=>page.locator('[data-action="close-modal"]').first().click();

  await open();const original=await page.locator('#f-founderName').inputValue();
  await page.evaluate(()=>{
    window.__originalBitmap=createImageBitmap;
    window.createImageBitmap=async(...args)=>{await new Promise(resolve=>window.__releaseSignature=resolve);return window.__originalBitmap(...args);};
  });
  await page.locator('#f-founderSignatureFile').setInputFiles(inputFile);
  await page.waitForFunction(()=>typeof window.__releaseSignature==='function');assert.equal(await submit().isDisabled(),true);
  await close();await open();
  const before=await page.locator('#founderSignaturePreview').getAttribute('src');
  await page.evaluate(()=>{window.__releaseSignature();window.createImageBitmap=window.__originalBitmap;});
  await page.waitForFunction(()=>!document.querySelector('#f-founderSignatureFile').disabled);
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#founderSignaturePreview').getAttribute('src'),before,'A closed editor must not receive a late prepared image');
  assert.equal(uploads.length,0);

  await page.locator('#f-founderSignatureFile').setInputFiles({name:'broken.png',mimeType:'image/png',buffer:Buffer.from('not an image')});
  await page.locator('#modalForm .form-error').filter({hasText:/./}).waitFor();
  await submit().click();await page.locator('#modalForm .form-error').filter({hasText:'The selected signature could not be prepared. Choose another image or draw a signature.'}).waitFor();
  assert.equal(uploads.length,0);await close();

  await open();await page.locator('#f-founderSignatureFile').setInputFiles(inputFile);
  await page.waitForFunction(()=>document.querySelector('#founderSignaturePreview').src.startsWith('blob:'));
  assert.equal(await submit().isEnabled(),true);
  const preview=await page.locator('#founderSignaturePreview').evaluate(async img=>{await img.decode();return {width:img.naturalWidth,height:img.naturalHeight};});
  assert.ok(preview.width>0&&preview.width<=1200&&preview.height<=460);
  await page.locator('#f-founderName').fill('Synthetic founder');await submit().click();await page.locator('#modalLayer').waitFor({state:'hidden'});
  let site=await readSite();assert.equal(site.site.agency.founderSignature,uploaded);assert.equal(site.site.agency.founderName,'Synthetic founder');assert.equal(site.meta.revision,1);assert.equal(uploads.length,1);
  assert.ok(uploads[0].includes(Buffer.from('visionflow/signatures')));

  await open();await page.locator('#f-founderName').fill('Stale replacement');
  await updateSite({'site.agency.founderName':'Other tab founder'});
  await submit().click();await page.getByText(/Founder details changed elsewhere/).first().waitFor();
  site=await readSite();assert.equal(site.site.agency.founderName,'Other tab founder');assert.equal(site.meta.revision,1);await close();

  await open();await page.locator('#f-founderName').fill(original);await page.locator('input[name="removeSignature"]').check();
  await submit().click();await page.locator('#modalLayer').waitFor({state:'hidden'});
  site=await readSite();assert.equal(site.site.agency.founderSignature,'');assert.equal(site.meta.revision,2);
  await open();assert.equal(await page.locator('#founderSignaturePreview').getAttribute('src'),null,'Removed signature must not reappear from defaults');await close();
  assert.equal(uploads.length,1);
}
