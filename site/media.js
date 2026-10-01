(function(root, factory) {
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.VFMedia=api;
})(typeof window==='object'?window:globalThis, function() {
  'use strict';
  const limits={image:20*1024*1024,video:500*1024*1024};
  const types={image:['image/jpeg','image/png','image/webp','image/gif'],video:['video/mp4','video/quicktime','video/webm']};
  function validateFile(file,kind) {
    if(!types[kind]?.includes(file?.type))throw Error(kind==='image'?'Choose a JPG, PNG, WEBP or GIF image.':'Choose an MP4, MOV or WEBM video.');
    if(!Number.isSafeInteger(file.size)||file.size<=0||file.size>limits[kind])throw Error(`${kind==='image'?'Image':'Video'} must be nonempty and no larger than ${limits[kind]/1024/1024}MB.`);
  }
  function account(value) {
    if(!value||!/^[a-z0-9_-]{1,100}$/i.test(value.cloud||'')||!/^[a-z0-9_-]{1,100}$/i.test(value.preset||''))throw Error('Cloud name and unsigned preset must contain only letters, numbers, underscores or hyphens.');
    return {cloud:value.cloud,preset:value.preset,label:String(value.label||value.cloud).slice(0,100),active:value.active===true};
  }
  function accounts(values) {
    if(!Array.isArray(values))throw Error('Invalid cloud account list.');
    const seen=new Set();
    return values.filter(value=>value?.active===true).map(account).filter(value=>{
      const key=value.cloud+'/'+value.preset;if(seen.has(key))return false;seen.add(key);return true;
    });
  }
  function cloudAsset(value,kind) {
    try {
      const url=new URL(value);
      if(url.protocol!=='https:'||url.hostname!=='res.cloudinary.com'||url.port||url.username||url.password||url.hash)return null;
      const parts=url.pathname.split('/');
      if(!/^[a-z0-9_-]+$/i.test(parts[1]||'')||parts[2]!==kind||parts[3]!=='upload'||parts.length<5||!parts.at(-1))return null;
      return {url,cloud:parts[1]};
    } catch {return null;}
  }
  function uploadResult(data,kind,selected) {
    const asset=cloudAsset(data?.secure_url,kind);
    if(!asset||asset.cloud!==selected.cloud||data.resource_type!==kind)throw Error('Upload response did not identify the expected cloud and media type. Check the provider before uploading again.');
    return {url:asset.url.href,kind,width:Number.isSafeInteger(data.width)&&data.width>0?data.width:null,height:Number.isSafeInteger(data.height)&&data.height>0?data.height:null};
  }
  function quotaRejection(status,data) {
    if(status===420||status===429)return true;
    // Never retry an ambiguous transport/5xx or a file-size/preset/type error on
    // another account: the first provider may already have accepted the file.
    return status===400&&/^(?:(?:account|cloud) )?(?:(?:storage|monthly usage|usage|bandwidth|credit|monthly credit|monthly upload) (?:quota|limit)|quota) (?:exceeded|reached)[.!]?$/i.test(String(data?.error?.message||'').trim());
  }
  async function upload(file,kind,list,{xhrFactory=()=>new XMLHttpRequest(),formFactory=()=>new FormData(),onProgress=()=>{},onAttempt=()=>{},signal}={}) {
    validateFile(file,kind);const usable=accounts(list);
    if(!usable.length)throw Error(`No active ${kind} storage account. Configure one before uploading.`);
    for(let index=0;index<usable.length;index++) {
      if(signal?.aborted)throw Error('Upload cancelled.');
      const selected=usable[index];onAttempt({index,total:usable.length,label:selected.label});
      try {
        return await new Promise((resolve,reject)=>{
          const xhr=xhrFactory();let done=false;
          const abort=()=>{xhr.abort();finish(Error('Upload cancelled. The provider may have received it; check before retrying.'));};
          const finish=(error,result)=>{if(done)return;done=true;signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
          xhr.open('POST',`https://api.cloudinary.com/v1_1/${selected.cloud}/${kind}/upload`);
          xhr.timeout=kind==='video'?600000:120000;
          xhr.upload.onprogress=event=>{if(event.lengthComputable&&event.total>0)onProgress({loaded:Math.min(event.loaded,event.total),total:event.total});};
          xhr.onerror=()=>finish(Error('Network outcome unknown. Check your cloud media library before retrying.'));
          xhr.ontimeout=()=>finish(Error('Upload timed out; outcome unknown. Check your cloud media library before retrying.'));
          xhr.onabort=()=>finish(Error('Upload cancelled. The provider may have received it; check before retrying.'));
          xhr.onload=()=>{
            let data;try{data=JSON.parse(xhr.responseText);}catch{finish(Error('Invalid provider response; check your cloud media library before retrying.'));return;}
            if(xhr.status>=200&&xhr.status<300){try{finish(null,uploadResult(data,kind,selected));}catch(error){finish(error);}return;}
            const error=Error(quotaRejection(xhr.status,data)?'This cloud reported an upload quota limit.':`Upload rejected (HTTP ${xhr.status}). Check file size, format and unsigned preset configuration.`);
            error.quota=quotaRejection(xhr.status,data);finish(error);
          };
          const form=formFactory();form.append('file',file);form.append('upload_preset',selected.preset);
          signal?.addEventListener('abort',abort,{once:true});
          if(signal?.aborted){abort();return;}
          try{xhr.send(form);}catch{finish(Error('Upload could not start; check the provider before retrying.'));}
        });
      } catch(error) {if(error.quota&&index<usable.length-1)continue;throw error;}
    }
  }
  function createQueue({concurrency=2,run=upload}={}) {
    if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw Error('Invalid upload concurrency.');
    const waiting=[];let active=0;
    const drain=()=>{
      while(active<concurrency&&waiting.length){
        const job=waiting.shift();job.cleanup();active++;
        Promise.resolve().then(()=>run(...job.args)).then(job.resolve,job.reject).finally(()=>{active--;drain();});
      }
    };
    return {add(...args){return new Promise((resolve,reject)=>{
      const signal=args[3]?.signal;
      if(signal?.aborted){reject(Error('Upload cancelled.'));return;}
      const abort=()=>{const index=waiting.indexOf(job);if(index>=0){waiting.splice(index,1);job.cleanup();reject(Error('Queued upload cancelled; nothing was sent.'));}};
      const job={args,resolve,reject,cleanup:()=>signal?.removeEventListener('abort',abort)};
      waiting.push(job);signal?.addEventListener('abort',abort,{once:true});drain();
    });},pending(){return active+waiting.length;}};
  }
  function poster(value,width=640) {
    const asset=cloudAsset(value,'video');if(!asset)return '';
    const url=asset.url;url.search='';
    url.pathname=url.pathname.replace('/video/upload/',`/video/upload/so_0,w_${width},c_limit,f_jpg,q_auto/`).replace(/\.[a-z0-9]+$/i,'.jpg');
    return url.href;
  }
  function youtubeId(value) {
    try {
      const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.port)return '';
      const host=url.hostname.replace(/^www\./,'');let id='';
      if(host==='youtu.be')id=url.pathname.slice(1);
      else if(['youtube.com','m.youtube.com','youtube-nocookie.com'].includes(host))id=url.pathname==='/watch'?url.searchParams.get('v'):(url.pathname.match(/^\/(?:embed|shorts)\/([^/]+)$/)||[])[1];
      return /^[a-z0-9_-]{11}$/i.test(id||'')?id:'';
    }catch{return '';}
  }
  return {validateFile,account,accounts,cloudAsset,uploadResult,quotaRejection,upload,createQueue,poster,youtubeId};
});
