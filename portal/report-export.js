/* Runs inside the isolated report preview. All conversion stays on this device. */
(() => {
  const button=document.getElementById('downloadButton'),status=document.getElementById('pdfStatus');
  let library,downloadUrl;
  function loadLibrary(){return library ||= new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=button.dataset.library;script.onload=resolve;script.onerror=()=>{library=null;reject(new Error('PDF component could not load. Check your connection and retry.'));};document.head.append(script);});}
  button.addEventListener('click',async()=>{
    if(button.disabled)return;button.disabled=true;button.textContent='Preparing PDF…';status.textContent='Preparing all pages. Please keep this preview open.';
    const groups=[];
    try{
      await loadLibrary();
      await Promise.all([...document.images].map(img=>img.decode().catch(()=>{})));
      document.body.classList.add('pdf-export');
      for(const heading of document.querySelectorAll('.sheet h2')){const next=heading.nextElementSibling;if(!next||next.getBoundingClientRect().height>820)continue;const group=document.createElement('div');group.className='section-lead';heading.before(group);group.append(heading,next);groups.push(group);}
      const worker=html2pdf().set({margin:[12,12,16,12],filename:'vision-flow-project-record.pdf',image:{type:'jpeg',quality:.96},html2canvas:{scale:1.6,useCORS:true,backgroundColor:'#ffffff',windowWidth:1000,logging:false},jsPDF:{unit:'mm',format:'a4',orientation:'portrait'},pagebreak:{mode:['css','legacy'],avoid:['tr','.record','.summary','header','.section-lead']}}).from(document.querySelector('.sheet')).toPdf();
      const pdf=await worker.get('pdf');const pages=pdf.internal.getNumberOfPages();
      for(let n=1;n<=pages;n++){pdf.setPage(n);pdf.setFontSize(8);pdf.setTextColor(90);pdf.text('Vision Flow | Page '+n+' of '+pages,105,289,{align:'center'});}
      if(downloadUrl)URL.revokeObjectURL(downloadUrl);
      downloadUrl=URL.createObjectURL(pdf.output('blob'));
      const saveLink=document.createElement('a');saveLink.href=downloadUrl;saveLink.download='vision-flow-project-record.pdf';saveLink.textContent='Save generated PDF ('+pages+' pages)';saveLink.style.cssText='color:#fff;text-decoration:underline;font-weight:bold';
      status.replaceChildren(document.createTextNode('PDF ready. '),saveLink);
      await worker.save();
    }catch(error){status.textContent=error.message||'PDF generation failed. Retry or use Print / save PDF.';}
    finally{for(const group of groups)group.replaceWith(...group.childNodes);document.body.classList.remove('pdf-export');button.disabled=false;button.textContent='Download PDF';}
  });
})();
