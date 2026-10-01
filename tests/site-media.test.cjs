const {test}=require('node:test');
const assert=require('node:assert/strict');
const media=require('../site/media.js');
const list=[{cloud:'synthetic-a',preset:'image-test',active:true},{cloud:'synthetic-b',preset:'next-test',active:true}];
const file={name:'test.png',type:'image/png',size:512};
function transport(responses){
  const requests=[];
  return {requests,xhrFactory:()=>({upload:{},open(method,url){this.method=method;this.url=url;},abort(){this.onabort?.();},send(form){
    requests.push({method:this.method,url:this.url,form,timeout:this.timeout});
    const response=responses.shift();if(!response)throw Error('Unexpected extra request');
    queueMicrotask(()=>{
      this.upload.onprogress?.({lengthComputable:true,loaded:256,total:512});
      if(response.event){this[response.event]();return;}
      this.status=response.status??200;this.responseText=response.raw??JSON.stringify(response.body??{secure_url:`https://res.cloudinary.com/${this.url.split('/')[4]}/image/upload/v1/test.png`,resource_type:'image',width:20,height:10});this.onload();
    });
  }}),formFactory:()=>({values:[],append(...entry){this.values.push(entry);}})};
}
test('upload validation rejects wrong type, empty file and resource limits',()=>{
  for(const type of ['image/svg+xml','text/html','application/pdf','video/mp4',''])assert.throws(()=>media.validateFile({...file,type},'image'));
  for(const size of [0,-1,Infinity,21*1024*1024])assert.throws(()=>media.validateFile({...file,size},'image'));
  media.validateFile(file,'image');media.validateFile({type:'video/quicktime',size:500*1024*1024},'video');
  assert.throws(()=>media.validateFile({type:'video/mp4',size:501*1024*1024},'video'));
});
test('account routing is ordered, active-only, deduplicated and bounded to Cloudinary',()=>{
  assert.deepEqual(media.accounts([list[0],{...list[1],active:false},list[0]]),[{...list[0],label:'synthetic-a'}]);
  for(const cloud of ['../other','bad/evil','https://example.invalid','x?key=x'])assert.throws(()=>media.account({...list[0],cloud}));
  assert.throws(()=>media.account({...list[0],preset:'<bad>'}));
});
test('upload response rejects wrong host, cloud, media type and credentials',()=>{
  const good={resource_type:'image',secure_url:'https://res.cloudinary.com/synthetic-a/image/upload/v1/a.png'};
  assert.equal(media.uploadResult(good,'image',list[0]).kind,'image');
  for(const secure_url of ['https://evil.invalid/res.cloudinary.com/synthetic-a/image/upload/a.png','https://res.cloudinary.com.evil.invalid/synthetic-a/image/upload/a.png','javascript:alert(1)','https://res.cloudinary.com/synthetic-b/image/upload/a.png','https://u:p@res.cloudinary.com/synthetic-a/image/upload/a.png'])assert.throws(()=>media.uploadResult({...good,secure_url},'image',list[0]));
  assert.throws(()=>media.uploadResult({...good,resource_type:'video'},'image',list[0]));
});
test('success waits for provider response and preserves original asset',async()=>{
  const t=transport([{}]),progress=[];const result=await media.upload(file,'image',list,{...t,onProgress:p=>progress.push(p)});
  assert.equal(t.requests.length,1);assert.equal(result.url,'https://res.cloudinary.com/synthetic-a/image/upload/v1/test.png');
  assert.equal(t.requests[0].timeout,120000);assert.equal(t.requests[0].form.values[1][1],'image-test');assert.equal(progress[0].loaded,256);
});
test('confirmed quota rejection falls back for images as well as video',async()=>{
  const t=transport([{status:429,body:{error:{message:'Rate limit exceeded'}}},{}]);
  const result=await media.upload(file,'image',list,t);assert.equal(t.requests.length,2);assert.match(result.url,/synthetic-b/);
  assert.equal(media.quotaRejection(400,{error:{message:'Account storage quota exceeded'}}),true);
  assert.equal(media.quotaRejection(400,{error:{message:'File size limit exceeded'}}),false);
  for(const message of ['Upload limit exceeded','Upload size limit exceeded','Account file size limit exceeded','Account storage quota exceeded; file was accepted','Account upload limit exceeded'])assert.equal(media.quotaRejection(400,{error:{message}}),false,message);
  assert.equal(media.quotaRejection(500,{error:{message:'Account storage quota exceeded'}}),false);
});
test('ambiguous sends and invalid response never spill into a second account',async()=>{
  for(const response of [{event:'onerror'},{event:'ontimeout'},{event:'onabort'},{status:500,body:{error:{message:'quota exceeded'}}},{status:400,body:{error:{message:'File size limit exceeded'}}},{status:400,body:{error:{message:'Upload size limit exceeded'}}},{status:200,raw:'broken'},{status:200,body:{secure_url:'https://wrong.invalid'}}]){
    const t=transport([response,{}]);await assert.rejects(media.upload(file,'image',list,t));assert.equal(t.requests.length,1);
  }
});
test('missing account or aborted request cannot start a network upload',async()=>{
  const t=transport([{}]),controller=new AbortController();controller.abort();
  await assert.rejects(media.upload(file,'image',[],t),/No active/);
  await assert.rejects(media.upload(file,'image',list,{...t,signal:controller.signal}),/cancelled/);
  assert.equal(t.requests.length,0);
});
test('queued uploads are capped at two and continue after one failure',async()=>{
  const release=[],started=[];let active=0,max=0;
  const q=media.createQueue({run:id=>{started.push(id);active++;max=Math.max(max,active);return new Promise((resolve,reject)=>release.push(()=>{active--;id===1?reject(Error('synthetic')):resolve(id);}));}});
  const jobs=[0,1,2,3].map(id=>q.add(id).catch(()=>null));await new Promise(setImmediate);
  assert.deepEqual(started,[0,1]);release.shift()();await new Promise(setImmediate);assert.deepEqual(started,[0,1,2]);
  release.shift()();await new Promise(setImmediate);assert.deepEqual(started,[0,1,2,3]);
  release.splice(0).forEach(fn=>fn());assert.deepEqual(await Promise.all(jobs),[0,null,2,3]);await new Promise(setImmediate);assert.equal(max,2);assert.equal(q.pending(),0);
});
test('cancelling a queued upload removes it before its turn',async()=>{
  let release;const started=[],q=media.createQueue({concurrency:1,run:id=>{started.push(id);return new Promise(resolve=>release=resolve);}}),controller=new AbortController();
  const first=q.add('a'),second=q.add('b',null,null,{signal:controller.signal});await new Promise(setImmediate);controller.abort();
  await assert.rejects(second,/nothing was sent/);release();await first;await new Promise(setImmediate);assert.deepEqual(started,['a']);
});
test('posters use proportional c_limit, not cropping or full original media',()=>{
  const url=media.poster('https://res.cloudinary.com/synthetic-a/video/upload/v1/reel.mp4?download=1');
  assert.match(url,/so_0,w_640,c_limit,f_jpg,q_auto/);assert.ok(url.endsWith('reel.jpg'));assert.doesNotMatch(url,/c_fill|h_400|download/);
  assert.equal(media.poster('https://wrong.invalid/res.cloudinary.com/a/video/upload/a.mp4'),'');
});
test('YouTube links require an exact approved host and canonical video ID',()=>{
  for(const value of ['https://youtu.be/dQw4w9WgXcQ','https://www.youtube.com/watch?v=dQw4w9WgXcQ','https://youtube.com/shorts/dQw4w9WgXcQ'])assert.equal(media.youtubeId(value),'dQw4w9WgXcQ');
  for(const value of ['https://evil.invalid/watch?v=dQw4w9WgXcQ','javascript:embed/dQw4w9WgXcQ','https://youtube.com/embed/<bad>','https://u:p@youtube.com/watch?v=dQw4w9WgXcQ'])assert.equal(media.youtubeId(value),'');
});
