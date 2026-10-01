import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';

// Actual local page/UI with explicit synthetic Auth/Firestore and intercepted
// Cloudinary responses. No production SDK, provider request or mail is allowed.
test('site browser: upload drafts, background batches, failed saves and uncropped lazy media',{timeout:90000},async()=>{
  const require=createRequire(import.meta.url),{chromium}=require(process.env.VF_BROWSER_MODULES?path.join(process.env.VF_BROWSER_MODULES,'playwright'):'playwright');
  const root=path.resolve(import.meta.dirname,'..'),errors=[],uploads=[],held=[],mode={hold:false,fail:false},server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://localhost'),relative=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname),file=path.resolve(root,'.'+relative);
      if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
      let body=await readFile(file);
      if(file===path.join(root,'index.html'))body=Buffer.from(body.toString().replace(/<script type="module">[\s\S]*?<\/script>/,`<script>
        window.__testSaves=[];window.__testSaveFail=false;window.__testHoldSave=false;window.__testSaveRelease=null;
        let syntheticCloud=null,syntheticListeners=[];
        const clone=value=>JSON.parse(JSON.stringify(value));
        const notify=()=>syntheticListeners.forEach(fn=>fn({exists:()=>!!syntheticCloud,data:()=>clone(syntheticCloud),metadata:{fromCache:false,hasPendingWrites:false}}));
        window.__testCloud=value=>{syntheticCloud=clone(value);notify();};
        const fakeUser={uid:'m1PGSw7ViEb1xOJoj8INQllra3p1',email:'shihabjessore7@gmail.com',isAnonymous:false};
        window.__fb={initializeApp:config=>({options:config}),getAuth:()=>({currentUser:fakeUser}),getFirestore:()=>({synthetic:true}),doc:(...args)=>args.slice(1).join('/'),collection:(...args)=>args.slice(1).join('/'),
          onSnapshot:(ref,...args)=>{const next=args.find(item=>typeof item==='function');if(ref!=='site/main'){next({forEach:()=>{}});return()=>{};}if(!syntheticCloud)syntheticCloud=clone(_buildSiteCloudPayload(STATE.data));syntheticListeners.push(next);notify();return()=>{syntheticListeners=syntheticListeners.filter(fn=>fn!==next);};},
          runTransaction:async(db,callback)=>{if(window.__testHoldSave)await new Promise(resolve=>window.__testSaveRelease=resolve);if(window.__testSaveFail)throw Object.assign(Error('Synthetic denied save'),{code:'permission-denied'});let pending=null;const result=await callback({get:async ref=>({exists:()=>!!syntheticCloud,data:()=>clone(syntheticCloud)}),set:(ref,value)=>{pending=clone(value);}});if(pending){syntheticCloud=pending;window.__testSaves.push({ref:'site/main',value:clone(pending)});notify();}return result;},
          onAuthStateChanged:(auth,fn)=>{window.__testAuth=user=>{auth.currentUser=user;fn(user);};fn(fakeUser);},
          setDoc:async(ref,value)=>{if(window.__testHoldSave)await new Promise(resolve=>window.__testSaveRelease=resolve);if(window.__testSaveFail)throw Object.assign(Error('Synthetic denied save'),{code:'permission-denied'});syntheticCloud=clone(value);window.__testSaves.push({ref,value:clone(value)});notify();}
        };
      </script>`));
      res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg'})[path.extname(file)]||'application/octet-stream');res.end(body);
    }catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  try{
    browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:1280,height:900}});
    const local=`http://127.0.0.1:${server.address().port}`;
    await context.route('**/*',async route=>{
      const url=route.request().url();
      if(url.startsWith(local+'/'))return route.continue();
      if(url.startsWith('https://api.cloudinary.com/v1_1/')){
        uploads.push(url);
        if(mode.hold)await new Promise(resolve=>held.push(resolve));
        if(mode.fail)return route.abort('failed');
        const [,cloud,kind]=new URL(url).pathname.match(/^\/v1_1\/([^/]+)\/(image|video)\/upload$/)||[];
        return route.fulfill({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'application/json',body:JSON.stringify({resource_type:kind,secure_url:`https://res.cloudinary.com/${cloud}/${kind}/upload/v1/result-${uploads.length}.${kind==='video'?'mp4':'png'}`,width:kind==='video'?1080:1,height:kind==='video'?1920:1})});
      }
      return route.abort();
    });
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(local);await page.waitForFunction(()=>STATE.fbReady&&STATE.isAdmin);
    await page.evaluate(()=>{
      STATE.data.cloudStorage={imageAccounts:[{cloud:'synthetic-images',preset:'test',active:true}],videoAccounts:[{cloud:'synthetic-video',preset:'test',active:true}]};
      STATE.data.portfolio=[{id:'yt',catId:'cat-video',title:'Synthetic YouTube',video:'https://youtu.be/dQw4w9WgXcQ',featured:true},{id:'reel',catId:'cat-video',title:'Synthetic portrait',video:'https://res.cloudinary.com/synthetic-video/video/upload/v1/portrait.mp4',featured:true}];__testCloud(_buildSiteCloudPayload(STATE.data));renderAll();
    });
    assert.equal(await page.evaluate(async()=>{
      const video=document.querySelector('.portfolio-media video');
      await new Promise(resolve=>setTimeout(resolve,180));
      return video.isConnected&&video===document.querySelector('.portfolio-media video');
    }),true,'A direct render cancels a queued duplicate render and preserves the media element');
    assert.equal(await page.locator('.portfolio-media iframe').count(),0);
    const reel=page.locator('.portfolio-media video').first();assert.equal(await reel.getAttribute('preload'),'none');assert.equal(await reel.evaluate(el=>getComputedStyle(el).objectFit),'contain');
    assert.doesNotMatch(await reel.getAttribute('poster'),/c_fill/);
    const thumbnail=page.locator('.portfolio-video-launch img').first();await thumbnail.hover();
    assert.equal(await thumbnail.evaluate(el=>getComputedStyle(el).transform),'none','Hover cannot crop the contained thumbnail by scaling it');
    await page.getByRole('button',{name:'Play Synthetic YouTube',exact:true}).click();
    assert.match(await page.locator('.portfolio-media iframe').getAttribute('src'),/^https:\/\/www.youtube-nocookie.com\/embed\/dQw4w9WgXcQ/);
    await page.evaluate(()=>{openAdminPanel();adminTab('cloud');});
    await page.getByRole('button',{name:'Add Image Account',exact:true}).click();
    await page.locator('#ca-cloud').fill('synthetic-extra');await page.locator('#ca-preset').fill('extra-preset');await page.locator('#ca-label').fill('Synthetic extra');
    await page.getByRole('button',{name:'Save Account',exact:true}).click();await page.getByText('Cloud account saved',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>__testSaves.at(-1).value.cloudStorage.imageAccounts.length),2);
    await page.evaluate(()=>window.__testSaveFail=true);
    await page.locator('#cloud-img-list input[type="checkbox"]').first().click();await page.locator('#cloud-img-list input[type="checkbox"]').first().waitFor({state:'visible'});
    await page.waitForFunction(()=>!_cloudSaving);assert.equal(await page.locator('#cloud-img-list input[type="checkbox"]').first().isChecked(),true);
    assert.equal(await page.evaluate(()=>STATE.data.cloudStorage.imageAccounts[0].active),true);
    await page.evaluate(()=>{window.__testSaveFail=false;adminTab('portfolio');});
    await page.getByRole('button',{name:'Add New',exact:true}).click();
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4m0AAAAASUVORK5CYII=','base64');
    const file={name:'test-image.png',mimeType:'image/png',buffer:png};
    mode.hold=true;
    await page.locator('#edit-form input[type="file"][accept="image/*"]').setInputFiles(file);
    await page.waitForFunction(()=>_mediaQueue.pending()===1);assert.equal(await page.locator('#edit-form [type="submit"]').isDisabled(),true);
    // Closing the editor preserves the job; completing it cannot overwrite a newer form.
    await page.locator('#edit-form').getByRole('button',{name:'Cancel',exact:true}).click();
    await page.getByRole('button',{name:'Add New',exact:true}).click();await page.locator('#edit-form [name="img"]').fill('https://example.invalid/new-manual-image.png');
    mode.hold=false;held.splice(0).forEach(resolve=>resolve());await page.locator('[data-media-draft]').waitFor();
    assert.equal(await page.locator('#edit-form [name="img"]').inputValue(),'https://example.invalid/new-manual-image.png');
    await page.locator('#edit-form').getByRole('button',{name:'Cancel',exact:true}).click();
    await page.getByRole('button',{name:'Create portfolio entry',exact:true}).click();
    assert.match(await page.locator('#edit-form [name="img"]').inputValue(),/synthetic-images/);
    await page.locator('#edit-form [name="title"]').fill('Reviewed synthetic portfolio');
    const before=await page.evaluate(()=>STATE.data.portfolio.length);await page.evaluate(()=>window.__testSaveFail=true);
    await page.locator('#edit-form [type="submit"]').click();await page.waitForFunction(()=>document.querySelector('#edit-form').dataset.saving==='false');
    assert.equal(await page.evaluate(()=>STATE.data.portfolio.length),before);assert.equal(await page.locator('[data-media-draft]').count(),1);
    await page.evaluate(()=>{window.__testSaveFail=false;window.__testHoldSave=true;});await page.locator('#edit-form [type="submit"]').click();
    await page.waitForFunction(()=>typeof __testSaveRelease==='function');
    assert.equal(await page.locator('#edit-form [name="title"]').isDisabled(),true,'Pending save freezes the submitted form');
    await page.evaluate(()=>{closeModal('edit-modal');editItem('portfolio',null);});
    assert.equal(await page.locator('#edit-modal').isVisible(),true,'Pending save cannot discard its editor');
    assert.equal(await page.locator('#edit-form [name="title"]').inputValue(),'Reviewed synthetic portfolio');
    await page.evaluate(()=>{window.__testHoldSave=false;window.__testSaveRelease();});await page.locator('#edit-modal').waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>STATE.data.portfolio.filter(item=>item.title==='Reviewed synthetic portfolio').length),1);assert.equal(await page.locator('[data-media-draft]').count(),0);
    // Batch jobs remain active across admin tab changes, capped at two requests.
    mode.hold=true;const baseline=uploads.length;
    await page.locator('.media-batch input[accept^="video/"]').setInputFiles([0,1,2].map(n=>({name:`synthetic-${n}.mp4`,mimeType:'video/mp4',buffer:Buffer.from('synthetic-video')})));
    await page.waitForFunction(()=>_mediaQueue.pending()===3);await page.evaluate(()=>adminTab('services'));
    await new Promise(resolve=>setTimeout(resolve,100));assert.equal(uploads.length-baseline,2);
    mode.hold=false;held.splice(0).forEach(resolve=>resolve());await page.waitForFunction(()=>_mediaQueue.pending()===0);
    assert.equal(await page.locator('[data-media-draft]').count(),3);assert.equal(uploads.length-baseline,3);
    // An HTML-looking filename must remain inert; no unsafe progress markup.
    await page.evaluate(()=>adminTab('portfolio'));await page.locator('.media-batch input[accept^="image/"]').setInputFiles({...file,name:'x"><img src=x onerror=window.__unsafe=1>.png'});
    await page.waitForFunction(()=>_mediaQueue.pending()===0&&_mediaDrafts.size===4);assert.equal(await page.evaluate(()=>window.__unsafe),undefined);
    assert.equal(await page.locator('#upload-progress-panel img').count(),0);
    const draftCount=await page.locator('[data-media-draft]').count();await page.reload();await page.waitForFunction(()=>STATE.isAdmin);await page.evaluate(()=>{openAdminPanel();adminTab('portfolio');});
    assert.equal(await page.locator('[data-media-draft]').count(),draftCount);
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.querySelector('#upload-progress-panel').getBoundingClientRect().right<=innerWidth),'Upload panel fits mobile viewport');
    if(process.env.VF_BROWSER_SCREENSHOTS){await mkdir(process.env.VF_BROWSER_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.VF_BROWSER_SCREENSHOTS,'site-upload-mobile.png')});}
    await page.getByRole('button',{name:'Minimize uploads and drafts',exact:true}).click();assert.equal(await page.locator('[data-media-draft]').first().isVisible(),false);
    await page.getByRole('button',{name:'Show uploads and drafts',exact:true}).click();assert.equal(await page.locator('[data-media-draft]').first().isVisible(),true);
    // Blocked storage still leaves a usable in-memory draft and copy action.
    await page.evaluate(()=>{window.__originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='vf:media-drafts:v1')throw Error('Synthetic storage quota');return window.__originalSetItem.call(this,key,value);};});
    const beforeCacheFailure=await page.locator('[data-media-draft]').count();
    await page.locator('.media-batch input[accept^="image/"]').setInputFiles({...file,name:'cache-blocked.png'});
    await page.waitForFunction(count=>_mediaQueue.pending()===0&&_mediaDrafts.size===count,beforeCacheFailure+1);
    await page.getByText('Draft cache could not be saved. Copy the uploaded URL before leaving this page.',{exact:true}).waitFor();
    assert.equal(await page.locator('[data-media-draft]').count(),beforeCacheFailure+1);
    assert.equal(await page.locator('[data-media-draft]').last().getByRole('button',{name:'Copy URL',exact:true}).isEnabled(),true);
    assert.equal(await page.locator('.media-cache-warning').isVisible(),true);
    assert.equal(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;}),true,'Uncached drafts warn before leaving even when uploads finished');
    await page.evaluate(()=>Storage.prototype.setItem=window.__originalSetItem);
    // Cancelling queued jobs sends nothing; active cancellation stays ambiguous.
    mode.hold=true;const beforeCancel=uploads.length;
    await page.locator('.media-batch input[accept^="video/"]').setInputFiles([0,1,2].map(n=>({name:`cancel-${n}.mp4`,mimeType:'video/mp4',buffer:Buffer.from('synthetic-video')})));
    await page.waitForFunction(()=>_mediaQueue.pending()===3);await page.locator('.media-upload-cancel').nth(2).click();
    await page.getByText('Queued upload cancelled; nothing was sent.',{exact:true}).first().waitFor();
    assert.equal(uploads.length-beforeCancel,2);
    await page.locator('.media-upload-cancel').first().click();
    await page.getByText('Upload cancelled. The provider may have received it; check before retrying.',{exact:true}).first().waitFor();
    mode.hold=false;held.splice(0).forEach(resolve=>resolve());await page.waitForFunction(()=>_mediaQueue.pending()===0);
    // Firebase auth loss cancels active work, drops queued work, and hides drafts.
    mode.hold=true;const beforeAuthLoss=uploads.length;
    await page.locator('.media-batch input[accept^="video/"]').setInputFiles([0,1,2].map(n=>({name:`auth-${n}.mp4`,mimeType:'video/mp4',buffer:Buffer.from('synthetic-video')})));
    await page.waitForFunction(()=>_mediaQueue.pending()===3);
    await page.evaluate(()=>window.__testAuth(null));
    await page.waitForFunction(()=>_mediaQueue.pending()===0);
    assert.equal(uploads.length-beforeAuthLoss,2,'Auth loss cannot transmit the waiting third file');
    assert.equal(await page.locator('#upload-progress-panel').isVisible(),false);
    mode.hold=false;held.splice(0).forEach(resolve=>resolve());
    const count=uploads.length;await page.locator('.media-batch input[accept^="image/"]').setInputFiles(file);await page.getByText('Sign in as the site administrator before uploading or changing storage.',{exact:true}).waitFor();assert.equal(uploads.length,count);
    await page.evaluate(()=>window.__testAuth({uid:'m1PGSw7ViEb1xOJoj8INQllra3p1',email:'shihabjessore7@gmail.com',isAnonymous:false}));
    assert.equal(await page.locator('#upload-progress-panel').isVisible(),true,'Existing drafts return only with administrator auth');
    await page.setViewportSize({width:1280,height:900});
    // A fresh server snapshot wins even if its browser timestamp goes backwards.
    await page.evaluate(()=>{
      closeModal('edit-modal');closeModal('admin-panel-modal');
      const remote=VFSiteStore.clone(_siteCloudLatest);remote.site.agency.name='Server authoritative';remote.meta.updatedAt=-100;
      __testCloud(remote);
    });
    assert.equal(await page.evaluate(()=>STATE.data.site.agency.name),'Server authoritative');
    await page.evaluate(()=>openAdminPanel());
    await page.locator('#bn').fill('Local agency edit');
    await page.evaluate(()=>{const remote=VFSiteStore.clone(_siteCloudLatest);remote.site.contact.phone='Remote phone';__testCloud(remote);});
    assert.equal(await page.locator('#bn').inputValue(),'Local agency edit','Snapshot cannot replace an open form');
    await page.evaluate(()=>saveBranding('agency'));
    assert.equal(await page.evaluate(()=>__testSaves.at(-1).value.site.contact.phone),'Remote phone','Independent remote edit survives');
    assert.equal(await page.evaluate(()=>__testSaves.at(-1).value.site.agency.name),'Local agency edit');
    // A concurrent collection change must conflict, including repeated attempts.
    await page.evaluate(()=>{adminTab('portfolio');editItem('portfolio','yt');});
    await page.locator('#edit-form [name="title"]').fill('Stale local title');
    await page.evaluate(()=>{const remote=VFSiteStore.clone(_siteCloudLatest);remote.portfolio[0].title='Remote title';remote.meta.revision++;__testCloud(remote);});
    const savesBeforeConflict=await page.evaluate(()=>__testSaves.length);
    for(let attempt=0;attempt<2;attempt++){
      await page.locator('#edit-form [type="submit"]').click();
      await page.waitForFunction(()=>document.querySelector('#edit-form').dataset.saving==='false');
      assert.match(await page.locator('.save-error-banner').innerText(),/Cloud content changed/);
      assert.equal(await page.evaluate(()=>__testSaves.length),savesBeforeConflict);
    }
    assert.equal(await page.locator('#edit-form [name="title"]').inputValue(),'Stale local title');
    assert.equal(await page.evaluate(()=>STATE.data.portfolio[0].title),'Remote title');
    await page.locator('#edit-form').getByRole('button',{name:'Cancel',exact:true}).click();
    // Unsubmitted contact rows do not leak into another section's save.
    await page.evaluate(()=>{adminTab('site');switchBrandTab('contact');addContactRow();updateContactRow(0,'value','Unsubmitted');switchBrandTab('agency');});
    await page.locator('#bt').fill('Only branding saved');await page.evaluate(()=>saveBranding('agency'));
    assert.equal(await page.evaluate(()=>JSON.stringify(__testSaves.at(-1).value).includes('Unsubmitted')),false);
    // Failed contact save rolls back public state but keeps dynamic form drafts.
    await page.evaluate(()=>{
      const remote=VFSiteStore.clone(_siteCloudLatest);remote.site.contact.academyEmail='preserved@example.invalid';remote.site.contact.rows=[];__testCloud(remote);
      switchBrandTab('contact');addContactRow();updateContactRow(0,'value','Retained row');__testSaveFail=true;
    });
    await page.locator('#ci-phone-in').fill('Retained phone');await page.evaluate(()=>saveContact());
    assert.equal(await page.evaluate(()=>STATE.data.site.contact.rows.length),0);
    assert.equal(await page.locator('#ci-phone-in').inputValue(),'Retained phone');
    assert.equal(await page.evaluate(()=>document.querySelector('#brand-pane')._contactDraft.rows[0].value),'Retained row');
    await page.evaluate(()=>{__testSaveFail=false;return saveContact();});
    assert.equal(await page.evaluate(()=>__testSaves.at(-1).value.site.contact.rows[0].value),'Retained row');
    assert.equal(await page.evaluate(()=>__testSaves.at(-1).value.site.contact.academyEmail),'preserved@example.invalid');
    await page.evaluate(()=>{switchBrandTab('stats');addStatRow();__testSaveFail=true;});
    const statCount=await page.locator('#stats-rows-wrap > div').count();
    await page.evaluate(()=>saveStats());
    assert.equal(await page.locator('#stats-rows-wrap > div').count(),statCount);
    await page.evaluate(()=>{__testSaveFail=false;return saveStats();});
    assert.equal(await page.evaluate(()=>__testSaves.at(-1).value.site.stats.length),statCount);
    // A branding upload stays a form draft and cannot reset other typed fields.
    await page.evaluate(()=>switchBrandTab('agency'));
    const logoBeforeUpload=await page.evaluate(()=>STATE.data.site.agency.logo);
    await page.locator('#bn').fill('Name alongside logo');
    await page.locator('#brand-pane input[type="file"]').first().setInputFiles(file);
    await page.waitForFunction(()=>document.querySelector('#bl').value.startsWith('data:image/png;base64,'));
    assert.equal(await page.locator('#bn').inputValue(),'Name alongside logo');
    assert.equal(await page.evaluate(()=>STATE.data.site.agency.logo),logoBeforeUpload);
    await page.evaluate(()=>saveBranding('agency'));
    assert.match(await page.evaluate(()=>__testSaves.at(-1).value.site.agency.logo),/^data:image\/png;base64,/);
    // A late file read cannot overwrite another editor or a manual replacement.
    await page.evaluate(()=>{
      const NativeReader=window.FileReader,readers=[];
      window.FileReader=class {readAsDataURL(){this.result='data:image/png;base64,STALE';readers.push(this);}};
      uploadLogo({target:{files:[{size:1}]}},'agency');switchBrandTab('academy');document.querySelector('#bl').value='https://example.invalid/new-logo.png';readers[0].onload();
      uploadLogo({target:{files:[{size:1}]}},'academy');document.querySelector('#bl').value='https://example.invalid/manual-logo.png';readers[1].onload();
      window.FileReader=NativeReader;
    });
    assert.equal(await page.locator('#bl').inputValue(),'https://example.invalid/manual-logo.png');
    // Large legacy logo content is never silently stripped from a successful save.
    await page.evaluate(()=>{switchBrandTab('agency');document.querySelector('#bl').value='data:image/png;base64,'+'A'.repeat(60000);return saveBranding('agency');});
    assert.equal(await page.evaluate(()=>__testSaves.at(-1).value.site.agency.logo.length),60022);
    const importResult=await page.evaluate(async()=>{
      const NativeReader=window.FileReader,confirmOriginal=window.confirm;
      let content,pending;window.FileReader=class{readAsText(){this.result=content;pending=this.onload();}};window.confirm=()=>true;
      try{
        const before=JSON.stringify(STATE.data),saveCount=__testSaves.length;
        content=JSON.stringify({site:'invalid'});importJSON({target:{files:[{}]}});await pending;
        const invalidUntouched=before===JSON.stringify(STATE.data)&&saveCount===__testSaves.length;
        const imported=VFSiteStore.clone(_siteCloudLatest);imported.site.stats=[];imported.site.contact.social=[];imported.leads=[{secret:'must-not-import'}];
        content=JSON.stringify(imported);importJSON({target:{files:[{}]}});await pending;
        return {invalidUntouched,stats:__testSaves.at(-1).value.site.stats,social:__testSaves.at(-1).value.site.contact.social,privateLeak:JSON.stringify(STATE.data).includes('must-not-import')};
      }finally{window.FileReader=NativeReader;window.confirm=confirmOriginal;}
    });
    assert.equal(importResult.invalidUntouched,true);assert.deepEqual(importResult.stats,[]);assert.deepEqual(importResult.social,[]);assert.equal(importResult.privateLeak,false);
    const savesBeforeBlocked=await page.evaluate(()=>__testSaves.length);
    await page.evaluate(()=>_siteReceiveSnapshot({metadata:{fromCache:true}}));
    await page.locator('#bn').fill('Must not save offline');await page.evaluate(()=>saveBranding('agency'));
    assert.equal(await page.evaluate(()=>__testSaves.length),savesBeforeBlocked);
    assert.match(await page.locator('.save-error-banner').innerText(),/fresh cloud snapshot/);
    await page.evaluate(()=>__testCloud(null));await page.evaluate(()=>saveBranding('agency'));
    assert.equal(await page.evaluate(()=>__testSaves.length),savesBeforeBlocked,'Missing cloud record never auto-seeds');
    await page.evaluate(()=>__testAuth({uid:'not-the-owner',email:'client@example.invalid',isAnonymous:false}));
    assert.equal(await page.evaluate(()=>STATE.isAdmin),false,'A Firebase client account is not the site administrator');
    assert.equal(await page.evaluate(()=>persist()),false);assert.equal(await page.evaluate(()=>__testSaves.length),savesBeforeBlocked);
    assert.deepEqual(errors,[]);
  }finally{held.splice(0).forEach(resolve=>resolve());await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
