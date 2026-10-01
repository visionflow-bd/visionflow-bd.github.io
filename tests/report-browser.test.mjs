import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {normalizeClient,publicSnapshot,agreementTerms} from '../portal/data.js';
import {buildProjectReport,buildProjectAgreement,buildMasterAgreement} from '../portal/report.js';

// Actual exporter and local PDF library. Only synthetic data; no Firebase,
// Cloudinary, mail, production record or external asset request is permitted.
test('document browser: actual PDF download, long records, signatures and mobile',{timeout:300000},async()=>{
  const require=createRequire(import.meta.url),{chromium}=require(process.env.VF_BROWSER_MODULES?path.join(process.env.VF_BROWSER_MODULES,'playwright'):'playwright');
  const root=path.resolve(import.meta.dirname,'..'),errors=[],documents=new Map();let signaturePng,failLibrary=false;
  const output=process.env.VF_PDF_EVIDENCE||await mkdtemp(path.join(tmpdir(),'vf-pdf-test-'));
  await mkdir(output,{recursive:true});
  const server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://localhost');
      if(documents.has(url.pathname)){res.setHeader('Content-Type','text/html');res.end(documents.get(url.pathname));return;}
      if(url.pathname==='/signature.png'){res.setHeader('Content-Type','image/png');res.end(signaturePng);return;}
      if(url.pathname==='/portal/html2pdf.bundle.min.js'){
        if(failLibrary){failLibrary=false;res.writeHead(503).end();return;}
        const bundle=await readFile(path.join(root,'portal/html2pdf.bundle.min.js'),'utf8');
        // Observe actual library layout/canvas output, without mocking export.
        res.setHeader('Content-Type','text/javascript');res.end(bundle+`\n;(${installProbe.toString()})();`);return;
      }
      const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
      const data=await readFile(file);res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'image/png');res.end(data);
    }catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  try{
    browser=await chromium.launch({channel:'msedge',headless:true});
    const context=await browser.newContext({viewport:{width:1280,height:900},acceptDownloads:true});
    const origin=`http://127.0.0.1:${server.address().port}`;
    await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    const signatureImage=await page.evaluate(()=>{
      const canvas=document.createElement('canvas');canvas.width=480;canvas.height=140;const ctx=canvas.getContext('2d');
      ctx.strokeStyle='#103e57';ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(20,85);ctx.bezierCurveTo(140,-10,10,120,240,50);ctx.bezierCurveTo(340,0,210,130,455,35);ctx.stroke();
      ctx.font='18px sans-serif';ctx.fillStyle='#103e57';ctx.fillText('SYNTHETIC TEST SIGNATURE',20,126);return canvas.toDataURL('image/png');
    });
    signaturePng=Buffer.from(signatureImage.split(',')[1],'base64');
    const makeItems=count=>Array.from({length:count},(_,n)=>({
      n:n+1,b:'Subject '+(n+1),t:n===0?'Training: \u09ac\u09be\u0982\u09b2\u09be \u09aa\u09be\u09a0 - a long title to verify wrapping':'Training deliverable '+(n+1),s:n<12?'delivered':'progress',
      sd:'2026-10-01',dd:n<12?'2026-10-03':'',dur:'45 sec',clientNote:n===0?'Client-visible revision note':'',
      scriptUrl:'https://example.invalid/script-'+n,avatarUrl:'https://example.invalid/avatar-'+n,referenceUrl:'https://example.invalid/reference-'+n,
      dl:n<12?'https://example.invalid/private-final-'+n:'',no:'PRIVATE-INTERNAL-MARKER'
    }));
    const client=normalizeClient({name:'Synthetic Agency Partner',projects:{sample:{name:'Synthetic Complete Project',rate:400,budget:40000,scope:'Production and delivery of 100 approved training videos. Client-provided scripts and reference material are retained without exposing internal notes.',terms:'Review delivered work within the agreed 72-hour window. Payment records and signatures remain separate from automatic review outcomes.',deadline:'2026-11-30',weeklyTarget:12,milestoneText:'Review the first ten deliveries before the next scheduled batch.',itemLabel:'Subject',titleLabel:'Deliverable title',sourceScriptUrl:'https://example.invalid/public-script',avatarFolderUrl:'https://example.invalid/public-avatar',items:makeItems(100),payments:[{id:'payment',date:'2026-10-01',type:'Advance',amount:7000,note:'Synthetic payment record',proofUrl:origin+'/signature.png'}]}}},'synthetic-pdf');
    const p=client.projects.sample,pub=publicSnapshot(client,client.slug);
    const signature={name:'Synthetic Test Signer',signedAt:'2026-10-01T06:00:00.000Z',image:signatureImage,termsSnapshot:agreementTerms(p)};
    const master={...signature,termsSnapshot:pub.masterAgreement,projectTerms:pub.projectTerms};
    const common={client,project:p,logoUrl:origin+'/logo.png',founderSignatureUrl:origin+'/signature.png',authorizedName:'Synthetic Authorized Signer',pdfLibraryUrl:origin+'/portal/html2pdf.bundle.min.js',exportScriptUrl:origin+'/portal/report-export.js',generatedAt:'2026-10-01T06:00:00.000Z'};
    documents.set('/report',buildProjectReport({...common,project:pub.projects.sample,signature,masterSignature:master,projectAcknowledged:true,approvals:[{title:'Synthetic approval',desc:'Confirm the scope and schedule',confirmation:{kind:'rejection-pending',confirmedAt:signature.signedAt,rejectReason:'Please retain the original rejection reason.'}}],feedback:[{itemNumber:1,message:'Please revise the opening.',submittedAt:signature.signedAt,status:'resolved',response:'The opening was revised.',attachments:[{name:'revision-notes.txt',size:128}]}]}));
    documents.set('/project',buildProjectAgreement({...common,masterSignature:master,projectAcknowledged:true}));
    documents.set('/master',buildMasterAgreement({...common,terms:pub.masterAgreement,projectTerms:pub.projectTerms,signature:master}));
    const failures=documents.get('/master').replaceAll(origin+'/signature.png',origin+'/missing-signature.png');documents.set('/failures',failures);
    await page.goto(origin+'/failures');failLibrary=true;
    await page.getByRole('button',{name:'Download PDF',exact:true}).click();await page.getByText(/PDF component could not load/).waitFor();
    assert.equal(await page.locator('script[src*="html2pdf.bundle"]').count(),0);
    await page.getByRole('button',{name:'Download PDF',exact:true}).click();await page.getByText(/no incomplete PDF was saved/).waitFor();
    assert.equal(await page.locator('#pdfStatus a').count(),0);assert.equal(await page.locator('.pdf-export').count(),0);
    await page.evaluate(origin=>document.querySelectorAll('img').forEach(img=>{if(img.src.includes('missing-signature'))img.src=origin+'/signature.png';}),origin);
    await downloadPdf(page,output,'retry-success',2,3);
    for(const [route,name] of [['/report','project-report'],['/project','project-agreement'],['/master','master-agreement']]){
      await page.setViewportSize({width:1280,height:900});await page.goto(origin+route);
      await page.locator('.sheet').waitFor();await page.evaluate(()=>Promise.all([...document.images].map(img=>img.decode())));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      assert.equal((await page.content()).includes('PRIVATE-INTERNAL-MARKER'),false);
      assert.equal((await page.content()).includes('private-final-'),false);
      await downloadPdf(page,output,name,2,name==='project-report'?30:2);
      await page.setViewportSize({width:390,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false,`${name} mobile overflow`);
      const overlap=await page.locator('.signature-box').evaluateAll(boxes=>boxes.some(box=>{const img=box.querySelector('img'),label=box.querySelector('strong');return img&&label&&img.getBoundingClientRect().bottom>label.getBoundingClientRect().top+2;}));
      assert.equal(overlap,false,`${name} signature overlaps signer label`);
      await page.screenshot({path:path.join(output,name+'-mobile.png'),fullPage:true});
      await downloadPdf(page,output,name+'-mobile',2,name==='project-report'?30:2);
    }
    const stress=structuredClone(client);stress.projects.sample.items=makeItems(1000);stress.projects.sample.budget=400000;
    documents.set('/stress',buildProjectReport({...common,client:stress,project:publicSnapshot(stress,stress.slug).projects.sample}));
    await page.setViewportSize({width:1280,height:900});await page.goto(origin+'/stress');
    await downloadPdf(page,output,'project-report-1000',30,160);
    assert.deepEqual(errors,[]);console.log('Synthetic PDF evidence: '+output);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});

