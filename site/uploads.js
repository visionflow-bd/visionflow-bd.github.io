// Browser-only upload workspace. Uploaded assets are drafts until the owner
// reviews and saves an entry; upload completion never means publication.
const _mediaQueue=VFMedia.createQueue();
const _mediaDrafts=new Map();
const _mediaControllers=new Set();
const _mediaDraftKey='vf:media-drafts:v1';
let _mediaRestored=false;
let _mediaDraftCacheFailed=false;
function _isSiteAdmin(user){
  return user?.uid==='m1PGSw7ViEb1xOJoj8INQllra3p1'&&user?.email==='shihabjessore7@gmail.com'&&!user.isAnonymous;
}
function _requireMediaAdmin(){
  const user=STATE.fbAuth?.currentUser;
  if(!STATE.fbConfigured||!STATE.fbDb||!_isSiteAdmin(user))throw Error('Sign in as the site administrator before uploading or changing storage.');
}
function _syncMediaAccess(){
  let allowed=true;try{_requireMediaAdmin();}catch{allowed=false;}
  // Stop unsent work on auth loss. An aborted active request may already have
  // reached the provider; its error card deliberately keeps that warning.
  if(!allowed)for(const controller of _mediaControllers)controller.abort();
  const panel=document.querySelector('#upload-progress-panel');
  if(panel)panel.style.display=allowed?'flex':'none';
}
function _saveMediaDrafts(){
  try{localStorage.setItem(_mediaDraftKey,JSON.stringify([..._mediaDrafts.values()]));_mediaDraftCacheFailed=false;}
  catch{_mediaDraftCacheFailed=true;showToast('Draft cache could not be saved. Copy the uploaded URL before leaving this page.','error');}
  const panel=document.querySelector('#upload-progress-panel');if(!panel)return;
  let warning=panel.querySelector('.media-cache-warning');
  if(!_mediaDraftCacheFailed||!_mediaDrafts.size){warning?.remove();return;}
  if(!warning){warning=document.createElement('p');warning.className='media-cache-warning';warning.setAttribute('role','alert');warning.style.cssText='margin:0;padding:12px;color:#fecdd3;background:#27131c;border:1px solid #f43f5e;border-radius:10px';panel.prepend(warning);}
  warning.textContent='Draft cache unavailable. Copy your uploaded URLs before leaving; these drafts may not survive a reload.';
}
function _restoreMediaDrafts(){
  try{_requireMediaAdmin();}catch{return;}
  if(_mediaRestored)return;_mediaRestored=true;
  try{
    const values=JSON.parse(localStorage.getItem(_mediaDraftKey)||'[]');
    if(!Array.isArray(values)||values.length>100)return;
    for(const value of values){
      if(!value||!['image','video'].includes(value.kind)||!VFMedia.cloudAsset(value.url,value.kind)||!/^[a-z0-9-]{1,100}$/i.test(value.id||''))continue;
      const draft={id:value.id,url:value.url,kind:value.kind,name:String(value.name||'Uploaded media').slice(0,255),size:Number.isSafeInteger(value.size)?value.size:0};
      _mediaDrafts.set(draft.id,draft);_showReadyMedia(_createUploadCard(draft.name,draft.size),draft);
    }
  }catch{showToast('Saved media draft list could not be read; no cloud files were changed.','error');}
}
function _showReadyMedia(card,draft){
  _finishUploadCard(card,true,'Uploaded - not published',true);
  card.dataset.mediaDraft=draft.id;
  const detail=card.querySelector('.up-detail');detail.textContent='Uploaded; review and save to publish.';
  card.querySelector('.up-speed').textContent='';
  const actions=document.createElement('div');actions.className='media-upload-actions';
  const link=document.createElement('a');link.href=draft.url;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Open file';
  const copy=document.createElement('button');copy.type='button';copy.textContent='Copy URL';
  copy.onclick=async()=>{try{_requireMediaAdmin();await navigator.clipboard.writeText(draft.url);copy.textContent='Copied';}catch{showToast('Open file and copy its address if clipboard access is unavailable.','error');}};
  const use=document.createElement('button');use.type='button';use.textContent='Create portfolio entry';
  use.onclick=()=>{
    try{_requireMediaAdmin();}catch(error){showToast(error.message,'error');return;}
    if(document.querySelector('#edit-modal.open')){showToast('Save or close the current editor first. This uploaded file is retained here.','error');return;}
    editItem('portfolio',null);const form=document.querySelector('#edit-form');
    form.elements[draft.kind==='video'?'video':'img'].value=draft.url;
    form.elements.title.value=draft.name.replace(/\.[^.]+$/,'').replace(/[_-]+/g,' ').trim();
    form.elements.year.value=String(new Date().getFullYear());form.dataset.mediaDrafts=draft.id;
    showToast('Filename filled as a draft. Review title, category and description before saving.','success');
  };
  const dismiss=document.createElement('button');dismiss.type='button';dismiss.textContent='Dismiss';
  dismiss.onclick=()=>{_mediaDrafts.delete(draft.id);_saveMediaDrafts();card.remove();};
  actions.append(link,copy,use,dismiss);card.appendChild(actions);
}
function _consumeMediaDrafts(form,data){
  for(const id of (form.dataset.mediaDrafts||'').split(' ')){
    const draft=_mediaDrafts.get(id);if(!draft||!Object.values(data).includes(draft.url))continue;
    _mediaDrafts.delete(id);document.querySelector(`[data-media-draft="${id}"]`)?.remove();
  }
  _saveMediaDrafts();
}
function _mediaFormLock(form,delta){
  if(!form)return;
  const pending=Math.max(0,Number(form.dataset.mediaPending||0)+delta);form.dataset.mediaPending=String(pending);
  const button=form.querySelector('[type="submit"]');if(button)button.disabled=pending>0||form.dataset.saving==='true';
}
async function _queueMediaFile(file,kind,target){
  _requireMediaAdmin();VFMedia.validateFile(file,kind);_restoreMediaDrafts();
  if(_mediaDrafts.size+_mediaQueue.pending()>=100)throw Error('Review or dismiss saved upload drafts before adding more files.');
  const list=VFMedia.accounts(kind==='video'?_getVidAccounts():_getImgAccounts());
  if(!list.length)throw Error(`No active ${kind} storage account.`);
  const card=_createUploadCard(file.name,file.size),form=target?.form;
  card.querySelector('.up-speed').textContent='Queued';card.querySelector('.up-eta').textContent='';
  const controller=new AbortController(),cancel=document.createElement('button');_mediaControllers.add(controller);cancel.type='button';cancel.className='media-upload-cancel';cancel.textContent='Cancel upload';cancel.onclick=()=>controller.abort();card.appendChild(cancel);
  let start=Date.now();_mediaFormLock(form,1);
  const oldValue=target?.value;
  try{
    const result=await _mediaQueue.add(file,kind,list,{signal:controller.signal,onAttempt:({index,total})=>{
      _requireMediaAdmin();start=Date.now();_updateUploadCard(card,0,file.size,start);
      card.querySelector('.up-speed').textContent=`Storage ${index+1} of ${total}`;
    },onProgress:({loaded,total})=>_updateUploadCard(card,loaded,total,start)});
    const draft={...result,id:uid(),name:file.name.slice(0,255),size:file.size};_mediaDrafts.set(draft.id,draft);_saveMediaDrafts();
    // An old editor must never overwrite a new editor or a manually edited URL.
    if(target?.isConnected&&target.value===oldValue){target.value=result.url;form.dataset.mediaDrafts=[form.dataset.mediaDrafts,draft.id].filter(Boolean).join(' ');}
    cancel.remove();_showReadyMedia(card,draft);
  }catch(error){cancel.remove();_finishUploadCard(card,false,error.message,true);const dismiss=document.createElement('button');dismiss.type='button';dismiss.textContent='Dismiss';dismiss.onclick=()=>card.remove();card.appendChild(dismiss);throw error;}
  finally{_mediaControllers.delete(controller);_mediaFormLock(form,-1);_syncMediaAccess();}
}
async function _enqueueInlineMedia(event,targetName,kind){
  const input=event.target,file=input.files?.[0];if(!file)return;
  const target=input.form?.elements.namedItem(targetName);
  if(!target){showToast('Open the editor again before uploading.','error');return;}
  input.disabled=true;
  try{await _queueMediaFile(file,kind,target);showToast('Upload complete. Review the editor and save to publish.','success');}
  catch(error){showToast(error.message,'error');}
  finally{input.disabled=false;input.value='';}
}
async function _batchMediaUpload(event,kind){
  const input=event.target,files=[...input.files||[]];input.value='';
  try{_requireMediaAdmin();if(files.length>20)throw Error('Select up to 20 files per batch.');files.forEach(file=>VFMedia.validateFile(file,kind));}
  catch(error){showToast(error.message,'error');return;}
  await Promise.all(files.map(file=>_queueMediaFile(file,kind).catch(error=>showToast(error.message,'error'))));
}
window.addEventListener('beforeunload',event=>{if(_mediaQueue.pending()||(_mediaDraftCacheFailed&&_mediaDrafts.size)){event.preventDefault();event.returnValue='';}});

