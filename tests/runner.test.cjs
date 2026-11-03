'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const Jobs=require('../extension/job.js');
const Probe=require('../extension/request-probe-core.js');
const directReport=(id='123456')=>({records:[{transport:'fetch',request:Probe.describeRequest({url:'https://www.threads.com/api/graphql',method:'POST',body:JSON.stringify({fb_api_req_friendly_name:'useTHUserBlockMutation',doc_id:'12345',variables:{user_id:id}})}),response:{status:200,json:true,fields:Probe.fields({data:{record:{user:{id,friendship_status:{blocking:true}}}}})}}]});
const dir=path.join(__dirname,'../extension');
const source=fs.readFileSync(path.join(dir,'background.js'),'utf8');
const JOB_KEY='threadsBlocker.job.v1';
const target={url:'https://www.threads.com/@author/post/TEST',kind:'post'};
const account=username=>({username,profileUrl:`https://www.threads.com/@${username}`});
const panelIdentity={panelVersion:'0.6.3',extensionId:'fixture-extension'};
const initial=()=>({...panelIdentity,type:'BLOCK_START',confirmed:true,target,accounts:[account('alice'),account('bob')],actorUsername:'me',includeAuthor:false});
const sender={tab:{id:7,url:target.url},url:target.url};
const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const gate=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return{promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const parallelNames=['alice','bob','carol','dave','eve',...Array.from({length:7},(_,i)=>'extra'+i)];
const parallelInitial=()=>({...initial(),parallelBatch:true,accounts:parallelNames.map(account)});
const parallelResult=(method,args)=>method==='prepare'?{ready:true,username:args.username,userId:'123456',capture:directReport()}:method==='submit'?{attempted:true,accepted:true,report:directReport()}:{ready:true};
async function until(predicate,label){for(let i=0;i<150;i++){if(predicate())return;await tick();}throw new Error('Timed out waiting for '+label);}

test('parallel mode calibrates one profile then dispatches every remaining selected target without navigation',async()=>{
 const hold=gate(),h=harness({parallel:async(method,args)=>{if(method==='submit'&&args.username!=='alice')await hold.promise;return parallelResult(method,args);}});
 await h.ready;assert.equal((await h.message(parallelInitial())).ok,true);
 await until(()=>h.calls.filter(c=>c.kind==='parallel-submit').length===12,'all selected targets after seed');
 assert.deepEqual(h.job().activeUsernames,parallelNames.slice(1));assert.equal(h.calls.filter(c=>c.kind==='create').length,1);
 assert.equal(h.calls.filter(c=>c.kind==='navigate'&&c.url).length,0);
 assert.deepEqual(h.calls.filter(c=>c.kind==='navigate').map(c=>c.id),[7]);
 h.tabs.get(100).active=false;h.listeners.activated({tabId:7});await tick();await tick();assert.equal(h.job().status,'running');
 hold.resolve();await until(()=>h.job().status==='completed','parallel completion');
 assert.deepEqual(h.calls.filter(c=>c.kind==='parallel-submit').map(c=>c.username),parallelNames);
 assert.equal(h.job().items.every(r=>r.status==='success'),true);assert.deepEqual(h.phases(),['prepare','capture']);
});
test('parallel pause stops dispatch, retains late results and resumes without another profile page',async()=>{
 const hold=gate(),h=harness({parallel:async(method,args)=>{if((method==='submit'&&args.username!=='alice')||(method==='prepare'&&args.username===parallelNames.at(-1)))await hold.promise;return parallelResult(method,args);}});
 await h.ready;await h.message(parallelInitial());await until(()=>h.calls.filter(c=>c.kind==='parallel-submit').length===11,'active pool');
 await h.message({type:'BLOCK_PAUSE'});hold.resolve();await until(()=>h.job().current===null,'pool settles');
 assert.equal(h.job().status,'paused');assert.equal(h.job().items[11].status,'pending');assert.equal(h.job().items.slice(0,11).every(r=>r.status==='success'),true);
 await until(()=>vm.runInContext('runner === null',h.context),'runner finishes');
 assert.equal((await h.message({...panelIdentity,type:'BLOCK_RESUME',jobId:h.job().id,actorUsername:'me'})).ok,true);
 await until(()=>h.job().status==='completed','resumed pool');assert.equal(h.calls.filter(c=>c.kind==='create').length,1);assert.equal(h.calls.filter(c=>c.kind==='direct-handoffParallel').length,1);
});
test('parallel stop cancels pending and prepared accounts but records already submitted outcomes',async()=>{
 const hold=gate(),h=harness({parallel:async(method,args)=>{if(method==='submit'&&args.username==='bob')await hold.promise;if(method==='prepare'&&args.username!=='alice'&&args.username!=='bob')await hold.promise;return parallelResult(method,args);}});
 await h.ready;await h.message(parallelInitial());await until(()=>h.calls.some(c=>c.kind==='parallel-prepare'&&c.username==='dave'),'pool prepared');
 await h.message({type:'BLOCK_STOP'});hold.resolve();await until(()=>h.job().current===null,'stopped pool settles');
 assert.equal(h.job().status,'stopped');assert.deepEqual(h.calls.filter(c=>c.kind==='parallel-submit').map(c=>c.username),['alice','bob']);
 assert.deepEqual(h.job().items.map(r=>r.status),['success','success',...Array(10).fill('cancelled')]);
});
test('parallel seed failure prevents pool dispatch and never falls back to per-user pages',async()=>{
 const h=harness({parallel:(method,args)=>method==='submit'?{attempted:true,accepted:true,report:directReport('999999')}:parallelResult(method,args)});
 await h.ready;await h.message(parallelInitial());await until(()=>h.job().status==='paused','seed response rejected');
 assert.equal(h.job().items[0].status,'unknown');assert.equal(h.calls.filter(c=>c.kind==='parallel-submit').length,1);assert.equal(h.calls.filter(c=>c.kind==='create').length,1);
});
test('stopping a fully dispatched selected list records every in-flight result',async()=>{
 const hold=gate(),h=harness({parallel:async(method,args)=>{if(method==='submit'&&args.username!=='alice')await hold.promise;return parallelResult(method,args);}});
 await h.ready;await h.message(parallelInitial());await until(()=>h.calls.filter(c=>c.kind==='parallel-submit').length===12,'entire selected list');
 assert.equal(h.job().concurrency,12);await h.message({type:'BLOCK_STOP'});
 assert.equal(h.job().items.filter(r=>r.status==='unknown').length,11);
 hold.resolve();await until(()=>h.job().current===null,'all remaining results');
 assert.equal(h.job().status,'stopped');assert.equal(h.job().items.filter(r=>r.status==='success').length,12);
 assert.equal(h.calls.filter(c=>c.kind==='parallel-submit').length,12);
});
test('parallel calibration failure and already-blocked seed stop without blocking other accounts',async()=>{
 for(const already of [true,false]) {
  const h=harness(already?{adapter:()=>[{result:{status:'already-blocked'}}]}:{direct:method=>method==='arm'?{active:true}:method==='status'?{captured:true,diagnostics:{report:directReport()}}:{ready:false,reason:'identity-calibration',checks:{actorMatches:false}}});
  await h.ready;await h.message(parallelInitial());await until(()=>h.job().status==='paused','calibration pause');
  assert.equal(h.calls.some(c=>c.kind==='parallel-submit'),false);assert.equal(h.calls.filter(c=>c.kind==='create').length,1);
 }
});
test('parallel source or actor change after lookup prevents POST even without tab events',async()=>{
 for(const change of ['source','actor']) {
  let h;h=harness({parallel:(method,args)=>{if(method==='prepare'&&args.username==='alice'&&change==='source')h.tabs.get(7).url='https://www.threads.com/@author/post/OTHER';return parallelResult(method,args);},actorUsername:change==='actor'?'other':'me'});
  await h.ready;await h.message(parallelInitial());await until(()=>h.job().status==='paused','identity pause');assert.equal(h.calls.some(c=>c.kind==='parallel-submit'),false);
 }
});

function harness(options={}) {
  const calls=[],tabs=new Map([[7,{id:7,url:target.url,status:'complete'}]]),store=options.saved?{[JOB_KEY]:clone(options.saved)}:{};
  for(const tab of options.tabs||[])tabs.set(tab.id,clone(tab));
  const listeners={};let workerId=100,freshChecks=0;
  const context=vm.createContext({URL,crypto:require('node:crypto').webcrypto,setTimeout:(fn,ms)=>{calls.push({kind:'wait',ms});return setImmediate(fn);},clearTimeout:clearImmediate,console,
    chrome:{
      storage:{local:{async get(key){return{[key]:clone(store[key])};},async set(value){Object.assign(store,clone(value));calls.push({kind:'save',job:clone(value[JOB_KEY])});}}},
      runtime:{id:'fixture-extension',getManifest(){return{version:options.runtimeVersion===undefined?'0.6.3':options.runtimeVersion}},onMessage:{addListener(fn){listeners.message=fn;}}},
      action:{onClicked:{addListener(fn){listeners.action=fn;}},async setBadgeText(){},async setTitle(){}},
      tabs:{
        onRemoved:{addListener(fn){listeners.removed=fn;}},onUpdated:{addListener(fn){listeners.updated=fn;}},onActivated:{addListener(fn){listeners.activated=fn;}},
        async create(value){const tab={id:workerId++,url:value.url,active:value.active,status:'complete'};tabs.set(tab.id,tab);calls.push({kind:'create',...value,id:tab.id});return clone(tab);},
        async get(id){calls.push({kind:'get',id});if(!tabs.has(id))throw new Error('Tab not found');return clone(tabs.get(id));},
        async update(id,value){if(!tabs.has(id))throw new Error('Tab not found');Object.assign(tabs.get(id),value,{status:'complete'});calls.push({kind:'navigate',id,...value});return clone(tabs.get(id));},
        async reload(id,value){calls.push({kind:'reload',id,...value});if(!options.staleDocument)delete context.__threadsDirectDocumentToken;},
        async remove(id){tabs.delete(id);calls.push({kind:'remove',id});listeners.removed?.(id);}
      },
      scripting:{async executeScript(value){
        if(value.files){calls.push({kind:'inject',tabId:value.target.tabId,files:Array.from(value.files)});return[];}
        if(value.world==='MAIN'){
          if(String(value.func).includes('ThreadsParallelRequest')) {
            const [method,args]=value.args;calls.push({kind:'parallel-'+method,...clone(args)});
            if(options.parallel)return[{result:await options.parallel(method,args,calls)}];
            const id=args?.username==='alice'?'123456':'234567';
            return[{result:method==='prepare'?{ready:true,username:args.username,userId:id,capture:directReport(id)}:method==='submit'?{attempted:true,accepted:true,report:directReport(id)}:{ready:true}}];
          }
          if(String(value.func).includes('ThreadsDirectRequest')) {
            const method=value.args[0];calls.push({kind:'direct-'+method});
            if(options.direct)return[{result:await options.direct(method,calls)}];
            if(method==='handoffParallel')return[{result:{ready:true}}];
            const id=tabs.get(value.target.tabId).url.endsWith('/@bob')?'234567':tabs.get(value.target.tabId).url.endsWith('/@author')?'345678':'123456';
            return[{result:method==='arm'?{active:true}:method==='status'?{captured:true,diagnostics:{report:directReport(id)}}:method==='submit'?{attempted:true,accepted:true,report:directReport(id)}:null}];
          }
          if(String(value.func).includes('.begin()')){calls.push({kind:'probe-begin'});if(options.failProbe)throw new Error('probe failed');return[{result:{active:true}}];}
          calls.push({kind:'probe-finish'});return[{result:{records:[],directRequestVerified:true,secret:'MUST_NOT_PERSIST'}}];
        }
        const args=value.args?.[0];
        if(args&&typeof args==='object'&&args.phase){
          const call={kind:'adapter',tabId:value.target.tabId,...clone(args)};calls.push(call);
          if(options.adapter)return options.adapter(args,call,calls);
          return[{result:args.phase==='prepare'?{status:'prepared',confirmationToken:'mock-token'}:args.phase==='capture'?{status:'capture-triggered'}:{status:'success'}}];
        }
        if(String(value.func).includes('readableActorFromNavigation')){
          calls.push({kind:'read-actor',tabId:value.target.tabId});
          if(options.actorRead)return options.actorRead(tabs,calls);
          return[{result:options.actorUsername===undefined?'me':options.actorUsername}];
        }
        if(String(value.func).includes('__threadsDirectDocumentToken')) {
          if(String(value.func).includes('document.readyState')) {calls.push({kind:'fresh-document-check'});return[{result:!options.staleDocument&&++freshChecks>(options.staleChecks||0)}];}
          context.__threadsDirectDocumentToken=value.args[0];return[];
        }
        value.func?.(...(value.args||[]));return[];
      }}
    }
  });
  context.importScripts=(...files)=>files.forEach(file=>vm.runInContext(fs.readFileSync(path.join(dir,file),'utf8'),context,{filename:file}));
  vm.runInContext(source,context,{filename:'background.js'});
  const ready=vm.runInContext('ready',context);
  function message(value,from=sender){return new Promise((resolve,reject)=>{const kept=listeners.message(value,clone(from),resolve);if(kept!==true)reject(new Error('Message not handled'));});}
  return{context,calls,tabs,store,listeners,ready,message,job:()=>clone(vm.runInContext('job',context)),phases:()=>calls.filter(c=>c.kind==='adapter').map(c=>c.phase)};
}

test('GET exposes background build, runtime and extension identity without requiring a current panel',async()=>{
  const h=harness();await h.ready;
  const response=await h.message({type:'BLOCK_GET'});
  assert.equal(response.ok,true);assert.equal(response.job,null);assert.equal(response.buildVersion,'0.6.3');assert.equal(response.runtimeVersion,'0.6.3');assert.equal(response.extensionId,'fixture-extension');
  assert.equal(h.calls.some(c=>['create','navigate','inject','adapter','save'].includes(c.kind)),false);
});

test('legacy, stale and wrong-extension panels cannot start or resume blocking',async()=>{
  const legacy=initial();delete legacy.panelVersion;delete legacy.extensionId;
  const cases=[legacy,{...initial(),panelVersion:'0.3.0'},{...initial(),extensionId:'another-extension'}];
  for(const payload of cases){
    const start=harness();await start.ready;
    const response=await start.message(payload);assert.equal(response.ok,false);assert.match(response.error,/版本|來源/);assert.equal(start.job(),null);
    assert.equal(start.calls.some(c=>['create','navigate','inject','adapter','save'].includes(c.kind)),false);
    const saved=Jobs.pause(Jobs.createJob({...initial(),sourceTabId:7},'2026-11-03T00:00:00.000Z'),'2026-11-03T00:00:01.000Z');
    const resume=harness({saved});await resume.ready;const before=resume.job();resume.calls.length=0;
    const resumed=await resume.message({...payload,type:'BLOCK_RESUME',jobId:resume.job().id});assert.equal(resumed.ok,false);assert.match(resumed.error,/版本|來源/);assert.deepEqual(resume.job(),before);
    assert.equal(resume.calls.some(c=>['create','navigate','inject','adapter','save'].includes(c.kind)),false);
  }
});

test('mixed background and runtime builds refuse dispatch while legacy pause, stop and GET stay available',async()=>{
  const saved=Jobs.pause(Jobs.createJob({...initial(),sourceTabId:7},'2026-11-03T00:00:00.000Z'),'2026-11-03T00:00:01.000Z');
  const h=harness({runtimeVersion:'0.3.0',saved});await h.ready;h.calls.length=0;
  const report=await h.message({type:'BLOCK_GET'});assert.equal(report.buildVersion,'0.6.3');assert.equal(report.runtimeVersion,'0.3.0');
  for(const type of ['BLOCK_START','BLOCK_RESUME']){
    const response=await h.message({...initial(),type});assert.equal(response.ok,false);assert.match(response.error,/背景程式版本 0\.6\.3 與套件版本 0\.3\.0/);
  }
  assert.equal(h.calls.some(c=>['create','navigate','inject','adapter','save'].includes(c.kind)),false);
  assert.equal((await h.message({type:'BLOCK_PAUSE'})).ok,true);assert.equal((await h.message({type:'BLOCK_STOP'})).ok,true);assert.equal(h.job().status,'stopped');
});

test('actor detection reads only the sending Threads tab without starting a blocking job',async()=>{
  const h=harness({actorUsername:'me.123'});await h.ready;
  const response=await h.message({type:'BLOCK_ACTOR'});
  assert.equal(response.ok,true);assert.equal(response.actorUsername,'me.123');assert.equal(h.job(),null);
  assert.deepEqual(h.calls.filter(c=>c.kind==='inject').map(c=>c.files),[['block-adapter.js']]);
  assert.deepEqual(h.calls.filter(c=>c.kind==='read-actor').map(c=>c.tabId),[7]);
  assert.equal(h.calls.some(c=>['create','navigate','adapter','save'].includes(c.kind)),false);
});

test('actor detection rejects missing identities, non-Threads tabs and page changes',async()=>{
  for(const actorUsername of [null,'','@me','bad user']){
    const h=harness({actorUsername});await h.ready;assert.equal((await h.message({type:'BLOCK_ACTOR'})).ok,false);assert.equal(h.job(),null);
  }
  const h=harness();await h.ready;h.tabs.set(7,{id:7,url:'https://example.com/'});
  assert.equal((await h.message({type:'BLOCK_ACTOR'})).ok,false);assert.equal(h.calls.some(c=>c.kind==='inject'),false);
  const changed=harness({actorRead(tabs){tabs.get(7).url='https://www.threads.com/search?q=changed';return[{result:'me'}];}});await changed.ready;
  assert.equal((await changed.message({type:'BLOCK_ACTOR'})).ok,false);assert.equal(changed.job(),null);
});

test('START requires explicit confirmation, a Threads sender and the current target',async()=>{
  const h=harness();await h.ready;
  for(const confirmed of [undefined,false,'true'])assert.equal((await h.message({...initial(),confirmed})).ok,false);
  assert.equal((await h.message(initial(),{tab:{id:7,url:'https://evil.example/'}})).ok,false);
  assert.equal((await h.message(initial(),{tab:{id:7,url:'https://www.threads.com/@author/post/OTHER'}})).ok,false);
  assert.equal((await h.message({...initial(),target:{url:'https://www.threads.com/@else/post/TEST'}})).ok,false);
  assert.equal(h.calls.some(c=>c.kind==='create'),false);
});
test('START treats post IDs as case-sensitive even when usernames differ only by case',async()=>{
  const h=harness();await h.ready;
  const result=await h.message({...initial(),target:{url:'https://www.threads.com/@AUTHOR/post/test'}});
  assert.equal(result.ok,false);assert.equal(h.calls.some(c=>c.kind==='create'),false);
});

test('an explicitly selected post card can run from the confirmed feed without a typed permalink',async()=>{
  const h=harness();await h.ready;
  const feed={tab:{id:7,url:'https://www.threads.com/'}};
  h.tabs.set(7,{...feed.tab,status:'complete'});
  const result=await h.message({...initial(),accounts:[account('alice')],target:{...target,binding:'user-confirmed',sourcePage:'https://www.threads.com/'}},feed);
  assert.equal(result.ok,true);assert.equal(result.job.sourcePage,'https://www.threads.com/');
  await until(()=>h.job().status==='completed','feed-bound completion');assert.deepEqual(h.phases(),['prepare','confirm']);
});

test('feed selection binding cannot come from another page or a non-Threads origin',async()=>{
  const h=harness();await h.ready;const feed={tab:{id:7,url:'https://www.threads.com/'}};
  for(const sourcePage of ['https://evil.example/','https://www.threads.com/search']){
    assert.equal((await h.message({...initial(),target:{...target,binding:'user-confirmed',sourcePage}},feed)).ok,false);
  }
  assert.equal((await h.message({...initial(),target:{...target,sourcePage:'https://www.threads.com/'}},feed)).ok,false);
  assert.equal(h.calls.some(c=>c.kind==='create'),false);
});

test('feed-bound jobs pause on source navigation and require their original page to resume',async()=>{
  const prepare=gate(),h=harness({adapter:()=>prepare.promise});await h.ready;
  const feed={tab:{id:7,url:'https://www.threads.com/'}};h.tabs.set(7,{...feed.tab,status:'complete'});
  await h.message({...initial(),target:{...target,binding:'user-confirmed',sourcePage:feed.tab.url}},feed);
  await until(()=>h.phases().includes('prepare'),'feed preparation');
  h.listeners.updated(7,{url:'https://www.threads.com/search'});await until(()=>h.job().status==='paused','feed navigation pause');
  prepare.resolve([{result:{status:'prepared',confirmationToken:'p'}}]);await until(()=>h.job().current===null,'feed deferral');assert.deepEqual(h.phases(),['prepare']);
  assert.equal((await h.message({...panelIdentity,type:'BLOCK_RESUME',jobId:h.job().id,actorUsername:'me'},{tab:{id:7,url:target.url}})).ok,false);
  await h.message({type:'BLOCK_STOP'},feed);
});

test('search query changes invalidate card bindings while tracking parameters do not',async()=>{
  const prepare=gate(),h=harness({adapter:()=>prepare.promise});await h.ready;
  const search={tab:{id:7,url:'https://www.threads.com/search?q=one&xmt=share'}};
  h.tabs.set(7,{...search.tab,status:'complete'});
  assert.equal((await h.message({...initial(),target:{...target,binding:'user-confirmed',sourcePage:'https://threads.net/search?q=two'}},search)).ok,false);
  assert.equal((await h.message({...initial(),target:{...target,binding:'user-confirmed',sourcePage:'https://www.threads.com/search?q=one'}},search)).ok,true);
  await until(()=>h.phases().includes('prepare'),'search preparation');
  h.listeners.updated(7,{url:'https://www.threads.com/search?q=one&xmt=other'});await tick();await tick();assert.equal(h.job().status,'running');
  h.listeners.updated(7,{url:'https://www.threads.com/search?q=two'});await until(()=>h.job().status==='paused','semantic query pause');
  prepare.resolve([{result:{status:'prepared',confirmationToken:'p'}}]);await until(()=>h.job().current===null,'query deferral');assert.deepEqual(h.phases(),['prepare']);
  await h.message({type:'BLOCK_STOP'},search);
});
test('runner prepares before confirming and processes a selected account once',async()=>{
  const h=harness();await h.ready;assert.equal((await h.message({...initial(),accounts:[account('alice')]})).ok,true);
  await until(()=>h.job()?.status==='completed','completion');
  assert.deepEqual(h.phases(),['prepare','confirm']);assert.equal(h.job().items[0].status,'success');assert.equal(h.job().items[0].attempts,1);
  assert.equal(h.calls.find(c=>c.kind==='adapter'&&c.phase==='confirm').confirmationToken,'mock-token');
  for(const key of ['extensionVersion','buildVersion','runtimeVersion','clientPanelVersion'])assert.equal(h.job()[key],'0.6.3');assert.equal(h.job().extensionId,'fixture-extension');
  await until(()=>h.calls.some(c=>c.kind==='remove'),'worker cleanup');assert.equal(h.job().workerTabId,null);
});
test('only one job can run or remain paused at a time',async()=>{
  const prepare=gate(),h=harness({adapter:args=>args.phase==='prepare'?prepare.promise:Promise.resolve([{result:{status:'success'}}])});await h.ready;
  assert.equal((await h.message(initial())).ok,true);await until(()=>h.phases().includes('prepare'),'prepare');
  const id=h.job().id;assert.equal((await h.message(initial())).ok,false);assert.equal(h.job().id,id);
  await h.message({type:'BLOCK_PAUSE'});assert.equal((await h.message(initial())).ok,false);
  prepare.resolve([{result:{status:'prepared',confirmationToken:'p'}}]);await until(()=>h.job().current===null,'preparation settlement');await h.message({type:'BLOCK_STOP'});
});
test('pause while prepare is pending prevents confirm and leaves the account pending for explicit resume',async()=>{
  const prepare=gate();let prepares=0;
  const h=harness({adapter:args=>{
    if(args.phase==='prepare'&&++prepares===1)return prepare.promise;
    return Promise.resolve([{result:args.phase==='prepare'?{status:'prepared',confirmationToken:'p'}:{status:'success'}}]);
  }});await h.ready;await h.message({...initial(),accounts:[account('alice')]});await until(()=>h.phases().includes('prepare'),'prepare');
  const paused=await h.message({type:'BLOCK_PAUSE'});assert.equal(paused.ok,true);assert.equal(paused.job.status,'paused');assert.equal(paused.job.current,'alice');prepare.resolve([{result:{status:'prepared',confirmationToken:'p'}}]);
  await until(()=>h.job().status==='paused'&&h.job().current===null,'safe deferral');
  assert.deepEqual(h.phases(),['prepare']);assert.equal(h.job().items[0].status,'pending');assert.equal(h.job().items[0].attempts,0);
  assert.equal((await h.message({...panelIdentity,type:'BLOCK_RESUME',jobId:h.job().id,actorUsername:'someone_else'})).ok,false);
  assert.equal((await h.message({...panelIdentity,type:'BLOCK_RESUME',jobId:h.job().id,actorUsername:'me'})).ok,true);
  await until(()=>h.job().status==='completed','resumed completion');assert.deepEqual(h.phases(),['prepare','prepare','confirm']);
});
test('a delayed resume for a replaced job cannot resume the new job on the same source and actor',async()=>{
  const saved=Jobs.pause(Jobs.createJob({...initial(),sourceTabId:7},'2026-11-03T00:00:00.000Z'),'2026-11-03T00:00:01.000Z');
  const prepare=gate(),h=harness({saved,adapter:args=>args.phase==='prepare'?prepare.promise:Promise.resolve([{result:{status:'success'}}])});await h.ready;
  const oldJobId=h.job().id;await h.message({type:'BLOCK_STOP'});
  assert.equal((await h.message({...initial(),accounts:[account('bob')]})).ok,true);const newJobId=h.job().id;assert.notEqual(newJobId,oldJobId);
  await until(()=>h.phases().includes('prepare'),'replacement job preparation');await h.message({type:'BLOCK_PAUSE'});
  prepare.resolve([{result:{status:'prepared',confirmationToken:'p'}}]);await until(()=>h.job().status==='paused'&&h.job().current===null,'replacement job deferral');
  const before=h.job(),callCount=h.calls.length;
  for(const jobId of [undefined,oldJobId]){
    const response=await h.message({...panelIdentity,type:'BLOCK_RESUME',actorUsername:'me',jobId});assert.equal(response.ok,false);assert.match(response.error,/工作已變更/);assert.deepEqual(h.job(),before);
  }
  assert.equal(h.calls.slice(callCount).some(c=>['create','navigate','inject','adapter','save'].includes(c.kind)),false);assert.deepEqual(h.phases(),['prepare']);
  assert.equal((await h.message({...panelIdentity,type:'BLOCK_RESUME',actorUsername:'me',jobId:newJobId})).ok,true);
  await until(()=>h.job().status==='completed','correct replacement job completion');assert.deepEqual(h.phases(),['prepare','prepare','confirm']);
});

test('stop after confirmation was submitted cancels pending accounts and accepts the in-flight outcome',async()=>{
  const confirm=gate(),h=harness({adapter:args=>args.phase==='prepare'?Promise.resolve([{result:{status:'prepared',confirmationToken:'p'}}]):confirm.promise});await h.ready;await h.message(initial());await until(()=>h.phases().includes('confirm'),'confirm');
  const stopped=await h.message({type:'BLOCK_STOP'});assert.equal(stopped.ok,true);assert.equal(stopped.job.status,'stopped');assert.equal(stopped.job.current,'alice');assert.equal(stopped.job.items[1].status,'cancelled');assert.equal(h.job().status,'stopped');assert.equal(h.job().items[0].status,'unknown');assert.equal(h.job().items[1].status,'cancelled');
  confirm.resolve([{result:{status:'success'}}]);await until(()=>h.job().current===null,'late result');
  assert.equal(h.job().status,'stopped');assert.equal(h.job().items[0].status,'success');assert.deepEqual(h.phases(),['prepare','confirm']);
});
test('worker closure pauses the job and preserves unknown outcome rather than retrying',async()=>{
  const confirm=gate(),h=harness({adapter:args=>args.phase==='prepare'?Promise.resolve([{result:{status:'prepared',confirmationToken:'p'}}]):confirm.promise});await h.ready;await h.message(initial());await until(()=>h.phases().includes('confirm'),'confirm');
  const worker=h.job().workerTabId;h.tabs.delete(worker);h.listeners.removed(worker);
  await until(()=>h.job().status==='paused'&&h.job().current===null,'worker closure recovery');assert.equal(h.job().workerTabId,null);assert.equal(h.job().items[0].status,'unknown');
  confirm.resolve([{result:{status:'success'}}]);await tick();await tick();assert.equal(h.job().items[0].status,'unknown');assert.deepEqual(h.phases(),['prepare','confirm']);
  await h.message({type:'BLOCK_STOP'});
});
test('startup recovery never creates a worker or resumes an interrupted action automatically',async()=>{
  const saved=Jobs.nextItem(Jobs.createJob({...initial(),sourceTabId:7},'2026-11-02T06:00:00.000Z'),'2026-11-02T06:00:01.000Z');saved.workerTabId=100;
  const h=harness({saved});await h.ready;await tick();
  assert.equal(h.job().status,'paused');assert.equal(h.job().current,null);assert.equal(h.job().items[0].status,'unknown');assert.equal(h.job().items[1].status,'pending');assert.equal(h.calls.some(c=>['adapter','create','navigate'].includes(c.kind)),false);
});
test('recovered saved worker IDs never read, navigate, inject or close an unrelated existing tab',async()=>{
  const saved=Jobs.nextItem(Jobs.createJob({...initial(),sourceTabId:7},'2026-11-02T06:00:00.000Z'),'2026-11-02T06:00:01.000Z');saved.workerTabId=55;
  const unrelated={id:55,url:'https://example.com/private-work',status:'complete'};
  const h=harness({saved,tabs:[unrelated]});await h.ready;
  assert.equal(h.job().workerTabId,null);assert.equal(h.job().status,'paused');assert.deepEqual(h.tabs.get(55),unrelated);
  const response=await h.message({...panelIdentity,type:'BLOCK_RESUME',jobId:h.job().id,actorUsername:'me'});assert.equal(response.ok,true);
  await until(()=>h.job().status==='completed','recovered job completion');await until(()=>h.calls.some(c=>c.kind==='remove'),'owned worker cleanup');
  assert.ok(h.calls.some(c=>c.kind==='create'&&c.id!==55));assert.equal(h.calls.some(c=>c.id===55||c.tabId===55),false);assert.deepEqual(h.tabs.get(55),unrelated);
});
test('stopping a recovered job cannot close its saved old worker ID',async()=>{
  const saved=Jobs.createJob({...initial(),sourceTabId:7},'2026-11-02T06:00:00.000Z');saved.workerTabId=55;
  const h=harness({saved,tabs:[{id:55,url:'https://www.threads.com/@alice',status:'complete'}]});await h.ready;
  const result=await h.message({type:'BLOCK_STOP'});assert.equal(result.ok,true);assert.equal(result.job.status,'stopped');await tick();
  assert.equal(h.calls.some(c=>c.id===55||c.tabId===55),false);assert.ok(h.tabs.has(55));
});
test('an error after the final confirmation dispatch becomes unknown and pauses without retries',async()=>{
  const h=harness({adapter:async args=>{if(args.phase==='prepare')return[{result:{status:'prepared',confirmationToken:'p'}}];throw new Error('connection lost');}});await h.ready;await h.message(initial());
  await until(()=>h.job().status==='paused'&&h.job().current===null,'unknown result');assert.equal(h.job().items[0].status,'unknown');assert.match(h.job().items[0].reason,/connection lost/);assert.equal(h.job().items[1].status,'pending');assert.deepEqual(h.phases(),['prepare','confirm']);await h.message({type:'BLOCK_STOP'});
});
test('an error before final confirmation or unrecognized adapter result stops before confirming',async()=>{
  for(const adapter of [async()=>{throw new Error('prepare failed');},async()=>[{result:{status:'unexpected'}}]]){
    const h=harness({adapter});await h.ready;await h.message(initial());await until(()=>h.job().status==='paused'&&h.job().current===null,'preparation failure');assert.equal(h.job().items[0].status,'needs-attention');assert.deepEqual(h.phases(),['prepare']);await h.message({type:'BLOCK_STOP'});
  }
});
test('source navigation away pauses the current job before a pending prepare can confirm',async()=>{
  const prepare=gate(),h=harness({adapter:()=>prepare.promise});await h.ready;await h.message(initial());await until(()=>h.phases().includes('prepare'),'prepare');h.listeners.updated(7,{url:'https://www.threads.com/@author/post/OTHER'});
  await until(()=>h.job().status==='paused','source navigation');prepare.resolve([{result:{status:'prepared',confirmationToken:'p'}}]);await until(()=>h.job().current===null,'navigation deferral');assert.deepEqual(h.phases(),['prepare']);assert.equal(h.job().items[0].status,'pending');await h.message({type:'BLOCK_STOP'});
});
test('source navigation allows username case changes but pauses on a post ID case change',async()=>{
  const prepare=gate(),h=harness({adapter:()=>prepare.promise});await h.ready;await h.message(initial());await until(()=>h.phases().includes('prepare'),'prepare');
  h.listeners.updated(7,{url:'https://www.threads.com/@AUTHOR/post/TEST'});await tick();await tick();assert.equal(h.job().status,'running');
  h.listeners.updated(7,{url:'https://www.threads.com/@author/post/test'});await until(()=>h.job().status==='paused','case-sensitive source pause');
  prepare.resolve([{result:{status:'prepared',confirmationToken:'p'}}]);await until(()=>h.job().current===null,'case navigation deferral');assert.deepEqual(h.phases(),['prepare']);assert.equal(h.job().items[0].status,'pending');
  assert.equal((await h.message({...panelIdentity,type:'BLOCK_RESUME',jobId:h.job().id,actorUsername:'me'},{tab:{id:7,url:'https://www.threads.com/@AUTHOR/post/test'}})).ok,false);
  await h.message({type:'BLOCK_STOP'});
});
test('a closed source tab is rechecked after prepare even when its removed event is missed',async()=>{
  const prepare=gate(),h=harness({adapter:()=>prepare.promise});await h.ready;await h.message(initial());await until(()=>h.phases().includes('prepare'),'prepare');
  h.tabs.delete(7); // Intentionally do not deliver tabs.onRemoved.
  prepare.resolve([{result:{status:'prepared',confirmationToken:'p'}}]);
  await until(()=>h.job().status==='paused'&&h.job().current===null,'missed source removal detection');
  assert.deepEqual(h.phases(),['prepare']);assert.equal(h.job().items[0].status,'needs-attention');assert.equal(h.job().items[1].status,'pending');assert.match(h.job().items[0].reason,/尚未送出最後確認/);
  await h.message({type:'BLOCK_STOP'},{tab:{id:8,url:target.url}});
});
test('a changed source URL is rechecked after prepare even when its updated event is missed',async()=>{
  const prepare=gate(),h=harness({adapter:()=>prepare.promise});await h.ready;await h.message(initial());await until(()=>h.phases().includes('prepare'),'prepare');
  h.tabs.set(7,{id:7,url:'https://www.threads.com/@author/post/OTHER',status:'complete'}); // No tabs.onUpdated.
  prepare.resolve([{result:{status:'prepared',confirmationToken:'p'}}]);
  await until(()=>h.job().status==='paused'&&h.job().current===null,'missed source navigation detection');
  assert.deepEqual(h.phases(),['prepare']);assert.equal(h.job().items[0].status,'needs-attention');assert.equal(h.job().items[1].status,'pending');assert.match(h.job().items[0].reason,/來源分頁/);
  await h.message({type:'BLOCK_STOP'});
});


test('worker starts in foreground; a visibility deferral retains the account until explicit resume',async()=>{
  let deferred=false;
  const h=harness({adapter:async args=>{
    if(!deferred){deferred=true;return[{result:{status:'deferred',reason:'Background tab',evidence:{finalActionAttempted:false}}}];}
    return[{result:args.phase==='prepare'?{status:'prepared',confirmationToken:'t'}:{status:'success'}}];
  }});await h.ready;await h.message({...initial(),accounts:[account('alice')]});
  await until(()=>h.job().status==='paused'&&h.job().current===null,'visibility deferral');
  assert.equal(h.calls.find(c=>c.kind==='create').active,true);
  assert.equal(h.job().items[0].status,'pending');assert.equal(h.job().items[0].attempts,0);
  h.tabs.get(h.job().workerTabId).active=false;
  await tick();await h.message({...panelIdentity,type:'BLOCK_RESUME',jobId:h.job().id,actorUsername:'me'});
  await until(()=>h.job().status==='completed','foreground resume');
  assert.equal(h.calls.find(c=>c.kind==='navigate').active,true);
  assert.deepEqual(h.phases(),['prepare','prepare','confirm']);
});

test('switching away while preparing pauses without confirming and without taking focus back',async()=>{
  const prepared=gate(),h=harness({adapter:()=>prepared.promise});await h.ready;await h.message(initial());
  await until(()=>h.phases().includes('prepare'),'preparation');
  h.tabs.get(h.job().workerTabId).active=false;h.listeners.activated({tabId:7});
  await until(()=>h.job().status==='paused','tab switch pause');
  prepared.resolve([{result:{status:'prepared',confirmationToken:'t'}}]);
  await until(()=>h.job().current===null,'deferral');
  assert.equal(h.job().items[0].status,'pending');assert.deepEqual(h.phases(),['prepare']);
  assert.equal(h.calls.some(c=>c.kind==='navigate'),false);
});

test('a confirmation-phase deferral must explicitly attest that final action was not attempted',async()=>{
  for(const evidence of [{finalActionAttempted:false},{finalActionAttempted:true},{}]){
    const h=harness({adapter:async args=>[{result:args.phase==='prepare'?{status:'prepared',confirmationToken:'t'}:{status:'deferred',evidence}}]});
    await h.ready;await h.message(initial());await until(()=>h.job().status==='paused'&&h.job().current===null,'confirmation outcome');
    assert.equal(h.job().items[0].status,evidence.finalActionAttempted===false?'pending':'unknown');
    assert.deepEqual(h.phases(),['prepare','confirm']);
  }
});


test('request probe requires exactly one confirmed target before creating a job or worker',async()=>{
  for(const payload of [{...initial(),probeRequest:true},{...initial(),probeRequest:'yes'}, {...initial(),accounts:[account('alice')],probeRequest:true,confirmed:false}]){
    const h=harness();await h.ready;const result=await h.message(payload);
    assert.equal(result.ok,false);assert.equal(h.job(),null);assert.equal(h.calls.some(c=>c.kind==='create'),false);
  }
});

test('a single-target UI probe captures diagnostics without enabling direct requests',async()=>{
  const h=harness();await h.ready;await h.message({...initial(),accounts:[account('alice')],probeRequest:true});
  await until(()=>h.job().status==='completed','probe completion');
  assert.deepEqual(h.phases(),['prepare','confirm']);assert.equal(h.job().executionMode,'ui-request-probe');
  assert.equal(h.calls.filter(c=>c.kind==='probe-begin').length,1);assert.equal(h.calls.filter(c=>c.kind==='probe-finish').length,1);
  assert.equal(h.job().requestProbe.directRequestVerified,false);assert.equal(h.job().requestProbe.scopeVerified,false);
  assert.equal(JSON.stringify(h.store).includes('MUST_NOT_PERSIST'),false);
});

test('normal jobs do not install request observers',async()=>{
  const h=harness();await h.ready;await h.message({...initial(),accounts:[account('alice')]});
  await until(()=>h.job().status==='completed','normal completion');
  assert.equal(h.calls.some(c=>c.kind==='probe-begin'),false);assert.equal(h.calls.some(c=>c.files?.includes('request-probe.js')),false);
  assert.equal(h.calls.some(c=>c.files?.includes('direct-request.js')),false);
});

const directStart=()=>({...initial(),accounts:[account('alice')],directRequestTest:true});
test('direct batch processes reviewed likers and author with exact response IDs and only one initial reload',async()=>{
  const h=harness();await h.ready;await h.message({...initial(),accounts:[account('alice'),account('bob'),account('me')],includeAuthor:true,directBatch:true});
  await until(()=>h.job().status==='completed','batch completion');
  assert.equal(h.job().executionMode,'direct-batch');assert.deepEqual(h.job().items.map(a=>a.username),['alice','bob','author']);
  assert.ok(h.job().items.every(a=>a.status==='success'&&a.evidence.server.confirmed));assert.equal(h.calls.filter(c=>c.kind==='direct-submit').length,3);
  assert.equal(h.calls.filter(c=>c.kind==='reload').length,1);assert.deepEqual(h.job().items.map(a=>a.evidence.verifiedAfterReload),[true,false,false]);
  assert.deepEqual(h.job().items.map(a=>a.evidence.server.responseUserId),['123456','234567','345678']);
  assert.ok(h.calls.some(c=>c.kind==='wait'&&c.ms===1000));
});
test('batch mode cannot bypass confirmation or mix with single-account experiments',async()=>{
  for(const changes of [{confirmed:false},{directRequestTest:true},{probeRequest:true},{directBatch:'yes'}]) {
    const h=harness();await h.ready;assert.equal((await h.message({...initial(),directBatch:true,...changes})).ok,false);assert.equal(h.job(),null);
  }
});
test('a failed first reload stops the batch before preparing the second account',async()=>{
  const h=harness({adapter:async args=>[{result:args.phase==='prepare'?{status:'prepared',confirmationToken:'t'}:args.phase==='capture'?{status:'capture-triggered'}:{status:'unknown'}}]});
  await h.ready;await h.message({...initial(),directBatch:true});await until(()=>h.job().status==='paused'&&h.job().current===null,'failed first verification');
  assert.equal(h.job().items[0].status,'unknown');assert.equal(h.job().items[1].status,'pending');assert.equal(h.job().directBatchValidated,false);
  assert.equal(h.calls.filter(c=>c.kind==='direct-submit').length,1);
});
test('later batch HTTP failures or mismatched IDs stop remaining accounts without retry',async()=>{
  for(const failure of ['wrong-id','rate-limit']) {
    let count=0;
    const h=harness({direct:method=>{
      if(method==='arm')return{active:true};if(method==='status')return{captured:true,diagnostics:{report:directReport()}};
      if(method==='submit') { count++;const report=directReport();if(count===2) {if(failure==='wrong-id')report.records[0].response.fields=Probe.fields({data:{record:{user:{id:'999999',friendship_status:{blocking:true}}}}});else report.records[0].response.status=429;}return{attempted:true,accepted:true,report}; }
      return null;
    }});
    await h.ready;await h.message({...initial(),accounts:[account('alice'),account('bob'),account('charlie')],directBatch:true});
    await until(()=>h.job().status==='paused'&&h.job().current===null,'batch response failure');
    assert.deepEqual(h.job().items.map(a=>a.status),['success','unknown','pending']);assert.equal(count,2);
  }
});
test('pausing the next held batch request sends nothing and resume repeats the reload check',async()=>{
  let captured=0;const held=gate();
  const h=harness({direct:method=>method==='arm'?{active:true}:method==='status'?(++captured===2?held.promise:{captured:true,diagnostics:{report:directReport()}}):method==='submit'?{attempted:true,accepted:true,report:directReport()}:null});
  await h.ready;await h.message({...initial(),directBatch:true});await until(()=>captured===2,'second capture');await h.message({type:'BLOCK_PAUSE'});
  held.resolve({captured:true,diagnostics:{report:directReport()}});await until(()=>h.job().current===null,'paused held request');
  assert.deepEqual(h.job().items.map(a=>a.status),['success','pending']);assert.equal(h.calls.filter(c=>c.kind==='direct-submit').length,1);
  await h.message({...panelIdentity,type:'BLOCK_RESUME',jobId:h.job().id,actorUsername:'me'});await until(()=>h.job().status==='completed','resumed batch');
  assert.equal(h.calls.filter(c=>c.kind==='direct-submit').length,2);assert.equal(h.job().items[1].evidence.verifiedAfterReload,true);
});
test('stopping a held batch request cancels remaining accounts without another submission',async()=>{
  let captured=0;const held=gate();
  const h=harness({direct:method=>method==='arm'?{active:true}:method==='status'?(++captured===2?held.promise:{captured:true,diagnostics:{report:directReport()}}):method==='submit'?{attempted:true,accepted:true,report:directReport()}:null});
  await h.ready;await h.message({...initial(),accounts:[account('alice'),account('bob'),account('charlie')],directBatch:true});await until(()=>captured===2,'second held request');await h.message({type:'BLOCK_STOP'});
  held.resolve({captured:true,diagnostics:{report:directReport()}});await until(()=>h.job().current===null,'stopped batch');
  assert.deepEqual(h.job().items.map(a=>a.status),['success','skipped','cancelled']);assert.equal(h.calls.filter(c=>c.kind==='direct-submit').length,1);
});
test('a recovered batch never trusts a previous browser session reload validation',async()=>{
  const saved={...Jobs.createJob({...initial(),sourceTabId:7},'2026-11-03T00:00:00.000Z'),directBatch:true,directBatchValidated:true};
  const h=harness({saved});await h.ready;assert.equal(h.job().directBatchValidated,false);
  await h.message({...panelIdentity,type:'BLOCK_RESUME',jobId:h.job().id,actorUsername:'me'});await until(()=>h.job().status==='completed','recovered batch');
  assert.equal(h.calls.filter(c=>c.kind==='reload').length,1);assert.equal(h.job().items[0].evidence.verifiedAfterReload,true);
});
test('direct verification requires one confirmed target and excludes simultaneous observer mode',async()=>{
  for(const payload of [{...initial(),directRequestTest:true},{...directStart(),confirmed:false},{...directStart(),probeRequest:true},{...directStart(),directRequestTest:'yes'}]) {
    const h=harness();await h.ready;assert.equal((await h.message(payload)).ok,false);assert.equal(h.job(),null);assert.equal(h.calls.some(c=>c.kind==='create'),false);
  }
});
test('direct verification requires capture, one submit, a fresh document, and read-only state verification',async()=>{
  const h=harness({staleChecks:2});await h.ready;await h.message(directStart());await until(()=>h.job().status==='completed','direct completion');
  assert.deepEqual(h.phases(),['prepare','capture','verify']);assert.equal(h.calls.filter(c=>c.kind==='direct-submit').length,1);
  assert.ok(h.calls.find(c=>c.kind==='reload'&&c.bypassCache));assert.equal(h.job().directRequest.verifiedAfterReload,true);
  assert.equal(h.calls.filter(c=>c.kind==='fresh-document-check').length,3);
  assert.equal(h.job().items[0].status,'success');assert.equal(h.job().executionMode,'single-direct-verification');
});
test('pause or stop after capture disposes the held request without sending it',async()=>{
  for(const type of ['BLOCK_PAUSE','BLOCK_STOP']) {
    const capture=gate(),h=harness({direct:async method=>method==='arm'?{active:true}:method==='status'?capture.promise:null});
    await h.ready;await h.message(directStart());await until(()=>h.calls.some(c=>c.kind==='direct-status'),'capture status');
    await h.message({type});capture.resolve({captured:true});await until(()=>h.job().current===null,'held cleanup');
    assert.equal(h.calls.some(c=>c.kind==='direct-submit'),false);assert.ok(h.calls.some(c=>c.kind==='direct-dispose'));
    assert.equal(h.job().items[0].status,type==='BLOCK_PAUSE'?'pending':'skipped');
  }
});
test('unrecognized capture never dispatches a direct request and exports only sanitized refusal diagnostics',async()=>{
  const h=harness({direct:method=>method==='arm'?{active:true}:method==='status'?{refused:true,diagnostics:{bodyFormat:'formdata',candidateCount:1,checks:{bodyEncoding:false,secret:'PRIVATE_TOKEN'},rawBody:'PRIVATE_BODY',report:{cookies:'PRIVATE_COOKIE'}}}:null});
  await h.ready;await h.message(directStart());await until(()=>h.job().status==='paused'&&h.job().current===null,'refused capture');
  assert.equal(h.calls.some(c=>c.kind==='direct-submit'),false);assert.equal(h.job().items[0].status,'needs-attention');
  assert.equal(h.job().directCapture.bodyFormat,'formdata');assert.equal(h.job().directCapture.checks.bodyEncoding,false);assert.match(h.job().items[0].reason,/bodyEncoding/);
  assert.equal(JSON.stringify(h.job()).includes('PRIVATE'),false);assert.equal(Object.hasOwn(h.job().directCapture.checks,'secret'),false);
});
test('HTTP acceptance without reloaded unblock evidence cannot report direct success or replay',async()=>{
  const h=harness({adapter:async args=>[{result:args.phase==='prepare'?{status:'prepared',confirmationToken:'t'}:args.phase==='capture'?{status:'capture-triggered'}:{status:'unknown'}}]});
  await h.ready;await h.message(directStart());await until(()=>h.job().status==='paused'&&h.job().current===null,'verification failure');
  assert.equal(h.job().items[0].status,'unknown');assert.equal(h.job().directRequest.verifiedAfterReload,false);assert.equal(h.calls.filter(c=>c.kind==='direct-submit').length,1);
});
test('pause after a direct submission retains unknown status and never dispatches another request',async()=>{
  const submitted=gate(),h=harness({direct:method=>method==='arm'?{active:true}:method==='status'?{captured:true}:method==='submit'?submitted.promise:null});
  await h.ready;await h.message(directStart());await until(()=>h.calls.some(c=>c.kind==='direct-submit'),'direct dispatch');
  await h.message({type:'BLOCK_PAUSE'});submitted.resolve({attempted:true,accepted:true,report:{records:[]}});
  await until(()=>h.job().current===null,'paused direct result');assert.equal(h.job().items[0].status,'unknown');assert.equal(h.job().directRequest.verifiedAfterReload,false);
  assert.equal(h.calls.filter(c=>c.kind==='direct-submit').length,1);
});

test('observer startup failure stops a probe before any UI block action',async()=>{
  const h=harness({failProbe:true});await h.ready;await h.message({...initial(),accounts:[account('alice')],probeRequest:true});
  await until(()=>h.job().status==='paused'&&h.job().current===null,'probe failure');assert.deepEqual(h.phases(),[]);
  assert.equal(h.job().items[0].status,'needs-attention');
});

test('pause and stop during a probe clean up observation and never submit the final confirmation',async()=>{
  for(const type of ['BLOCK_PAUSE','BLOCK_STOP']){
    const prepare=gate(),h=harness({adapter:()=>prepare.promise});await h.ready;await h.message({...initial(),accounts:[account('alice')],probeRequest:true});
    await until(()=>h.phases().includes('prepare'),'probe preparation');await h.message({type});
    prepare.resolve([{result:{status:'prepared',confirmationToken:'t'}}]);
    await until(()=>h.calls.some(c=>c.kind==='probe-finish'),'observer cleanup');
    assert.deepEqual(h.phases(),['prepare']);assert.equal(h.job().status,type==='BLOCK_PAUSE'?'paused':'stopped');
  }
});
