const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {initializeTestEnvironment}=require('@firebase/rules-unit-testing');
const {doc,getDoc,setDoc,runTransaction,setLogLevel}=require('firebase/firestore');
const store=require('../site/store.js');

test('site transactions: concurrent administrators, conflicts and denied writes',{timeout:60000},async()=>{
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8088');
  setLogLevel('silent');
  const env=await initializeTestEnvironment({projectId:'demo-visionflow-site',firestore:{rules:readFileSync('firestore.rules','utf8')}});
  try{
    const claims={email:'shihabjessore7@gmail.com'},uid='m1PGSw7ViEb1xOJoj8INQllra3p1';
    const left=env.authenticatedContext(uid,claims).firestore(),right=env.authenticatedContext(uid,claims).firestore();
    const base={site:{agency:{name:'Before'},contact:{phone:'Before'}},portfolio:[{id:'one',title:'Before'}],meta:{revision:1,updatedAt:1}};
    await env.withSecurityRulesDisabled(async context=>{await setDoc(doc(context.firestore(),'site/main'),base);});
    let firstReads=0,release;const barrier=new Promise(resolve=>release=resolve);
    function transaction(db,synchronize=false){
      let first=true;
      return fn=>runTransaction(db,tx=>fn({
        get:async path=>{
          const snap=await tx.get(doc(db,path));
          if(synchronize&&first){first=false;if(++firstReads===2)release();await barrier;}
          return snap.exists()?snap.data():null;
        },set:(path,value)=>tx.set(doc(db,path),value)
      }));
    }
    const local=store.clone(base),remote=store.clone(base);local.site.agency.name='Left';remote.site.contact.phone='Right';
    await Promise.all([
      store.save({base,draft:local,transaction:transaction(left,true),now:()=>900}),
      store.save({base,draft:remote,transaction:transaction(right,true),now:()=>2})
    ]);
    const read=async()=>(await getDoc(doc(left,'site/main'))).data();
    let value=await read();assert.equal(value.site.agency.name,'Left');assert.equal(value.site.contact.phone,'Right');assert.equal(value.meta.revision,3);
    const a=store.clone(value),b=store.clone(value);a.portfolio[0].title='One';b.portfolio[0].title='Two';
    const results=await Promise.allSettled([
      store.save({base:value,draft:a,transaction:transaction(left)}),
      store.save({base:value,draft:b,transaction:transaction(right)})
    ]);
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(results.find(result=>result.status==='rejected').reason.code,'site/conflict');
    value=await read();assert.equal(value.meta.revision,4);assert.ok(['One','Two'].includes(value.portfolio[0].title));
    const client=env.authenticatedContext('client',{email:'client@example.invalid'}).firestore();
    await assert.rejects(store.save({base:value,draft:{...value,unauthorized:true},transaction:transaction(client)}),{code:'permission-denied'});
    assert.equal((await read()).unauthorized,undefined);
    await env.withSecurityRulesDisabled(async context=>{await setDoc(doc(context.firestore(),'portal_settings/recovery'),{active:true});});
    await assert.rejects(store.save({base:value,draft:{...value,locked:true},transaction:transaction(left)}),{code:'permission-denied'});
    assert.equal((await read()).locked,undefined);
  }finally{await env.cleanup();}
});