async function _submitSiteEdit(event,{key,id,recordId,fields}){
  event.preventDefault();const form=event.target,button=form.querySelector('[type="submit"]');
  if(form.dataset.saving==='true'||Number(form.dataset.mediaPending||0)>0)return;
  let previous,next;const controls=[...form.querySelectorAll('input,textarea,select,button')].map(control=>[control,control.disabled]);
  try{
    _requireMediaAdmin();if(_cloudSaving||_siteSaving)throw Error('Wait for the current save to finish.');
    form.dataset.saving='true';controls.forEach(([control])=>control.disabled=true);button.textContent='Saving...';
    const data={};
    for(const field of fields){
      if(['imgupload','videoupload'].includes(field.type))continue;
      const input=form.elements.namedItem(field.k);if(!input)continue;
      if(field.type==='checkbox')data[field.k]=input.checked;
      else if(field.type==='csv')data[field.k]=input.value.split(',').map(x=>x.trim()).filter(Boolean);
      else if(field.type==='json'||field.type==='sociallist'){
        try{data[field.k]=JSON.parse(input.value||'[]');}catch{throw Error(`Invalid JSON: ${field.label}`);}
        if(field.type==='sociallist'){
          if(!Array.isArray(data[field.k]))throw Error('Social links must be a list.');
          data[field.k]=data[field.k].filter(s=>(s.url||'').trim()).map(s=>({url:s.url.trim(),icon:(s.icon||'').trim()||detectSocialIcon(s.url)}));
        }
      }else data[field.k]=input.value;
    }
    previous=STATE.data[key]||[];next=previous.slice();const index=next.findIndex(item=>item.id===recordId);
    if(id&&index<0)throw Error('This entry no longer exists. Close the editor and reload it.');
    const saved={...(index<0?{}:next[index]),...data,id:recordId};
    if(index<0)next.push(saved);else next[index]=saved;STATE.data[key]=next;
    if(!await persist(form._siteBase)){if(STATE.data[key]===next)STATE.data[key]=previous;return;}
    _consumeMediaDrafts(form,data);if(form.isConnected&&document.querySelector('#edit-form')===form)closeModal('edit-modal',true);
    showToast('Saved successfully','success');renderAll();if(_adminCurrentTab)adminTab(_adminCurrentTab);
  }catch(error){if(next&&STATE.data[key]===next)STATE.data[key]=previous;showToast(error.message,'error');}
  finally{form.dataset.saving='false';controls.forEach(([control,disabled])=>control.disabled=disabled);button.disabled=Number(form.dataset.mediaPending||0)>0;button.innerHTML=`<i class="fas fa-save"></i> ${id?'Update':'Create'}`;}
}
