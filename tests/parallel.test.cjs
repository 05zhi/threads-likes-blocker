const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const Parallel=require('../extension/parallel-core.js'),Probe=require('../extension/request-probe-core.js'),Jobs=require('../extension/job.js');
const route=(name,id,actor='900',self=false)=>JSON.stringify({require:[['fixture',null,[{initialRouteInfo:{route:{tracePolicy:'barcelona.profilePage',url:'/@'+name,params:{vanity:'@'+name},actorID:actor,rootView:{props:{user_id:id,is_self_profile:self}},hostableView:{props:{user_id:id,is_self_profile:self}}}}}]]]});
const variables={user_id:'101',container_module:'fixture_profile',media_id:null,barcelona_source_quote_post_id:null,barcelona_source_reply_id:null,is_messaging_nua:null,consistent_thread_fbid:null,session_id:'PRIVATE_EXTRA'};
const body=()=>new URLSearchParams({fb_api_req_friendly_name:'useTHUserBlockMutation',doc_id:'12345',fb_dtsg:'PRIVATE_TOKEN',variables:JSON.stringify(variables)});
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{resolve,promise};};
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(options={}) {
 const calls=[],timers=[],ids={me:'900',alice:'101',bob:'102',carol:'103',dave:'104',eve:'105',...Object.fromEntries(Array.from({length:8},(_,i)=>['extra'+i,String(200+i)]))};
 const fetch=async(url,init)=>{
  const call={url,init};calls.push(call);
  if(init.method==='GET') {
   const name=new URL(url).pathname.slice(2);await options.get?.(name,call);
   return new Response(route(name,ids[name],options.actor?.()||'900',name==='me'),{status:200});
  }
  call.id=JSON.parse(init.body.get('variables')).user_id;
  await options.post?.(call);
  return new Response(JSON.stringify(options.response?.(call)||{data:{record:{user:{id:call.id,friendship_status:{blocking:true}}}}}),{status:options.httpStatus||200});
 };
 // DOM parsing is covered separately in the real Chromium fixture. These
 // tests isolate the asynchronous request lifecycle using real Response/fetch bodies.
 class Parser {parseFromString(text){return{querySelectorAll(){return[{textContent:text}]}};}}
 class XHR {open(){}setRequestHeader(){}send(){throw new Error('Original mutation escaped interception');}}
 const ctx=vm.createContext({URL,URLSearchParams,Headers,FormData,AbortController,TextDecoder,DOMParser:Parser,ThreadsRequestProbeCore:Probe,fetch,XMLHttpRequest:XHR,
  location:{href:'https://www.threads.com/@alice'},document:{visibilityState:'visible'},setTimeout(fn,ms){const t={fn,ms};timers.push(t);return t;},clearTimeout(t){if(t)t.cleared=true;}});
 for(const file of ['parallel-core.js','parallel-request.js','direct-request.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension',file),'utf8'),ctx);
 const api=ctx.ThreadsParallelRequest;
 async function start(){return api.start({candidate:{url:'https://www.threads.com/api/graphql',body:body(),headers:new Headers({'x-fb-lsd':'PRIVATE_HEADER'})},fetch,href:ctx.location.href,accounts:Object.keys(ids),actorUsername:'me',seedUsername:'alice'});}
 return{ctx,api,start,calls,timers,fetch};
}
test('route identity binds exact username, consistent profile views and actor',()=>{
 assert.equal(Parallel.profileFromScripts([route('alice','101')],'ALICE').userId,'101');
 assert.throws(()=>Parallel.profileFromScripts([route('other','101')],'alice'),/not-found/);
 assert.throws(()=>Parallel.profileFromScripts([route('alice','101'),route('alice','102')],'alice'),/ambiguous/);
 const conflicting=JSON.parse(route('alice','101'));conflicting.require[0][2][0].initialRouteInfo.route.hostableView.props.user_id='102';
 assert.throws(()=>Parallel.profileFromScripts([JSON.stringify(conflicting)],'alice'),/ambiguous/);
 assert.throws(()=>Parallel.profileFromScripts(['window.location="evil"',JSON.stringify({username:'alice',id:'101'})],'alice'),/not-found/);
 assert.throws(()=>Parallel.profileFromScripts([route('alice','0')],'alice'),/schema/);
});
test('retargeting changes only user_id and never mutates the template, including FormData',()=>{
 for(const original of [body(),body().toString(),new FormData()]){
  if(original instanceof FormData)for(const[k,v]of body())original.append(k,v);
  const changed=Parallel.copyBody(Parallel.forUser(original,'102'));
  assert.deepEqual(JSON.parse(changed.get('variables')),{...variables,user_id:'102'});
  assert.equal(changed.get('fb_dtsg'),'PRIVATE_TOKEN');assert.equal(JSON.parse(Parallel.copyBody(original).get('variables')).user_id,'101');
 }
});
test('template handoff intercepts original XHR once and never exports secret request material',async()=>{
 const f=fixture();const direct=f.ctx.ThreadsDirectRequest;direct.arm({username:'alice'});
 const xhr=new f.ctx.XMLHttpRequest();xhr.open('POST','https://www.threads.com/api/graphql');xhr.send(body());
 assert.equal(direct.status().captured,true);
 const result=await direct.handoffParallel({accounts:['alice','bob'],actorUsername:'me',seedUsername:'alice'});
 assert.equal(result.ready,true);assert.equal(result.concurrency,2);assert.equal(f.calls.filter(c=>c.init.method==='POST').length,0);
 assert.equal((await direct.submit()).attempted,false);assert.equal((await direct.handoffParallel({})).ready,false);
 await f.api.prepare({username:'bob'});const sent=await f.api.submit({username:'bob'});
 assert.equal(sent.accepted,true);assert.equal(JSON.stringify([result,sent,direct.status()]).includes('PRIVATE'),false);
 direct.dispose();assert.equal(f.api.status().ready,false);
});
test('every approved account can submit concurrently; duplicates and unselected accounts cannot',async()=>{
 const hold=gate(),f=fixture({post:()=>hold.promise});assert.equal((await f.start()).concurrency,13);
 f.ctx.document.visibilityState='hidden';
 const names=['alice','bob','carol','dave','eve',...Array.from({length:8},(_,i)=>'extra'+i)];
 for(const username of names)assert.equal((await f.api.prepare({username})).ready,true);
 const pending=names.map(username=>f.api.submit({username}));
 assert.equal(f.calls.filter(c=>c.init.method==='POST').length,13);assert.equal(f.api.status().active,13);
 for(const username of ['alice','unselected','me'])assert.equal((await f.api.submit({username})).attempted,false);
 f.api.pause();hold.resolve();assert.ok((await Promise.all(pending)).every(r=>r.accepted));
 assert.equal(f.api.status().enabled,false);assert.equal(f.ctx.location.href,'https://www.threads.com/@alice');f.api.dispose();
});
test('pause during lookup never sends; explicit resume revalidates actor and preserves eligibility',async()=>{
 const hold=gate(),f=fixture({get:name=>name==='bob'?hold.promise:null});await f.start();
 const pending=f.api.prepare({username:'bob'});await tick();f.api.pause();hold.resolve();
 assert.equal((await pending).deferred,true);assert.equal((await f.api.submit({username:'bob'})).attempted,false);
 assert.equal((await f.api.resume()).ready,true);assert.equal((await f.api.prepare({username:'bob'})).ready,true);
 assert.equal((await f.api.submit({username:'bob'})).accepted,true);f.api.dispose();
});
test('in-flight outcomes complete after pause while new requests stay disabled',async()=>{
 const hold=gate(),f=fixture({post:()=>hold.promise});await f.start();await f.api.prepare({username:'alice'});await f.api.prepare({username:'bob'});
 const pending=f.api.submit({username:'alice'});f.api.pause();assert.equal((await f.api.submit({username:'bob'})).attempted,false);
 hold.resolve();assert.equal((await pending).accepted,true);assert.equal(f.api.status().enabled,false);f.api.dispose();
});
test('a newer pause or dispose wins over an outstanding resume identity read',async()=>{
 for(const change of ['pause','dispose']){
  let hold=null;const f=fixture({get:name=>name==='me'?hold?.promise:null});await f.start();f.api.pause();hold=gate();
  const pending=f.api.resume();await tick();f.api[change]();hold.resolve();assert.equal((await pending).ready,false);assert.equal(f.api.status().enabled,false);f.api.dispose();
 }
});
test('wrong response IDs, GraphQL errors and rate limiting stop new sends without retries',async()=>{
 for(const options of [{response:()=>({data:{record:{user:{id:'999',friendship_status:{blocking:true}}}}})},{response:()=>({errors:[{message:'PRIVATE_SERVER'}]})},{httpStatus:429}]){
  const f=fixture(options);await f.start();await f.api.prepare({username:'alice'});
  const result=await f.api.submit({username:'alice'});assert.equal(result.accepted,false);assert.equal(f.api.status().enabled,false);
  await f.api.resume();assert.equal((await f.api.prepare({username:'alice'})).ready,false);
  assert.equal(f.calls.filter(c=>c.init.method==='POST').length,1);assert.equal(JSON.stringify(result).includes('PRIVATE'),false);f.api.dispose();
 }
});
test('actor changes, self accounts, unknown names, expired context and navigation cannot dispatch',async()=>{
 let actor='900';const f=fixture({actor:()=>actor});await f.start();
 for(const username of ['me','unselected'])assert.equal((await f.api.prepare({username})).ready,false);
 actor='901';assert.equal((await f.api.prepare({username:'bob'})).ready,false);assert.equal((await f.api.resume()).ready,false);
 f.api.dispose();actor='900';await f.start();f.ctx.location.href='https://www.threads.com/@other';assert.equal((await f.api.submit({username:'alice'})).attempted,false);
 assert.equal(f.calls.filter(c=>c.init.method==='POST').length,0);f.api.dispose();
});
test('anonymous calibration and wrong captured user IDs are rejected before any POST',async()=>{
 const f=fixture({actor:()=>'0'});const result=await f.start();assert.equal(result.ready,false);assert.equal(result.checks.authenticatedActor,false);assert.equal(f.calls.filter(c=>c.init.method==='POST').length,0);
});
const newJob=()=>Jobs.createJob({actorUsername:'me',sourceTabId:7,target:{url:'https://www.threads.com/@author/post/TEST'},accounts:['alice','bob','carol','dave'].map(username=>({username,profileUrl:'https://www.threads.com/@'+username}))});
test('parallel job respects a smaller requested limit of three, accepts out-of-order results, and finishes only after all settle',()=>{
 let job=newJob();for(let i=0;i<4;i++)job=Jobs.claimParallel(job,3);
 assert.deepEqual(job.activeUsernames,['alice','bob','carol']);
 job=Jobs.recordParallel(job,'bob',{status:'success'});job=Jobs.claimParallel(job,3);
 assert.deepEqual(job.activeUsernames,['alice','carol','dave']);
 for(const name of ['dave','alice'])job=Jobs.recordParallel(job,name,{status:'success'});
 assert.equal(job.status,'running');job=Jobs.recordParallel(job,'carol',{status:'success'});assert.equal(job.status,'completed');
});
test('parallel stop cancels waiting items, accepts every late result, and recovery never retries active accounts',()=>{
 let job=newJob();for(let i=0;i<3;i++)job=Jobs.claimParallel(job);
 const stopped=Jobs.stop(job);assert.deepEqual(stopped.items.map(r=>r.status),['unknown','unknown','unknown','cancelled']);
 let late=Jobs.recordParallel(stopped,'bob',{status:'success'});late=Jobs.recordParallel(late,'alice',{status:'unknown'});late=Jobs.recordParallel(late,'carol',{status:'deferred',evidence:{finalActionAttempted:false}});
 assert.equal(late.status,'stopped');assert.equal(late.current,null);assert.equal(late.items[2].status,'cancelled');
 const recovered=Jobs.recover(job);assert.equal(recovered.status,'paused');assert.deepEqual(recovered.activeUsernames,[]);assert.equal(Jobs.claimParallel(Jobs.resume(recovered)).current,'dave');
});