function installProbe(){
  window.__pdfCanvases=[];window.__pdfLayout=null;
  const original=html2pdf.Worker.prototype.toContainer;
  html2pdf.Worker.prototype.toContainer=function(){return original.apply(this,arguments).then(function(){
    if(window.__pdfLayout)return;
    const root=this.prop.container,base=root.getBoundingClientRect(),height=this.prop.pageSize.inner.px.height;
    const describe=node=>{const r=node.getBoundingClientRect();return {top:r.top-base.top,bottom:r.bottom-base.top,width:r.width};};
    window.__pdfLayout={height,width:base.width,tables:[...root.querySelectorAll('table')].map(table=>({...describe(table),heads:table.tHead?.rows.length||0,rows:table.tBodies[0]?.rows.length||0})),
      brokenHeaders:[...root.querySelectorAll('th')].filter(th=>{
        if(!/^(Duration|Script|Reference|Started|Delivered|Status)$/.test(th.textContent))return false;
        const range=document.createRange();range.selectNodeContents(th);return range.getClientRects().length!==1;
      }).map(th=>th.textContent),
      signatureGroups:[...root.querySelectorAll('.section-lead')].filter(group=>group.querySelector('.signatures')).map(describe)};
  });};
  const dataUrl=HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL=function(type){
    if(type==='image/jpeg'){
      const sample=document.createElement('canvas');sample.width=160;sample.height=120;const ctx=sample.getContext('2d');ctx.drawImage(this,0,0,160,120);
      const pixels=ctx.getImageData(0,0,160,120).data;let ink=0;
      for(let i=0;i<pixels.length;i+=4)if(Math.min(pixels[i],pixels[i+1],pixels[i+2])<220&&pixels[i+3])ink++;
      window.__pdfCanvases.push({width:this.width,height:this.height,ink});
    }
    return dataUrl.apply(this,arguments);
  };
}

