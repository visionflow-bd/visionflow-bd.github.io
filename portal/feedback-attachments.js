// Small documents stay behind Firestore rules; no public storage URL is minted.
export const ATTACHMENT_LIMIT = 3;
export const ATTACHMENT_BYTES = 512 * 1024;
export const ATTACHMENT_ACCEPT = '.pdf,.docx,.txt,.png,.jpg,.jpeg';
const TYPES = {
  pdf:'application/pdf', docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt:'text/plain', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg'
};
const fail = () => { throw Error('This attachment is invalid or damaged. Ask the sender to submit it again.'); };
const hex = bytes => [...bytes].map(n=>n.toString(16).padStart(2,'0')).join('');
const digest = async bytes => hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));
const encode = bytes => {
  let binary='';
  for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(binary);
};
function safeName(name) {
  return typeof name==='string' && name.length>0 && name.length<=160
    && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069/\\<>:"|?*]/u.test(name)
    && !/^[. ]|[. ]$/.test(name);
}
function validBytes(bytes,mime) {
  const starts = expected => expected.every((n,i)=>bytes[i]===n);
  if(mime===TYPES.pdf)return starts([37,80,68,70,45]);
  if(mime===TYPES.png)return starts([137,80,78,71,13,10,26,10]);
  if(mime===TYPES.jpg)return starts([255,216,255]);
  if(mime===TYPES.docx)return starts([80,75,3,4]);
  if(mime===TYPES.txt){try{return !new TextDecoder('utf-8',{fatal:true}).decode(bytes).includes('\0');}catch{return false;}}
  return false;
}
export function attachmentMeta(record) {
  const {id,name,mime,size,sha256}=record;
  return {id,name,mime,size,sha256};
}
function validMeta(meta) {
  return meta && /^[A-Za-z0-9_-]{1,200}$/.test(meta.id) && safeName(meta.name)
    && TYPES[meta.name.split('.').at(-1).toLowerCase()]===meta.mime
    && Number.isSafeInteger(meta.size) && meta.size>0 && meta.size<=ATTACHMENT_BYTES
    && /^[a-f0-9]{64}$/.test(meta.sha256);
}
export async function prepareFeedbackAttachments(files,{id,collection='confirms',projectKey,itemNumber=0,timestamp}) {
  const selected=Array.from(files||[]);
  if(selected.length>ATTACHMENT_LIMIT)throw Error('Attach at most 3 files per request.');
  if(!/^[A-Za-z0-9_-]{1,190}$/.test(id)||!['confirms','feedback'].includes(collection))throw Error('Invalid attachment identity.');
  const prepared=[];
  for(const [index,file] of selected.entries()){
    const name=String(file.name||'').normalize('NFC'),mime=TYPES[name.split('.').at(-1).toLowerCase()];
    if(!safeName(name)||!mime)throw Error('Use PDF, DOCX, UTF-8 TXT, PNG or JPG with a plain filename (up to 160 characters).');
    if(!file.size||file.size>ATTACHMENT_BYTES)throw Error('Each attachment must be non-empty and no larger than 512 KiB.');
    const bytes=new Uint8Array(await file.arrayBuffer());
    if(bytes.length!==file.size||!validBytes(bytes,mime))throw Error('The file content does not match its extension. Use a valid PDF, DOCX, TXT, PNG or JPG.');
    prepared.push({id:`${id}-a${index+1}`,name,mime,size:bytes.length,sha256:await digest(bytes),
      content:encode(bytes),feedbackId:id,feedbackCollection:collection,projectKey,itemNumber,uploadedAt:timestamp});
  }
  return prepared;
}
export function validateAttachmentSubmission({attachments,records,id,collection,projectKey,itemNumber}) {
  if(!Array.isArray(attachments)||!Array.isArray(records)||records.length>ATTACHMENT_LIMIT||records.length!==attachments.length)fail();
  if(records.some((r,i)=>!validMeta(r)||r.id!==`${id}-a${i+1}`||r.feedbackId!==id||r.feedbackCollection!==collection
    ||r.projectKey!==projectKey||r.itemNumber!==itemNumber||typeof r.content!=='string'||r.content.length>699052
    ||Object.keys(attachmentMeta(r)).some(key=>r[key]!==attachments[i]?.[key])))fail();
}
export async function attachmentDownloadBytes(record,meta,{id,collection,projectKey,itemNumber}) {
  if(!validMeta(meta)||!record||record.feedbackId!==id||record.feedbackCollection!==collection
    ||record.projectKey!==projectKey||record.itemNumber!==itemNumber
    ||Object.keys(attachmentMeta(meta)).some(key=>record[key]!==meta[key])
    ||typeof record.content!=='string'||record.content.length!==4*Math.ceil(meta.size/3)
    ||!/^[A-Za-z0-9+/]*={0,2}$/.test(record.content))fail();
  let bytes;try{bytes=Uint8Array.from(atob(record.content),c=>c.charCodeAt(0));}catch{fail();}
  if(bytes.length!==meta.size||!validBytes(bytes,meta.mime)||await digest(bytes)!==meta.sha256)fail();
  return bytes;
}
export const attachmentSize = size => `${Math.ceil(Number(size||0)/1024)} KiB`;
