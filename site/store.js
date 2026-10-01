(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.VFSiteStore=api;
})(typeof window==='object'?window:globalThis,function(){
  'use strict';
  const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
  function equal(a,b){
    if(a===b)return true;
    if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
    const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(key=>own(b,key)&&equal(a[key],b[key]));
  }
  function conflict(path){
    const error=Error(`Cloud content changed in ${path||'the site'}. Your edit was not saved. Reopen that editor and review the latest content before retrying.`);
    error.code='site/conflict';throw error;
  }
  // Apply only explicit local changes. Independently changed arrays are atomic:
  // rejecting their conflict is safer than guessing item order or deletion intent.
  function merge(base,draft,remote,path=''){
    if(equal(base,draft))return clone(remote);
    if(equal(base,remote)||equal(draft,remote))return clone(draft);
    if(object(base)&&object(draft)&&object(remote)){
      const output={};
      for(const key of new Set([...Object.keys(base),...Object.keys(draft),...Object.keys(remote)])){
        if(['__proto__','prototype','constructor'].includes(key))throw Error('Unsupported site field.');
        const value=merge(base[key],draft[key],remote[key],path?`${path}.${key}`:key);
        if(value!==undefined)output[key]=value;
      }
      return output;
    }
    return conflict(path);
  }
  function publicData(value){
    if(!object(value))throw Error('Invalid site content.');
    const result=clone(value);delete result.leads;delete result.notifications;
    if(object(result.site))delete result.site.notifications;
    if(object(result.meta)){delete result.meta.updatedAt;delete result.meta.revision;}
    return result;
  }
  // Display-only defaults are not cloud data. Project explicit form changes
  // onto the exact raw baseline before checking for concurrent server edits.
  function projectDraft(raw,view,draft){
    if(equal(view,draft))return clone(raw);
    if(object(view)&&object(draft)&&(raw===undefined||object(raw))){
      const result=clone(raw)||{};
      for(const key of new Set([...Object.keys(view),...Object.keys(draft)])){
        if(['__proto__','prototype','constructor'].includes(key))throw Error('Unsupported site field.');
        const value=projectDraft(raw?.[key],view[key],draft[key]);
        if(value===undefined)delete result[key];else result[key]=value;
      }
      return result;
    }
    return clone(draft);
  }
  async function save({base,draft,transaction,now=Date.now}){
    const original=publicData(base),desired=publicData(draft);
    return transaction(async tx=>{
      const current=await tx.get('site/main');
      if(!current)throw Object.assign(Error('Cloud site data is missing. Restore a verified backup before editing; local defaults were not published.'),{code:'site/missing'});
      const result=merge(original,desired,publicData(current));
      const revision=current.meta?.revision??0;
      if(!Number.isSafeInteger(revision)||revision<0||revision===Number.MAX_SAFE_INTEGER)throw Error('Invalid site revision.');
      result.meta={...result.meta,revision:revision+1,updatedAt:now()};
      tx.set('site/main',result);return result;
    });
  }
  return {clone,equal,merge,publicData,projectDraft,save};
});