async function downloadPdf(page,output,name,minPages,maxPages){
  const expected=await page.locator('.sheet a[href]').evaluateAll(links=>[...new Set(links.map(a=>a.href))].sort());
  await page.evaluate(()=>{window.__pdfCanvases=[];window.__pdfLayout=null;});
  const downloadEvent=page.waitForEvent('download',{timeout:180000});await page.getByRole('button',{name:'Download PDF',exact:true}).click();
  const failed=page.waitForFunction(()=>!document.getElementById('downloadButton').disabled&&/could not|failed|exceeded/.test(document.getElementById('pdfStatus').textContent),{},{timeout:180000}).then(async()=>{throw Error(await page.locator('#pdfStatus').innerText());});
  let download;try{download=await Promise.race([downloadEvent,failed]);}catch(error){console.error(name+': '+await page.locator('#pdfStatus').innerText());throw error;}
  const file=path.join(output,name+'.pdf');await download.saveAs(file);
  const bytes=await readFile(file);assert.equal(bytes.subarray(0,5).toString(),'%PDF-');assert.ok(bytes.length>20000);
  await page.getByRole('button',{name:'Download PDF',exact:true}).waitFor();
  assert.match(await page.locator('#pdfStatus').innerText(),/PDF ready/);assert.equal(await page.locator('.pdf-export,.html2pdf__overlay').count(),0);
  const info=spawnSync('pdfinfo',[file],{encoding:'utf8'});assert.equal(info.status,0,info.stderr);
  const pages=Number(info.stdout.match(/Pages:\s+(\d+)/)?.[1]);assert.ok(pages>=minPages&&pages<=maxPages,`Unexpected ${name} page count: ${pages}`);
  const landscape=await page.locator('.sheet thead tr').evaluateAll(rows=>rows.some(row=>row.cells.length>8));
  assert.match(info.stdout,landscape?/Page size:\s+841\.\d+ x 595\.\d+ pts \(A4\)/:/Page size:\s+595\.\d+ x 841\.\d+ pts \(A4\)/);
  const pdfText=bytes.toString('latin1'),uris=[...pdfText.matchAll(/\/URI\s*\(([^)]*)\)/g)].map(match=>match[1]);
  assert.deepEqual([...new Set(uris)].sort(),expected,`${name} PDF links`);assert.ok(!uris.some(uri=>uri.includes('private-final')));
  for(const match of pdfText.matchAll(/\/Rect\s*\[([\d. -]+)\]/g)){
    const [left,top,right,bottom]=match[1].trim().split(/\s+/).map(Number);
    assert.ok(left>=33&&right<=(landscape?809:562)&&bottom>=55&&top<=(landscape?562:809)&&right>left&&top>bottom,`${name} link outside content: ${match[1]}`);
  }
  const probe=await page.evaluate(()=>({canvases:window.__pdfCanvases,layout:window.__pdfLayout}));
  assert.equal(probe.canvases.filter(c=>c.height>1).length,pages);assert.ok(probe.canvases.every(c=>c.width<=2048&&c.height<=2048),`${name} unbounded canvas`);
  assert.ok(probe.canvases.filter(c=>c.height>1).every(c=>c.ink>15),`${name} blank page`);
  assert.equal(probe.layout.tables.reduce((sum,t)=>sum+t.rows,0),await page.locator('.sheet tbody tr').count(),`${name} omitted rows`);
  assert.deepEqual(probe.layout.brokenHeaders,[],`${name} standard heading split mid-word`);
  assert.ok(probe.layout.tables.every(table=>table.width<=probe.layout.width+1),`${name} table exceeds page width`);
  const samePage=rect=>Math.floor((rect.top+.5)/probe.layout.height)===Math.floor((rect.bottom-.5)/probe.layout.height);
  for(const table of probe.layout.tables){assert.ok(table.heads&&samePage(table),`${name} table needs a repeated header or splits a row`);}
  for(const group of probe.layout.signatureGroups)assert.ok(samePage(group),`${name} signature and notice separated`);
  await writeFile(path.join(output,name+'-layout.json'),JSON.stringify({pages,bytes:bytes.length,links:uris.length,...probe},null,2));
  console.log(`${name}: ${pages} A4 pages, ${bytes.length} bytes, ${uris.length} safe links`);
}
