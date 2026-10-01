/* Runs inside the isolated report preview. Conversion stays on this device. */
(() => {
  const button=document.getElementById('downloadButton'),status=document.getElementById('pdfStatus');
  const margin=[12,12,20,12],scale=1.6;
  let library,downloadUrl;
  function loadLibrary(){return library ||= new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=button.dataset.library;const fail=()=>{library=null;script.remove();reject(Error('PDF component could not load. Check your connection and retry.'));};script.onload=()=>typeof html2pdf==='function'?resolve():fail();script.onerror=fail;document.head.append(script);});}
  async function embedImages(root){
    const sources=new Map();
    for(const image of root.querySelectorAll('img')){
      const source=image.src;
      if(!sources.has(source)){
        const loaded=new Image();loaded.crossOrigin='anonymous';loaded.src=source;let timeout;
        try{
          await Promise.race([loaded.decode(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Image timed out')),15000);})]);
          // Freeze every asset before rendering; html2canvas silently skips
          // some failed CORS images, which could otherwise omit a signature.
          const ratio=Math.min(1,2048/Math.max(loaded.naturalWidth,loaded.naturalHeight)),canvas=document.createElement('canvas');
          canvas.width=Math.max(1,Math.round(loaded.naturalWidth*ratio));canvas.height=Math.max(1,Math.round(loaded.naturalHeight*ratio));
          canvas.getContext('2d').drawImage(loaded,0,0,canvas.width,canvas.height);sources.set(source,canvas.toDataURL('image/png'));canvas.width=canvas.height=1;
        }catch{throw Error('An image or signature could not load securely. Check its URL and image-host access settings, then reload; no incomplete PDF was saved.');}
        finally{clearTimeout(timeout);}
      }
      image.src=sources.get(source);await image.decode();
    }
  }
  function splitTables(root,height){
    for(const table of root.querySelectorAll('table')){
      if(table.getBoundingClientRect().height<height*.7||!table.tHead||table.tBodies.length!==1)continue;
      const widths=[...table.tHead.rows[0].cells].map(cell=>cell.getBoundingClientRect().width);
      const rows=[...table.tBodies[0].rows],holder=document.createElement('div');holder.className='pdf-table-holder';table.before(holder);
      let chunk,body;
      function next(){
        chunk=table.cloneNode(false);chunk.classList.add('pdf-table-chunk');chunk.style.tableLayout='fixed';
        const cols=document.createElement('colgroup');
        widths.forEach(width=>{const col=document.createElement('col');col.style.width=width+'px';cols.append(col);});
        chunk.append(cols,table.tHead.cloneNode(true));body=document.createElement('tbody');chunk.append(body);holder.append(chunk);
      }
      next();
      for(const row of rows){
        body.append(row);
        if(chunk.getBoundingClientRect().height>height-90&&body.rows.length>1){row.remove();next();body.append(row);}
      }
      table.remove();
      const wrapper=holder.closest('.table-scroll'),heading=(wrapper||holder).previousElementSibling;
      if(heading?.tagName==='H2'){
        const lead=document.createElement('div');lead.className='section-lead';holder.prepend(lead);lead.append(heading,holder.querySelector('table'));
      }
    }
  }
  function prepare(root,height){
    splitTables(root,height);
    for(const heading of root.querySelectorAll('.sheet h2')){
      if(heading.parentElement.classList.contains('section-lead'))continue;
      const group=document.createElement('div');group.className='section-lead';heading.before(group);group.append(heading);
      while(group.nextElementSibling&&!group.nextElementSibling.matches('h2,.footer,.notice,.signatures,.table-scroll,.pdf-table-holder'))group.append(group.nextElementSibling);
      if(group.getBoundingClientRect().height>height*.85){
        group.replaceWith(...group.childNodes);
        const next=heading.nextElementSibling;
        if(next&&!next.matches('h2,.table-scroll,.pdf-table-holder')){
          heading.before(group);group.append(heading,next);
          if(group.getBoundingClientRect().height>height)group.replaceWith(...group.childNodes);
        }
      }
    }
    for(const signatures of root.querySelectorAll('.signatures')){
      const notice=signatures.nextElementSibling;if(!notice?.classList.contains('notice'))continue;
      const group=document.createElement('div');group.className='section-lead';signatures.before(group);group.append(signatures,notice);
    }
  }
  button.addEventListener('click',async()=>{
    if(button.disabled)return;button.disabled=true;button.textContent='Preparing PDF...';status.textContent='Preparing all pages. Please keep this preview open.';
    let staging;
    try{
      await loadLibrary();await document.fonts?.ready;
      const landscape=[...document.querySelectorAll('.sheet thead tr')].some(row=>row.cells.length>8);
      const paperWidth=landscape?297:210,paperHeight=landscape?210:297,pageWidth=paperWidth-24,pageHeight=paperHeight-32;
      // Clone the sheet so export never changes the mobile preview's layout.
      staging=document.createElement('div');staging.className='pdf-staging';staging.style.cssText='position:absolute;left:-10000px;top:0;pointer-events:none';staging.setAttribute('aria-hidden','true');
      const root=document.createElement('div');root.className='pdf-export';root.style.width=pageWidth+'mm';root.append(document.querySelector('.sheet').cloneNode(true));staging.append(root);document.body.append(staging);
      await embedImages(root);
      prepare(root,Math.floor(root.getBoundingClientRect().width*pageHeight/pageWidth));
      const filename=button.dataset.filename||'vision-flow-document.pdf';
      const options={margin,filename,enableLinks:false,image:{type:'jpeg',quality:.96},html2canvas:{scale,useCORS:true,backgroundColor:'#ffffff',windowWidth:1200,logging:false,ignoreElements:element=>element.matches('.pdf-staging,body>.sheet,.toolbar')},jsPDF:{unit:'mm',format:'a4',orientation:landscape?'landscape':'portrait'},pagebreak:{mode:['css','legacy'],avoid:['tr','.record','.summary','header','.section-lead','.clause','.particulars','.signatures','.pdf-table-chunk']}};
      const worker=html2pdf().set(options).from(root).toContainer();
      const container=await worker.get('container'),overlay=await worker.get('overlay'),size=await worker.get('pageSize'),rect=container.getBoundingClientRect();
      const pagePixels=size.inner.px.height,totalHeight=Math.ceil(rect.height),pages=Math.ceil(totalHeight/pagePixels);
      const links=[...container.querySelectorAll('a[href]')].flatMap(link=>{
        if(!/^https?:\/\//i.test(link.href))return [];
        return [...link.getClientRects()].map(r=>({url:link.href,x:r.left-rect.left,y:r.top-rect.top,width:r.width,height:r.height}));
      });
      const tables=[...container.querySelectorAll('table')].map(table=>{
        const r=table.getBoundingClientRect(),style=getComputedStyle(table),spacer=document.createElement('div');
        spacer.style.cssText=`height:${r.height}px;width:${r.width}px;margin:${style.marginTop} ${style.marginRight} ${style.marginBottom} ${style.marginLeft};`;
        return {table,spacer,top:r.top-rect.top,bottom:r.bottom-rect.top};
      });
      // Never allocate one huge canvas: long records exceed browser limits.
      // The library lays out page breaks, then renders bounded page crops.
      const blank=document.createElement('canvas');blank.width=2;blank.height=1;
      const pdf=await html2pdf().set({...options,pagebreak:{mode:[]}}).from(blank).toPdf().get('pdf');
      for(let n=0;n<pages;n++){
        status.textContent=`Preparing page ${n+1} of ${pages}...`;
        const height=Math.min(pagePixels,totalHeight-n*pagePixels);
        if(!container.isConnected)document.body.append(overlay);
        // Retain page geometry while only cloning this page's table rows.
        // Hidden rows alone still make html2canvas clone the entire document.
        for(const entry of tables){
          const visible=entry.bottom>n*pagePixels&&entry.top<(n+1)*pagePixels;
          if(visible&&entry.spacer.isConnected)entry.spacer.replaceWith(entry.table);
          else if(!visible&&entry.table.isConnected)entry.table.replaceWith(entry.spacer);
        }
        const current=container.getBoundingClientRect();
        if(Math.abs(current.height-rect.height)>1||tables.some(entry=>entry.table.isConnected&&Math.abs(entry.table.getBoundingClientRect().top-current.top-entry.top)>1))throw Error('PDF layout changed during rendering. Reload the preview and retry.');
        const canvas=await worker.set({html2canvas:{...options.html2canvas,y:n*pagePixels,height,onclone:clone=>{
          const copy=clone.querySelector('.html2pdf__container'),top=copy.getBoundingClientRect().top;
          // Keep layout, but skip painting other pages of long records.
          for(const block of copy.querySelectorAll('table,.section-lead,.record,header,.summary,.brief,.clause,.particulars,.signatures,.footer')){
            const r=block.getBoundingClientRect();if(r.bottom-top<=n*pagePixels||r.top-top>=(n+1)*pagePixels)block.style.visibility='hidden';
          }
        }}}).toCanvas().get('canvas');
        if(!canvas.width||!canvas.height)throw Error('PDF page rendering failed. No incomplete PDF was saved.');
        const image=canvas.toDataURL('image/jpeg',.96);if(image==='data:,')throw Error('PDF page rendering exceeded the browser limit.');
        if(n)pdf.addPage();pdf.setPage(n+1);
        pdf.addImage(image,'JPEG',margin[1],margin[0],pageWidth,height/pagePixels*pageHeight);
        for(const link of links){
          const top=Math.max(link.y,n*pagePixels),bottom=Math.min(link.y+link.height,(n+1)*pagePixels);
          if(bottom>top)pdf.link(margin[1]+link.x/rect.width*pageWidth,margin[0]+(top-n*pagePixels)/pagePixels*pageHeight,link.width/rect.width*pageWidth,(bottom-top)/pagePixels*pageHeight,{url:link.url});
        }
        pdf.setFontSize(8);pdf.setTextColor(90);pdf.text('Vision Flow | Page '+(n+1)+' of '+pages,paperWidth/2,paperHeight-11,{align:'center'});
        canvas.width=canvas.height=1;
      }
      if(downloadUrl)URL.revokeObjectURL(downloadUrl);downloadUrl=URL.createObjectURL(pdf.output('blob'));
      const saveLink=document.createElement('a');saveLink.href=downloadUrl;saveLink.download=filename;saveLink.textContent='Save generated PDF ('+pages+' pages)';saveLink.style.cssText='color:#fff;text-decoration:underline;font-weight:bold';
      status.replaceChildren(document.createTextNode('PDF ready. '),saveLink);saveLink.click();
    }catch(error){status.textContent=error.message||'PDF generation failed. Retry or use Print / save PDF.';}
    finally{staging?.remove();document.querySelectorAll('.html2pdf__overlay').forEach(overlay=>overlay.remove());button.disabled=false;button.textContent='Download PDF';}
  });
})();
