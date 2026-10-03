import {sameRecord} from './data.js?v=20261003-a1';

export function paymentCents(value) {
  if(!['number','string'].includes(typeof value)||!/^\d+(?:\.\d{1,2})?$/.test(String(value)))return null;
  const cents=Math.round(Number(value)*100);
  return Number.isSafeInteger(cents)&&cents>=0?cents:null;
}

export function paymentMoney(cents) {
  return Number.isSafeInteger(cents)&&cents>=0?`BDT ${(cents/100).toFixed(2)}`:'Not available - review the record';
}

// Store only the changed records, not whichever payment happens to sort last.
export function paymentChanges(before=[],after=[]) {
  const valid=rows=>rows.every(p=>typeof p?.id==='string'&&p.id.length>0)&&new Set(rows.map(p=>p.id)).size===rows.length;
  if(!valid(before)||!valid(after))return {identified:false,count:0,items:[]};
  const summary=p=>({id:p.id,amount:paymentCents(p.amount),date:String(p.date||'').slice(0,10),type:String(p.type||'').slice(0,80)});
  const old=new Map(before.map(p=>[p.id,p])),current=new Map(after.map(p=>[p.id,p])),items=[];
  for(const p of after){const prior=old.get(p.id);if(!prior||!sameRecord(prior,p))items.push({kind:prior?'updated':'added',before:prior?summary(prior):null,after:summary(p)});}
  for(const p of before)if(!current.has(p.id))items.push({kind:'removed',before:summary(p),after:null});
  return {identified:true,count:items.length,items:items.slice(0,20)};
}

export function paymentTotals(project={}) {
  const rows=Array.isArray(project.payments)?project.payments:[];
  let paid=0;
  for(const p of rows){const amount=paymentCents(p?.amount);if(amount===null||!Number.isSafeInteger(paid+amount)){paid=null;break;}paid+=amount;}
  const budget=paymentCents(project.budget),balance=budget!==null&&paid!==null?budget-paid:null;
  return {paid,budget,balance,credit:balance!==null&&balance<0};
}
