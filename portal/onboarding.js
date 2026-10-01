import {esc, clone, publicSnapshot, sameRecord, currentMaster, projectAcknowledged, signatureImage} from './data.js?v=20260928-r10';

// The UI reads the same captured records checked by Firestore rules.
// No localStorage flag grants consent or delivery authorization.
export function createOnboarding(ctx) {
  const portal=()=>ctx.isAdmin()?publicSnapshot(ctx.getClient(),ctx.state.clientKey):ctx.getClient();
  const records=()=>ctx.artifacts();
  const master=()=>currentMaster(portal(),records().agreements||[]);
  const consent=()=> (records().consent||[]).find(r=>r.id===portal()?.consentTerms?.version&&sameRecord(r.termsSnapshot,portal().consentTerms));
  const acknowledged=key=>projectAcknowledged(portal(),key,master(),records().acknowledgements||[]);
  const sections=terms=>(terms?.sections||[]).map(({title,body})=>`<h3>${esc(title)}</h3><p>${esc(body)}</p>`).join('');
  const masterText=terms=>`<p>${esc(terms.application)}</p>${terms.clauses.map(({title,body})=>`<h3>${esc(title)}</h3><p>${esc(body)}</p>`).join('')}`;
  const capture=(col,id,data)=>ctx.writeRecord(col,id,data);
  async function writeOnce(col,id,data) {
    const existing=await ctx.readRecord(col,id);
    const matches=saved=>saved&&!saved.revoked&&sameRecord(saved.termsSnapshot,data.termsSnapshot)&&(!data.projectTerms||sameRecord(saved.projectTerms,data.projectTerms));
    if(existing){if(matches(existing))return existing;throw new Error('This record changed or was withdrawn. Refresh the workspace before continuing.');}
    try{await capture(col,id,data);return data;}catch(error){
      // A simultaneous device may have committed the same immutable record.
      const saved=await ctx.readRecord(col,id).catch(()=>null);
      if(matches(saved))return saved;
      throw error;
    }
  }
  function showConsent() {
    if(ctx.isAdmin()||ctx.state.mode!=='client'||!portal())return false;
    const p=portal(),view=document.getElementById('view');
    if(!p.consentTerms||!p.masterAgreement){view.innerHTML='<section class="empty"><h2>Workspace update in progress</h2><p>Please contact Vision Flow if this message remains after refreshing.</p></section>';return true;}
    if(!records().ready?.consent){view.innerHTML='<section class="empty"><h2>Checking your saved consent…</h2></section>';return true;}
    if(consent()){view.querySelector('.terms-overlay')?.remove();return false;}
    if(view.querySelector('.terms-overlay')?.dataset.version===p.consentTerms.version)return true;
    const snapshot=clone(p.consentTerms);
    view.innerHTML=`<div class="terms-overlay" data-version="${esc(snapshot.version)}"><section class="terms-card" aria-labelledby="consent-title"><img class="terms-logo" src="../logo.png" alt="Vision Flow"><h1 id="consent-title">Welcome to Vision Flow</h1><p>Your private project workspace</p><div class="consent-scroll" tabindex="0" aria-label="Terms and privacy policy">${sections(snapshot)}<p><strong>End of Terms and Privacy Policy</strong></p></div><p class="consent-help" role="status">Read the policy and scroll to the end to enable the checkbox.</p><label class="terms-checkbox-label"><input type="checkbox" id="consent-checkbox" disabled> I have read and agree to the Terms and Privacy Policy.</label><button type="button" class="button primary" id="consent-submit" disabled>Accept & enter workspace</button><p class="form-error" role="alert"></p></section></div>`;
    const root=view.querySelector('.terms-overlay'),scroll=root.querySelector('.consent-scroll'),check=root.querySelector('input'),submit=root.querySelector('#consent-submit'),error=root.querySelector('.form-error');
    let reachedEnd=false,saving=false;
    const onScroll=()=>{if(scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop<=3){reachedEnd=true;check.disabled=false;root.querySelector('.consent-help').textContent='You can now choose whether to accept. Contact Vision Flow if you have questions.';}};
    scroll.addEventListener('scroll',onScroll);requestAnimationFrame(onScroll);
    check.addEventListener('change',()=>{submit.disabled=saving||!reachedEnd||!check.checked;});
    submit.addEventListener('click',async()=>{
      if(saving||!reachedEnd||!check.checked)return;saving=true;submit.disabled=true;check.disabled=true;submit.textContent='Saving your consent…';error.textContent='';
      try{
        const saved=await writeOnce('consent',snapshot.version,{type:'terms-acceptance',termsVersion:snapshot.version,termsSnapshot:snapshot,agreedAt:ctx.timestamp(),userAgent:navigator.userAgent});
        const rows=records().consent||=[];if(!rows.some(r=>r.id===snapshot.version))rows.push({...saved,id:snapshot.version});
        root.remove();ctx.notify('Welcome. Review your master agreement to enable final downloads.');ctx.render();
      }catch(e){error.textContent='Your consent could not be saved. Check your connection and retry.';ctx.fail(e);}
      finally{saving=false;submit.disabled=!check.checked;check.disabled=false;submit.textContent='Accept & enter workspace';}
    });return true;
  }
  function clientPanel() {
    if(!portal())return '';
    const s=master(),p=portal();
    return `<section class="agreement" id="master-agreement"><div class="panel-head"><h2>Master Partner Agreement</h2>${ctx.button(s?'View signed master agreement':'Review master agreement','master-details')}${!ctx.isAdmin()&&!s?ctx.button('Review & sign once','master-sign','','primary'):''}</div><p>${s?`Signed by ${esc(s.name)} on ${esc(ctx.dateText(s.signedAt))}. Your master signature applies across this workspace's projects.`:'Welcome to your private workspace. Review the terms and sign once to protect the shared project record and enable eligible final downloads.'}</p><p class="small muted">New or materially changed project particulars may require an acknowledgement. Version ${esc(p.masterAgreement?.version||'pending')}</p><div class="actions wrap">${ctx.button('Terms & Privacy','portal-policy')}${ctx.button('Master agreement PDF','master-pdf')}${ctx.isAdmin()?ctx.button('Manage master agreement','master-manage'):''}</div></section>`;
  }
  function projectPanel() {
    const key=ctx.state.projectKey,s=master(),done=acknowledged(key);
    return `${clientPanel()}<section class="panel" id="agreement" style="margin-top:16px"><h3>Project acknowledgement</h3><p>${done?'The current project particulars are covered by your master signing record or a separate acknowledgement.':s?'Please review this project’s current scope, budget and schedule. A checkbox acknowledgement is needed; your master signature is already recorded.':'Sign the master agreement above after reviewing the current project particulars.'}</p>${!ctx.isAdmin()&&s&&!done?ctx.button('Review & acknowledge project','project-ack','','primary'):''}${ctx.button('Project terms / PDF','agreement')}</section>`;
  }
  function details() {
    const p=portal(),s=master();ctx.modal('Master Partner Agreement',s?`Signed by ${s.name} · ${ctx.dateText(s.signedAt)}`:'Review the terms before signing.',`${masterText(s?.termsSnapshot||p.masterAgreement)}${s&&signatureImage(s.image)?`<img class="signature-image" src="${signatureImage(s.image)}" alt="Master agreement signature">`:''}`,null);
  }
  function sign() {
    if(ctx.isAdmin())throw new Error('Open the private client view to sign as the client.');
    if(!consent())throw new Error('Accept the current Terms and Privacy Policy first.');
    if(master())return details();
    const p=clone(portal()),terms=p.masterAgreement;
    ctx.modal('Review & sign your master agreement','Sign once for this workspace. Review each current project below.',`${masterText(terms)}<h3>Current project particulars included in this signature</h3>${Object.values(p.projectTerms).map(ctx.termsHtml).join('')}${ctx.field('Full name','name','','text','required maxlength="200"')}<canvas id="signatureCanvas" class="signature-pad" aria-label="Draw your master signature with mouse or touch"></canvas>${ctx.button('Clear signature','clear-signature')}<label class="check-field"><input type="checkbox" name="agree" required> I have reviewed the master agreement and the current project particulars above and agree to them.</label>`,async form=>{
      const pad=ctx.getPad();if(!pad?.drawn)throw new Error('Please draw your signature before submitting.');
      const saved=await writeOnce('agreements',terms.version,{name:String(form.get('name')).trim(),image:pad.canvas.toDataURL('image/png'),termsSnapshot:terms,projectTerms:p.projectTerms,signedAt:ctx.timestamp(),userAgent:navigator.userAgent});
      const rows=records().agreements||=[];if(!rows.some(r=>r.id===terms.version))rows.push({...saved,id:terms.version});
      ctx.finishModal();ctx.notify('Master agreement signed. Eligible final downloads are now available.');ctx.render();
    },'Sign master agreement');ctx.initPad();
  }
  function acknowledge() {
    const p=clone(portal()),key=ctx.state.projectKey;if(!master())return sign();
    if(acknowledged(key))return ctx.notify('Current project terms are already acknowledged.');
    ctx.modal('Review project particulars','Your master signature remains on record. Confirm these project-specific terms.',`${ctx.termsHtml(p.projectTerms[key])}<label class="check-field"><input type="checkbox" name="agree" required> I have reviewed and acknowledge these project particulars.</label>`,async()=>{
      await writeOnce('acknowledgements',p.projects[key].ackId,{projectKey:key,masterVersion:p.masterAgreement.version,termsSnapshot:p.projectTerms[key],acknowledgedAt:ctx.timestamp(),userAgent:navigator.userAgent});ctx.finishModal();ctx.notify('Project particulars acknowledged.');
    },'Acknowledge project');
  }
  async function manage() {
    const rows=records().agreements||[];
    ctx.modal('Manage master agreement','Original signed records are retained. Request a replacement when the current agreement should no longer authorize downloads.',`${rows.map(s=>`<article class="record"><strong>${esc(s.name)}</strong><p>${esc(s.id)} · ${esc(ctx.dateText(s.signedAt))}</p>${signatureImage(s.image)?`<img class="signature-image" src="${signatureImage(s.image)}" alt="Captured master signature">`:''}</article>`).join('')||'<p>No master signature recorded.</p>'}<label class="check-field"><input type="checkbox" name="replace" required> Request a replacement master signature and suspend final downloads until it is signed.</label>`,async()=>{const draft=clone(ctx.getClient());draft.masterRevision=(Number(draft.masterRevision)||1)+1;await ctx.saveClient(draft,'Replacement master signature requested');ctx.finishModal();},'Request replacement');
  }
  return {portal,master,consent,acknowledged,showConsent,clientPanel,projectPanel,details,sign,acknowledge,manage,sections,masterText};
}
