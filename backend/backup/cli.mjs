import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createBackupRest} from './rest.mjs';
import {exportSnapshot,validateBackup} from './snapshot.mjs';
import {planRestore,applyRestore,rollbackRestore} from './restore.mjs';
import {fileJournal,writePrivateJson,readCommittedJournal} from './journal.mjs';

const args=process.argv.slice(2),command=args.shift(),options={};
for(let i=0;i<args.length;i++){
  const key=args[i];if(!['--project','--out','--input','--emulator','--firebase-cli','--current','--replacements','--plan','--journal','--source-journal','--operation','--acknowledge-live-write'].includes(key)||Object.hasOwn(options,key))throw Error('Unknown or repeated option.');
  options[key]=['--firebase-cli','--acknowledge-live-write'].includes(key)?true:args[++i];if(!options[key])throw Error('Missing option value.');
}
async function existingToken(){
  if(options['--emulator'])return 'owner';
  if(process.env.VF_FIRESTORE_ACCESS_TOKEN)return process.env.VF_FIRESTORE_ACCESS_TOKEN;
  if(!options['--firebase-cli'])throw Error('Use an existing token or explicitly select the existing Firebase CLI session.');
  const require=createRequire(import.meta.url),auth=require(path.join(process.env.APPDATA,'npm/node_modules/firebase-tools/lib/auth.js'));
  const account=auth.getGlobalDefaultAccount();if(!account)throw Error('No existing Firebase CLI account; no login was attempted.');
  try{
    const credentials=await auth.getAccessToken(account.tokens.refresh_token,['https://www.googleapis.com/auth/cloud-platform']);
    return credentials.access_token;
  }catch{throw Error('The existing Firebase CLI session could not authorize this request. No account or login was changed.');}
}
async function main(){
  const read=async file=>JSON.parse(await readFile(file,'utf8'));
  if(command==='inspect'){
    const backup=await validateBackup(JSON.parse(await readFile(options['--input'],'utf8')));
    console.log(JSON.stringify({valid:true,database:backup.database,readTime:backup.readTime,documents:backup.documents.length,collections:backup.collections.length,missingParents:backup.missingParents.length,digest:backup.digest,exclusions:backup.exclusions},null,2));return;
  }
  if(command==='plan'){
    const plan=await planRestore(await read(options['--input']),await read(options['--current']),{replacePaths:options['--replacements']?await read(options['--replacements']):[]});
    await writePrivateJson(options['--out'],plan);
    console.log(JSON.stringify({planned:true,operations:plan.operations.length,conflicts:plan.conflicts.length,digest:plan.digest,path:path.resolve(options['--out']),writtenToFirestore:false},null,2));return;
  }
  if(!['export','apply','rollback'].includes(command)||!options['--project'])throw Error('Use export, inspect, plan, apply or rollback. See backend/backup/README.md.');
  const adapter=createBackupRest({projectId:options['--project'],getToken:existingToken,...(options['--emulator']?{origin:options['--emulator']}:{})});
  if(command==='apply'||command==='rollback'){
    if(!options['--acknowledge-live-write']||!options['--operation']||!options['--journal'])throw Error('Recovery requires an existing verified maintenance lock, a unique journal and explicit --acknowledge-live-write.');
    const plan=await read(options['--plan']),journal=fileJournal(options['--journal']),context={adapter,journal,operationId:options['--operation']};
    let result;
    if(command==='apply')result=await applyRestore(plan,context);
    else{const previous=await readCommittedJournal(options['--source-journal'],plan);if(previous.manifest.operationId!==options['--operation'])throw Error('Wrong recovery operation.');result=await rollbackRestore(plan,previous.committed,context);}
    console.log(JSON.stringify(result,null,2));return;
  }
  if(!options['--out'])throw Error('Export needs a new output path.');
  const backup=await exportSnapshot(adapter);
  await writePrivateJson(options['--out'],backup);
  console.log(JSON.stringify({exported:true,database:backup.database,readTime:backup.readTime,documents:backup.documents.length,collections:backup.collections.length,missingParents:backup.missingParents.length,digest:backup.digest,path:path.resolve(options['--out']),warning:'Sensitive private backup; keep it encrypted/offline. This export excludes external systems listed in the manifest.'},null,2));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
