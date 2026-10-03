import {paymentMoney} from '../../portal/payment-notification.js';

const proofLocation=/^https:\/\/res\.cloudinary\.com\/dohlemsrz\/image\/upload\/(?:v[0-9]+\/)?visionflow\/proofs\/[A-Za-z0-9_./-]+$/;
const receiptEsc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const receiptLabel=value=>String(value||'').replace(/https?:\/\/\S+/gi,'[view workspace]').replace(/[\r\n]/g,' ').slice(0,200);

export function paymentDocument(context,rows,action) {
  if(!context?.ok)return null;
  const changes=context.source?.paymentChanges,proofs=[];
  for(const change of changes?.identified&&Array.isArray(changes.items)?changes.items:[]){
    if(!change.after)continue;
    const payment=context.project?.payments?.find(p=>p.id===change.after.id);
    if(!payment?.proofUrl)continue;
    // Do not allow external redirects, remote fetch relays or a final-delivery URL.
    if(!proofLocation.test(payment.proofUrl)||payment.proofUrl.includes('/../'))throw Error('Payment proof must use the verified agency proof-upload location.');
    if(!proofs.some(p=>p.url===payment.proofUrl))proofs.push({url:payment.proofUrl,label:`${receiptLabel(payment.date)} / ${paymentMoney(change.after.amount)}`});
  }
  if(proofs.length>10||changes?.count>20)throw Error('Split this payment update into smaller groups before emailing proof attachments.');
  return {schemaVersion:1,client:receiptLabel(context.portal?.name),project:receiptLabel(context.project?.name),rows,action,proofs};
}

export function paymentDocumentHtml(document,images=[]) {
  if(document?.schemaVersion!==1||!Array.isArray(document.rows)||!Array.isArray(images)||images.length!==document.proofs.length)throw Error('Payment document preparation is incomplete.');
  for(const image of images)if(!/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(image))throw Error('Invalid payment proof image.');
  return `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:20mm}body{font-family:Georgia,serif;color:#17313e;font-size:12pt;line-height:1.5}header{border-bottom:4px solid #0f766e;padding-bottom:14px}h1{font-size:26pt;margin:20px 0 8px}h2{font-size:16pt}small{font-family:Arial,sans-serif;color:#526573}table{width:100%;border-collapse:collapse;margin:24px 0;font-family:Arial,sans-serif;font-size:10pt}td{padding:10px;border-bottom:1px solid #dce5e9}td:last-child{text-align:right}.proof{break-before:page;page-break-before:always}.proof img{display:block;max-width:100%;max-height:210mm;object-fit:contain}a{color:#0f766e;overflow-wrap:anywhere}.foot{margin-top:25px;font-size:10pt;color:#526573}</style></head><body><header><strong>VISION FLOW</strong><br><small>Creative Production Agency</small></header><h1>Payment record</h1><p>${receiptEsc(document.client)}<br><strong>${receiptEsc(document.project)}</strong></p><table>${document.rows.map(([label,value])=>`<tr><td>${receiptEsc(label)}</td><td>${receiptEsc(value)}</td></tr>`).join('')}</table><p><a href="${receiptEsc(document.action)}">Review this payment update in your workspace</a></p><p class="foot">This document records an agency payment update and supplied supporting evidence. It is not bank-issued proof, payment verification, a signature or download authorization. Please report discrepancies through your project workspace. Keep this document and its private link confidential.</p>${images.map((image,i)=>`<section class="proof"><h2>Supporting payment proof ${i+1}</h2><p>${receiptEsc(document.proofs[i].label)}</p><img src="${image}" alt="Supporting payment proof ${i+1}"><p class="foot">Evidence supplied with this payment record. Vision Flow has not independently verified the transfer.</p></section>`).join('')}</body></html>`;
}

export function createPaymentAttachment(document,{urlFetch,utilities,htmlService}) {
  let bytesTotal=0;
  const images=document.proofs.map(proof=>{
    if(!proofLocation.test(proof.url)||proof.url.includes('/../'))throw Error('Unapproved payment proof location.');
    const response=urlFetch.fetch(proof.url,{method:'get',followRedirects:false,muteHttpExceptions:true});
    if(response.getResponseCode()!==200)throw Error('Payment proof could not be retrieved.');
    const blob=response.getBlob(),mime=String(blob.getContentType()).split(';')[0].toLowerCase(),bytes=blob.getBytes();
    if(!['image/png','image/jpeg','image/webp','image/gif'].includes(mime)||!bytes.length||bytes.length>10*1024*1024)throw Error('Payment proof is not a supported bounded image.');
    const head=bytes.slice(0,12).map(b=>b&255),ascii=String.fromCharCode(...head);
    const matches=mime==='image/png'?head.slice(0,8).join(',')==='137,80,78,71,13,10,26,10':mime==='image/jpeg'?head.slice(0,3).join(',')==='255,216,255':mime==='image/gif'?/^GIF8[79]a/.test(ascii):ascii.startsWith('RIFF')&&ascii.slice(8,12)==='WEBP';
    if(!matches)throw Error('Payment proof bytes do not match the image type.');
    bytesTotal+=bytes.length;if(bytesTotal>12*1024*1024)throw Error('Combined payment proof images exceed the email limit.');
    return `data:${mime};base64,${utilities.base64Encode(bytes)}`;
  });
  const pdf=htmlService.createHtmlOutput(paymentDocumentHtml(document,images)).getAs('application/pdf');
  const bytes=pdf.getBytes();
  if(bytes.length<5||bytes.length>18*1024*1024||String.fromCharCode(...bytes.slice(0,5))!=='%PDF-')throw Error('Payment PDF conversion failed or exceeded the attachment limit.');
  return pdf.setName('VisionFlow-payment-record.pdf');
}
