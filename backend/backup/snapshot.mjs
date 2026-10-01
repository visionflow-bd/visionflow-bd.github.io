export const BACKUP_FORMAT='visionflow-firestore-backup';
export const BACKUP_VERSION=1;
const copy=value=>JSON.parse(JSON.stringify(value));
export const stable=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?`[${value.map(stable).join(',')}]`:`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
export async function fingerprint(value){
  const bytes=new TextEncoder().encode(stable(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
}
export function documentPath(name,database){
  const prefix=`${database}/documents/`;
  if(typeof name!=='string'||!name.startsWith(prefix))throw Error('Document is outside the selected database.');
  const relative=name.slice(prefix.length),parts=relative.split('/');
  if(parts.length%2||parts.some(p=>!p||p==='.'||p==='..'||/[\u0000-\u001f]/.test(p)))throw Error('Invalid document path.');
  return relative;
}
function validValue(value,depth=0){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||depth>32)throw Error('Invalid Firestore value in backup.');
  const [type]=Object.keys(value),v=value[type];
  if(type==='mapValue'){
    if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>k!=='fields'))throw Error('Invalid Firestore map.');
    validFields(v.fields||{},depth+1);return;
  }
  if(type==='arrayValue'){
    if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>k!=='values')||!Array.isArray(v.values||[]))throw Error('Invalid Firestore array.');
    for(const item of v.values||[])validValue(item,depth+1);return;
  }
  const valid=type==='nullValue'?v===null||v==='NULL_VALUE':type==='booleanValue'?typeof v==='boolean'
    :type==='integerValue'?typeof v==='string'&&/^-?\d+$/.test(v)&&BigInt(v)>=-9223372036854775808n&&BigInt(v)<=9223372036854775807n
    :type==='doubleValue'?typeof v==='number'&&Number.isFinite(v)||['NaN','Infinity','-Infinity'].includes(v)
    :type==='timestampValue'?typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(v)&&Number.isFinite(Date.parse(v))
    :type==='stringValue'||type==='referenceValue'?typeof v==='string'
    :type==='bytesValue'?typeof v==='string'&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v)
    :type==='geoPointValue'?v&&typeof v.latitude==='number'&&Math.abs(v.latitude)<=90&&typeof v.longitude==='number'&&Math.abs(v.longitude)<=180&&Object.keys(v).every(k=>['latitude','longitude'].includes(k)):false;
  if(!valid)throw Error(`Invalid Firestore ${type}.`);
}
export function validFields(fields,depth=0){
  if(!fields||typeof fields!=='object'||Array.isArray(fields))throw Error('Invalid document fields.');
  for(const value of Object.values(fields))validValue(value,depth);
}
export async function validateBackup(backup,{database}={}){
  if(backup?.format!==BACKUP_FORMAT||backup.version!==BACKUP_VERSION||!/^projects\/[a-z0-9-]+\/databases\/[^/]+$/.test(backup.database||''))throw Error('Unsupported backup format.');
  if(database&&backup.database!==database)throw Error('Backup belongs to a different database.');
  if(!Number.isFinite(Date.parse(backup.readTime))||!Array.isArray(backup.documents)||!Array.isArray(backup.collections)||!Array.isArray(backup.missingParents))throw Error('Backup is incomplete.');
  const {digest,...body}=backup;if(await fingerprint(body)!==digest)throw Error('Backup checksum does not match. No data was written.');
  const names=new Set();
  for(const document of backup.documents){
    documentPath(document.name,backup.database);
    if(names.has(document.name)||!document.updateTime||!Number.isFinite(Date.parse(document.updateTime)))throw Error('Duplicate or unversioned backup document.');
    if(Date.parse(document.updateTime)>Date.parse(backup.readTime))throw Error('Document is newer than the backup snapshot.');
    names.add(document.name);validFields(document.fields||{});
  }
  for(const name of backup.missingParents){documentPath(name,backup.database);if(names.has(name))throw Error('A missing parent is also a stored document.');names.add(name);}
  const collections=new Set();
  for(const name of backup.collections){
    const parts=name.split('/');if(parts.length%2!==1||parts.some(p=>!p||p==='.'||p==='..')||collections.has(name))throw Error('Invalid collection inventory.');collections.add(name);
  }
  for(const document of backup.documents){const p=documentPath(document.name,backup.database);if(!collections.has(p.slice(0,p.lastIndexOf('/'))))throw Error('Document is absent from the collection inventory.');}
  return backup;
}

// All enumeration uses one server readTime, including missing-parent traversal.
// Any unsupported permission/readTime or page failure aborts the whole export.
export async function exportSnapshot(adapter,{maxDocuments=50000,maxBytes=128*1024*1024,onProgress=()=>{}}={}){
  const readTime=await adapter.readTime(),documents=[],missingParents=[],collections=[];
  const parents=[''],seenParents=new Set(),seenDocuments=new Set();let bytes=0;
  while(parents.length){
    const parent=parents.shift();if(seenParents.has(parent))throw Error('Duplicate parent returned by backup enumeration.');seenParents.add(parent);
    const ids=await adapter.collectionIds(parent,readTime);
    if(new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!id||id.includes('/')))throw Error('Invalid collection IDs returned by the server.');
    for(const id of ids.sort()){
      const relative=parent?`${parent}/${id}`:id;collections.push(relative);
      for(const document of await adapter.documents(relative,readTime)){
        const path=documentPath(document.name,adapter.database);
        if(path.slice(0,path.lastIndexOf('/'))!==relative||seenDocuments.has(document.name))throw Error('Invalid or duplicate document returned by the server.');
        seenDocuments.add(document.name);parents.push(path);
        if(seenDocuments.size>maxDocuments)throw Error('Backup exceeds the configured document/placeholder limit.');
        if(!document.updateTime){missingParents.push(document.name);continue;}
        const saved={name:document.name,fields:copy(document.fields||{}),...(document.createTime?{createTime:document.createTime}:{}),updateTime:document.updateTime};
        bytes+=new TextEncoder().encode(JSON.stringify(saved)).byteLength;
        if(bytes>maxBytes||documents.length>=maxDocuments)throw Error('Backup exceeds the configured size limit; no partial backup is valid.');
        documents.push(saved);onProgress({documents:documents.length,bytes});
      }
    }
  }
  const body={format:BACKUP_FORMAT,version:BACKUP_VERSION,database:adapter.database,readTime,
    exportedAt:new Date().toISOString(),scope:'all-discovered-firestore-documents',
    exclusions:['Firebase Auth users','Firestore rules and indexes','Apps Script source/properties/triggers/IAM','Cloudinary/Drive file bodies','repository source'],
    collections:collections.sort(),missingParents:missingParents.sort(),documents:documents.sort((a,b)=>a.name.localeCompare(b.name))};
  const backup={...body,digest:await fingerprint(body)};await validateBackup(backup);return backup;
}
