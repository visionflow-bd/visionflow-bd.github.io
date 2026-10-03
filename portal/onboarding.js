import {esc, clone, publicSnapshot, sameRecord, currentMaster, projectAcknowledged, signatureImage} from './data.js?v=20261003-a4';

// The UI reads the same captured records checked by Firestore rules.
// No localStorage flag grants consent or delivery authorization.
export function createOnboarding(ctx) {
  const portal=()=>ctx.isAdmin()?publicSnapshot(ctx.getClient(),ctx.state.clientKey):ctx.getClient();
  const records=()=>ctx.artifacts();
  const master=()=>currentMaster(portal(),records().agreements||[]);
  const isAgencyPartner=()=>portal()?.agreementMode!=='project';
  const projectSignature=key=>{
    const terms=portal()?.projectTerms?.[key];
    const expectedId=portal()?.projects?.[key]?.signatureId;
    if(!terms||!expectedId)return null;
    return (records().sigs||[]).find(record=>record.id===expectedId&&record.projectKey===key&&!record.revoked&&!['void','deleted'].includes(portal()?.signatureReviews?.[record.id]?.state)&&sameRecord(record.termsSnapshot,terms));
  };
  const projectReady=key=>isAgencyPartner()?Boolean(master()&&projectAcknowledged(portal(),key,master(),records().acknowledgements||[])):portal()?.projects?.[key]?.signatureRequired===false||Boolean(projectSignature(key));
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
    view.innerHTML=`<div class="terms-overlay" data-version="${esc(snapshot.version)}"><section class="terms-card" aria-labelledby="consent-title"><img class="terms-logo" src="../logo.png" alt="Vision Flow"><h1 id="consent-title">Welcome to Vision Flow</h1><p>Your private project workspace</p><p class="consent-intro">Please review the short policy below. The full Terms and Privacy Policy can be opened before you accept.</p><div class="consent-links" aria-label="Open policy details"><button type="button" class="terms-link" data-policy-detail="terms">Terms &amp; Conditions</button><span aria-hidden="true">·</span><button type="button" class="terms-link" data-policy-detail="privacy">Privacy Policy</button></div><div class="consent-detail-panel" data-policy-panel hidden></div><div class="consent-scroll" tabindex="0" aria-label="Terms and privacy policy">${sections(snapshot)}<p><strong>End of Terms and Privacy Policy</strong></p></div><p class="consent-help" role="status">Scroll to the end of the policy to unlock the acceptance checkbox.</p><label class="terms-checkbox-label" aria-disabled="true"><input type="checkbox" id="consent-checkbox" disabled> <span>I have read and agree to the <strong>Terms &amp; Conditions</strong> and <strong>Privacy Policy</strong>.</span></label><button type="button" class="button consent-submit" id="consent-submit" disabled>Accept &amp; enter workspace</button><p class="form-error" role="alert"></p></section></div>`;
    const root=view.querySelector('.terms-overlay'),scroll=root.querySelector('.consent-scroll'),check=root.querySelector('input'),submit=root.querySelector('#consent-submit'),error=root.querySelector('.form-error');
    let reachedEnd=false,saving=false;
    root.querySelectorAll('[data-policy-detail]').forEach(link=>link.addEventListener('click',()=>{
      const kind=link.dataset.policyDetail,panel=root.querySelector('[data-policy-panel]');
      panel.hidden=false;panel.innerHTML=`<h3>${kind==='privacy'?'Privacy Policy':'Terms & Conditions'}</h3>${(snapshot.sections||[]).filter(section=>kind==='privacy'?section.title!=='Terms of access':section.title==='Terms of access').map(section=>`<h4>${esc(section.title)}</h4><p>${esc(section.body)}</p>`).join('')}<button type="button" class="button small" data-policy-close>Close details</button>`;
      panel.querySelector('[data-policy-close]').addEventListener('click',()=>{panel.hidden=true;});
    }));
    const onScroll=()=>{if(scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop<=3){reachedEnd=true;check.disabled=false;root.classList.add('consent-ready');root.querySelector('.terms-checkbox-label').setAttribute('aria-disabled','false');root.querySelector('.consent-help').textContent='All policy sections reviewed. Select the checkbox to enable Continue.';}};
    scroll.addEventListener('scroll',onScroll);requestAnimationFrame(onScroll);
    check.addEventListener('change',()=>{submit.disabled=saving||!reachedEnd||!check.checked;submit.classList.toggle('is-ready',!submit.disabled);root.classList.toggle('consent-selected',check.checked);});
    submit.addEventListener('click',async()=>{
      if(saving||!reachedEnd||!check.checked)return;saving=true;submit.disabled=true;check.disabled=true;submit.textContent='Saving your consent…';error.textContent='';
      try{
        const saved=await writeOnce('consent',snapshot.version,{type:'terms-acceptance',termsVersion:snapshot.version,termsSnapshot:snapshot,agreedAt:ctx.timestamp(),userAgent:navigator.userAgent});
        const rows=records().consent||=[];if(!rows.some(r=>r.id===snapshot.version))rows.push({...saved,id:snapshot.version});
        root.remove();ctx.notify(isAgencyPartner()?'Welcome. Review your master agreement to enable final downloads.':'Welcome. Choose a project to review its details and agreement.');ctx.render();
      }catch(e){error.textContent='Your consent could not be saved. Check your connection and retry.';ctx.fail(e);}
      finally{saving=false;submit.disabled=!check.checked;check.disabled=false;submit.textContent='Accept & enter workspace';}
    });return true;
  }
  function clientPanel() {
    if(!portal())return '';
    const s=master(),p=portal();
    if(!isAgencyPartner())return `<section class="agreement" id="project-agreement"><div class="panel-head"><h2>Project-by-project agreement</h2>${ctx.button('Terms & Privacy','portal-policy')}</div><p>Each project is reviewed and signed separately. No master signature is requested for this client relationship.</p><p class="small muted">Choose a project below to review its scope, budget, schedule and signature status.</p></section>`;
    return `<section class="agreement" id="master-agreement"><div class="panel-head"><h2>Master Partner Agreement</h2>${ctx.button(s?'View signed master agreement':'Review master agreement','master-details')}${!ctx.isAdmin()&&!s?ctx.button('Review & sign once','master-sign','','primary'):''}</div><p>${ctx.isAdmin()?(s?`Signed by ${esc(s.name)} on ${esc(ctx.dateText(s.signedAt))}. This master signature covers all of this client’s projects.`:'Not signed yet. The client is asked to sign once; final downloads stay locked until then.'):s?`Signed by ${esc(s.name)} on ${esc(ctx.dateText(s.signedAt))}. Your master signature applies across this workspace's projects.`:'Welcome to your private workspace. Review the terms and sign once to protect the shared project record and enable eligible final downloads.'}</p><p class="small muted">New or materially changed project particulars may require an acknowledgement. Version ${esc(p.masterAgreement?.version||'pending')}</p><div class="actions wrap">${ctx.button('Terms & Privacy','portal-policy')}${ctx.button('Master agreement PDF','master-pdf')}${ctx.isAdmin()?ctx.button('Manage master agreement','master-manage'):''}</div></section>`;
  }
  function projectPanel() {
    const key=ctx.state.projectKey,s=master(),done=acknowledged(key),signed=projectSignature(key);
    if(!isAgencyPartner())return `${clientPanel()}<section class="panel" id="agreement" style="margin-top:16px"><div class="panel-head"><h3>Project agreement</h3>${signed?ctx.button('View signed project terms','agreement'):!ctx.isAdmin()?ctx.button('Review & sign this project','project-sign','','primary'):''}</div><p>${signed?`Signed by ${esc(signed.name)} on ${esc(ctx.dateText(signed.signedAt))}. This signature applies only to this project.`:'Review the current project particulars and sign only this project when you are ready.'}</p>${ctx.button('Project terms / PDF','agreement')}</section>`;
    return `${clientPanel()}<section class="panel" id="agreement" style="margin-top:16px"><h3>Project acknowledgement</h3><p>${ctx.isAdmin()?(done?'Covered by the client’s master signature or a separate acknowledgement.':s?'Waiting for the client to acknowledge these project particulars.':'Waiting for the client to sign the master agreement.'):done?'The current project particulars are covered by your master signing record or a separate acknowledgement.':s?'Please review this project’s current scope, budget and schedule. A checkbox acknowledgement is needed; your master signature is already recorded.':'Sign the master agreement above after reviewing the current project particulars.'}</p>${!ctx.isAdmin()&&s&&!done?ctx.button('Review & acknowledge project','project-ack','','primary'):''}${ctx.button('Project terms / PDF','agreement')}</section>`;
  }
  function details() {
    const p=portal(),s=master();ctx.modal('Master Partner Agreement',s?`Signed by ${s.name} · ${ctx.dateText(s.signedAt)}`:'Review the terms before signing.',`${masterText(s?.termsSnapshot||p.masterAgreement)}${s&&signatureImage(s.image)?`<img class="signature-image" src="${signatureImage(s.image)}" alt="Master agreement signature">`:''}`,null);
  }
  function sign() {
    if(ctx.isAdmin())throw new Error('Open the private client view to sign as the client.');
    if(!consent())throw new Error('Accept the current Terms and Privacy Policy first.');
    if(!isAgencyPartner())return ctx.projectSign?.();
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
    if(!rows.length){ctx.modal('Manage master agreement','No master signature is recorded for this workspace. A replacement cannot be requested until an original signature exists.','<p class="muted">Choose an agreement route in the client settings, then ask the client to sign the applicable agreement.</p>',null);return;}
    ctx.modal('Manage master agreement','Original signed records are retained. Request a replacement only when the current agreement should no longer authorize downloads.',`${rows.map(s=>`<article class="record"><strong>${esc(s.name)}</strong><p>${esc(s.id)} · ${esc(ctx.dateText(s.signedAt))}</p>${signatureImage(s.image)?`<img class="signature-image" src="${signatureImage(s.image)}" alt="Captured master signature">`:''}</article>`).join('')}<label class="check-field"><input type="checkbox" name="replace" required> Request a replacement master signature and suspend final downloads until it is signed.</label>`,async()=>{const draft=clone(ctx.getClient());draft.masterRevision=(Number(draft.masterRevision)||1)+1;await ctx.saveClient(draft,'Replacement master signature requested');ctx.finishModal();},'Request replacement');
  }
  return {portal,master,isAgencyPartner,projectSignature,projectReady,consent,acknowledged,showConsent,clientPanel,projectPanel,details,sign,acknowledge,manage,sections,masterText};
}
