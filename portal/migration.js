import {clone,normalizeClient,prepareSecureSave,publicSnapshot,PORTAL_VERSION,deliveryLinks,projectsOf,sameRecord} from './data.js';

// Builds an auditable migration without writing or altering the input. The
// production runner must enforce each document's updateTime precondition.
export function planSecureMigration(clientDocument, publicDocument, {decode,encode,now,deliveryDocuments}) {
  if(!clientDocument?.name||!clientDocument.updateTime)throw new Error('A versioned private source document is required.');
  if(!Array.isArray(deliveryDocuments))throw new Error('Read the complete delivery manifest collection before planning migration.');
  if(!Number.isFinite(Date.parse(now)))throw new Error('A valid migration timestamp is required.');
  const slug=clientDocument.name.split('/').at(-1);
  const original=decode({mapValue:{fields:clientDocument.fields||{}}});
  if(!original.accessToken)throw new Error('Client has no private access token; manual review required.');
  if(original.accessRotation||original.archiveState||original.purgeState||Object.values(original.trash||{}).some(t=>t.restoreState||t.purgeState))throw new Error('Finish protected recovery before migrating this client.');
  const base=clientDocument.name.slice(0,clientDocument.name.indexOf('/portal_clients/'));
  const publicName=`${base}/portal_public/${original.accessToken}`;
  if(publicDocument&&publicDocument.name!==publicName)throw new Error('Public source does not belong to this private client.');
  if(publicDocument&&!publicDocument.updateTime)throw new Error('A versioned public source document is required.');
  const previous=normalizeClient(original,slug),next=normalizeClient(original,slug);
  prepareSecureSave(next,previous);
  const snapshot=publicSnapshot(next,slug);
  const documents=new Map();
  for(const document of deliveryDocuments){
    const key=document.name?.slice((publicName+'/deliveries/').length);
    if(!document.name?.startsWith(publicName+'/deliveries/')||!key||key.includes('/')||!document.updateTime||documents.has(key))throw new Error('Invalid or duplicate delivery manifest source.');
    documents.set(key,document);
  }
  const manifests=[];
  for(const [key,project]of projectsOf(next)){
    const existing=documents.get(key),data={projectKey:key,version:project.deliveryVersion,links:deliveryLinks(project)};
    if(!existing||!sameRecord(decode({mapValue:{fields:existing.fields||{}}}),data)){
      manifests.push({update:{name:`${publicName}/deliveries/${key}`,fields:encode(data).mapValue.fields},currentDocument:existing?{updateTime:existing.updateTime}:{exists:false}});
    }
  }
  // Unexpected old manifests may contain historical evidence or belong to a
  // different schema. Never silently discard them during a format migration.
  if([...documents.keys()].some(key=>!next.projects[key]||next.projects[key].deleted))throw new Error('Unexpected legacy delivery manifests require a reviewed cleanup plan.');
  if(publicDocument){const prior=decode({mapValue:{fields:publicDocument.fields||{}}});
    if(prior.clientSlug&&prior.clientSlug!==slug)throw new Error('Private token is shared by another client.');
    if(prior.enabled===false&&snapshot.enabled===true)throw new Error('Public link is paused but private state is active. Preserve the pause and reconcile before migration.');
    const withoutTime=value=>{const copy=clone(value);delete copy.lastUpdated;return copy;};
    if(prior.portalVersion===PORTAL_VERSION&&manifests.length===0&&sameRecord(original.deliverySecretUrls,next.deliverySecretUrls)&&sameRecord(withoutTime(prior),withoutTime(snapshot)))return {slug,alreadyCurrent:true,writes:[],manifestCount:0};
  }
  // Preserve exact private Firestore types and original financial/history fields.
  // Only derived authorization versions and the concurrency revision are added.
  const privateFields=clone(clientDocument.fields);
  privateFields.deliverySecretUrls=encode(next.deliverySecretUrls);
  for(const [key,p]of Object.entries(next.projects)){
    if(p.deleted)continue;
    const fields=privateFields.projects?.mapValue?.fields?.[key]?.mapValue?.fields;
    if(!fields)throw new Error('Private project structure is invalid.');
    fields.agreementRevision=encode(p.agreementRevision);
    fields.deliveryVersion=encode(p.deliveryVersion);
  }
  privateFields._revision=encode((Number(original._revision)||0)+1);
  privateFields._lastMutationId=encode(`secure-v${PORTAL_VERSION}-${clientDocument.updateTime}`);
  privateFields.lastUpdated=encode(now);
  snapshot.lastUpdated=now;
  const writes=[
    {update:{name:clientDocument.name,fields:privateFields},currentDocument:{updateTime:clientDocument.updateTime}},
    {update:{name:publicName,fields:encode(snapshot).mapValue.fields},currentDocument:publicDocument?{updateTime:publicDocument.updateTime}:{exists:false}},
    ...manifests,
  ];
  if(writes.length>450)throw new Error('This client needs a separately staged migration; too many project manifests for one bounded commit.');
  // JSON character counts undercount Bangla/multibyte content. This is a
  // conservative transport-size guard, not an exact Firestore storage estimate.
  for(const write of writes)if(new TextEncoder().encode(JSON.stringify(write.update.fields)).byteLength>900000)throw new Error('Document is too large for automatic migration.');
  return {slug,alreadyCurrent:false,writes,manifestCount:manifests.length,sharingEnabled:snapshot.enabled};
}
