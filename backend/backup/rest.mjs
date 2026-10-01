import {documentPath} from './snapshot.mjs';
export function createBackupRest({projectId,databaseId='(default)',getToken,origin='https://firestore.googleapis.com',fetchImpl=fetch,pageSize=100}){
  if(!/^[a-z0-9-]+$/.test(projectId)||!/^[A-Za-z0-9()_-]+$/.test(databaseId))throw Error('Invalid database identity.');
  const endpoint=new URL(origin);
  if(endpoint.origin!==origin||!(origin==='https://firestore.googleapis.com'||/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)&&projectId.startsWith('demo-')))throw Error('Only Google Firestore or a demo localhost emulator is allowed.');
  const database=`projects/${projectId}/databases/${databaseId}`,root=`${origin}/v1/${database}/documents`;
  let requests=0;
  async function request(suffix,{method='GET',body}={}){
    if(++requests>100000)throw Error('Backup request limit reached.');
    const token=await getToken();if(!token)throw Error('An existing administrator session is required.');
    let response;try{response=await fetchImpl(root+suffix,{method,redirect:'error',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});}catch{throw Error('Firestore transport failed. Nothing was assumed committed; inspect the journal before retrying a restore.');}
    if(!response.ok){const error=Error(`Firestore request failed (HTTP ${response.status}). No credentials or provider response are included.`);error.status=response.status;throw error;}
    return response.json();
  }
  const encoded=path=>path.split('/').map(encodeURIComponent).join('/');
  async function pages(read,field){let pageToken,seen=new Set(),items=[];do{const result=await read(pageToken);if(result[field]&&!Array.isArray(result[field]))throw Error('Malformed Firestore page.');items.push(...result[field]||[]);pageToken=result.nextPageToken;if(pageToken){if(seen.has(pageToken))throw Error('Firestore pagination repeated a cursor.');seen.add(pageToken);}}while(pageToken);return items;}
  return {
    database,
    async readTime(){const results=await request(':runQuery',{method:'POST',body:{structuredQuery:{from:[{collectionId:'portal_clients'}],select:{fields:[{fieldPath:'__name__'}]},limit:1}}});const readTime=results.at(-1)?.readTime;if(!readTime||!(Date.parse(readTime)>0))throw Error('Firestore did not provide a valid snapshot read time.');return readTime;},
    collectionIds:(parent,readTime)=>pages(pageToken=>request(`${parent?'/'+encoded(parent):''}:listCollectionIds`,{method:'POST',body:{pageSize,readTime,...(pageToken?{pageToken}:{})}}),'collectionIds'),
    documents:(path,readTime)=>pages(pageToken=>request(`/${encoded(path)}?${new URLSearchParams({pageSize:String(pageSize),showMissing:'true',readTime,...(pageToken?{pageToken}:{})})}`),'documents'),
    async get(name){const path=documentPath(name,database);try{return await request('/'+encoded(path));}catch(error){if(error.status===404)return null;throw error;}},
    async commit(writes){
      if(!Array.isArray(writes)||!writes.length||writes.length>400)throw Error('Invalid restore batch.');
      for(const write of writes){documentPath(write.update?.name||write.delete,database);if(!write.currentDocument)throw Error('Unconditional restore writes are forbidden.');}
      return request(':commit',{method:'POST',body:{writes}});
    }
  };
}
