// Browser guards do not authenticate an unsigned preset at the provider.
const cloud='dohlemsrz',preset='visionflow';
const policies={
  proofs:{types:['image/png','image/jpeg','image/webp','image/gif'],max:10*1024*1024},
  signatures:{types:['image/png'],max:20*1024*1024},
};

export function validatePortalImage(file,purpose){
  const policy=policies[purpose];
  if(!policy)throw Error('Unsupported upload purpose.');
  if(!policy.types.includes(file?.type)||!Number.isSafeInteger(file?.size)||file.size<=0||file.size>policy.max)
    throw Error(`Choose a nonempty ${purpose==='signatures'?'PNG signature':'PNG, JPEG, WebP or GIF image'} no larger than ${policy.max/1024/1024} MB.`);
}

export function portalImageResult(data,purpose){
  if(!policies[purpose]||data?.resource_type!=='image')throw Error('Unexpected upload response. Check the media library before retrying.');
  try{
    const url=new URL(data.secure_url),prefix=new RegExp(`^/${cloud}/image/upload/(?:v[0-9]+/)?visionflow/${purpose}/[^/]+(?:/[^/]+)*$`);
    if(url.protocol!=='https:'||url.hostname!=='res.cloudinary.com'||url.port||url.username||url.password||url.hash||url.search||!prefix.test(url.pathname))throw Error();
    return url.href;
  }catch{throw Error('Unexpected upload location. Check the media library before retrying.');}
}

export async function uploadPortalImage(file,purpose,{authorize,observeAuth,onProgress=()=>{},xhrFactory=()=>new XMLHttpRequest(),formFactory=()=>new FormData()}={}){
  if(typeof authorize!=='function'||typeof observeAuth!=='function')throw Error('Administrator upload authorization is required.');
  authorize();validatePortalImage(file,purpose);
  return new Promise((resolve,reject)=>{
    const xhr=xhrFactory();let done=false,unsubscribe;
    const finish=(error,value)=>{if(done)return;done=true;unsubscribe?.();error?reject(error):resolve(value);};
    const lostAuth=()=>{
      finish(Error('Administrator access ended. Upload cancelled; the provider may have received it. Check the media library before retrying.'));
      xhr.abort();
    };
    try{
      xhr.open('POST',`https://api.cloudinary.com/v1_1/${cloud}/image/upload`);xhr.timeout=90000;
      xhr.upload.onprogress=event=>{if(!done&&event.lengthComputable&&event.total>0)onProgress(Math.round(Math.min(event.loaded,event.total)/event.total*100));};
      xhr.onerror=()=>finish(Error('Upload network outcome is unknown. Check the media library before retrying.'));
      xhr.ontimeout=()=>finish(Error('Upload timed out; outcome is unknown. Check the media library before retrying.'));
      xhr.onabort=()=>finish(Error('Upload cancelled; the provider may have received it. Check the media library before retrying.'));
      xhr.onload=()=>{
        if(done)return;
        try{
          authorize();
          if(xhr.status<200||xhr.status>=300)throw Error(`Upload rejected (HTTP ${xhr.status}). Check the media library before retrying.`);
          let data;try{data=JSON.parse(xhr.responseText);}catch{throw Error('Invalid upload response. Check the media library before retrying.');}
          finish(null,portalImageResult(data,purpose));
        }catch(error){finish(error);}
      };
      unsubscribe=observeAuth(allowed=>{if(!allowed&&!done)lostAuth();});
      if(done){unsubscribe?.();return;}
      const body=formFactory();
      if(purpose==='signatures')body.append('file',file,'founder-signature.png');else body.append('file',file);
      body.append('upload_preset',preset);body.append('folder',`visionflow/${purpose}`);
      authorize();xhr.send(body);
    }catch{finish(Error('Upload could not complete. Check administrator access and the media library before retrying.'));}
  });
}
