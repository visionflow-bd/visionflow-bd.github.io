import {mkdir,open,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
export async function writePrivateJson(file,data){
  const handle=await open(file,'wx',0o600);
  try{await handle.writeFile(JSON.stringify(data,null,2),'utf8');await handle.sync();}finally{await handle.close();}
}
export function fileJournal(directory){
  return {
    async start(data){await mkdir(directory,{recursive:false});await writePrivateJson(path.join(directory,'manifest.json'),data);},
    prepare:(index,data)=>writePrivateJson(path.join(directory,`${String(index).padStart(6,'0')}-prepared.json`),data),
    commit:(index,data)=>writePrivateJson(path.join(directory,`${String(index).padStart(6,'0')}-committed.json`),data),
    complete:data=>writePrivateJson(path.join(directory,'complete.json'),data)
  };
}
export async function readCommittedJournal(directory,plan){
  const files=await readdir(directory),manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));
  if(manifest.planDigest!==plan.digest||manifest.database!==plan.database||manifest.rollback)throw Error('Journal does not belong to this restore plan.');
  const prepared=files.filter(f=>/^\d{6}-prepared\.json$/.test(f));
  for(const name of prepared)if(!files.includes(name.replace('prepared','committed')))throw Error('Journal contains an uncertain commit. Reconcile it before rollback; no blind retry.');
  const committed=[];
  for(const file of files.filter(f=>/^\d{6}-committed\.json$/.test(f)).sort()){
    if(!files.includes(file.replace('committed','prepared')))throw Error('Journal is incomplete.');
    const row=JSON.parse(await readFile(path.join(directory,file),'utf8'));
    if(!Array.isArray(row.documents))throw Error('Journal commit has no versioned document receipts.');committed.push(...row.documents);
  }
  return {manifest,committed};
}
