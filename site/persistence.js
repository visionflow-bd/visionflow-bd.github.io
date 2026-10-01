// Browser integration for conflict-checked site/main writes. Public snapshots
// remain authoritative regardless of browser clock or optimistic local state.
let _siteCloudLatest=null,_siteViewBase=null,_siteEditorBase=null,_siteServerReady=false,_siteSaving=false;
function _siteAdopt(data){
  if(!data)return;
  const leads=STATE.data?.leads||[];
  const view=_deepMerge(_buildSiteCloudPayload(data),DEFAULT_DATA);
  view.leads=leads;STATE.data=view;
  _siteViewBase={raw:_buildSiteCloudPayload(data),view:_buildSiteCloudPayload(view)};
  try{saveLocal();}catch{/* Cloud remains authoritative when the cache is full. */}
}
function _siteBeginEdit(){
  if(_siteSaving){showToast('Wait for the current save to finish.','error');return false;}
  if(_siteServerReady&&_siteCloudLatest)_siteAdopt(_siteCloudLatest);
  _siteEditorBase=VFSiteStore.clone(_siteViewBase);
  return true;
}
function _siteReceiveSnapshot(snap){
  if(snap.metadata?.fromCache){_siteServerReady=false;return;}
  if(snap.metadata?.hasPendingWrites)return;
  _siteServerReady=true;_siteCloudLatest=snap.exists()?_buildSiteCloudPayload(snap.data()):null;
  if(!_siteCloudLatest){
    if(STATE.isAdmin)showToast('Cloud site data is missing. Local defaults were not published.','error');
    return;
  }
  // Keep open form values intact. Its original baseline will detect conflicts.
  if(_siteSaving||document.querySelector('#admin-panel-modal.open,#edit-modal.open'))return;
  _siteAdopt(_siteCloudLatest);renderAllDebounced();_syncLeadBadge();
}
function _siteEndEdit(){
  if(_siteSaving||document.querySelector('#edit-modal.open'))return;
  if(!document.querySelector('#admin-panel-modal.open')){
    if(_siteCloudLatest)_siteAdopt(_siteCloudLatest);
    _siteEditorBase=null;renderAllDebounced();
  }
}
function _siteCanMutate(){
  try{_requireMediaAdmin();if(_siteSaving)throw Error('Wait for the current save to finish.');return true;}
  catch(error){showToast(error.message,'error');return false;}
}
async function persist(base=_siteEditorBase||_siteViewBase){
  if(!_siteCanMutate())return false;
  const panels=[...document.querySelectorAll('#admin-panel-modal,#edit-modal')].map(panel=>[panel,panel.inert]);
  try{
    if(!_siteServerReady||!base)throw Object.assign(Error('Wait for a fresh cloud snapshot before saving. Local cache was not published.'),{code:'site/not-ready'});
    if(!_siteCloudLatest)throw Object.assign(Error('Cloud site data is missing. Restore a verified backup before editing.'),{code:'site/missing'});
    const draft=VFSiteStore.projectDraft(base.raw,base.view,_buildSiteCloudPayload(STATE.data)),sdk=window.__fb;
    _siteSaving=true;panels.forEach(([panel])=>panel.inert=true);_clearSaveErrorBanner();
    const committed=await VFSiteStore.save({base:base.raw,draft,transaction:fn=>sdk.runTransaction(STATE.fbDb,tx=>fn({
      get:async path=>{const snap=await tx.get(sdk.doc(STATE.fbDb,path));return snap.exists()?snap.data():null;},
      set:(path,data)=>tx.set(sdk.doc(STATE.fbDb,path),data)
    }))});
    // A newer server snapshot received during commit must not be replaced by an
    // older local result. No wall-clock/ignore-window heuristic is used.
    if((_siteCloudLatest?.meta?.revision??0)<=(committed.meta?.revision??0))_siteCloudLatest=committed;
    _siteAdopt(_siteCloudLatest);_siteEditorBase=VFSiteStore.clone(_siteViewBase);return true;
  }catch(error){
    if(_siteCloudLatest)_siteAdopt(_siteCloudLatest);
    const code=error?.code||'network';
    const message=code.startsWith('site/')?error.message:code==='permission-denied'?'Cloud save denied. Check your administrator session and access; this change was not saved.':code==='resource-exhausted'?'Cloud save rejected its size or quota limit. No image or content was silently removed.':'Cloud save could not be confirmed. Keep this editor open and check your connection before retrying.';
    showToast(message,'error');_showSaveErrorBanner(`<strong>Save not confirmed.</strong><br>${esc(message)}`);
    return false;
  }finally{_siteSaving=false;panels.forEach(([panel,inert])=>panel.inert=inert);}
}
window.addEventListener('beforeunload',event=>{if(_siteSaving){event.preventDefault();event.returnValue='';}});
