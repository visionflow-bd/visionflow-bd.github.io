import {safeUrl,text,sameRecord} from './data.js?v=20260928-r10';

export function founderBranding(agency={},fallback={}){
  return {signatureUrl:Object.hasOwn(agency,'founderSignature')?safeUrl(agency.founderSignature):fallback.signatureUrl,
    name:text(agency.founderName)||fallback.name,title:text(agency.founderTitle)||fallback.title};
}

export async function saveFounderBranding({expected,next,fallback,authorize,transaction,now=Date.now}){
  authorize();
  if(!text(next.name)||next.name.length>160||!text(next.title)||next.title.length>120||next.signatureUrl&&!safeUrl(next.signatureUrl))throw Error('Check the authorized name, title and signature image.');
  return transaction(async tx=>{
    const current=await tx.get('site/main');authorize();
    if(!current)throw Error('Cloud site data is missing. No signature change was saved.');
    const actual=founderBranding(current.site?.agency,fallback);
    if(!sameRecord(actual,expected)&&!sameRecord(actual,next))throw Error('Founder details changed elsewhere. Reopen the editor to review the latest signature before saving.');
    const revision=current.meta?.revision??0;
    if(!Number.isSafeInteger(revision)||revision<0||revision===Number.MAX_SAFE_INTEGER)throw Error('Invalid site revision.');
    tx.update('site/main',{'site.agency.founderSignature':next.signatureUrl,'site.agency.founderName':next.name,
      'site.agency.founderTitle':next.title,'meta.updatedAt':now(),'meta.revision':revision+1});
    return next;
  });
}
