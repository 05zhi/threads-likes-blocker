'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const Jobs=require('../extension/job.js');
const dir=path.join(__dirname,'../extension');
const source=fs.readFileSync(path.join(dir,'background.js'),'utf8');
const JOB_KEY='threadsBlocker.job.v1';
const target={url:'https://www.threads.com/@author/post/TEST',kind:'post'};
const account=username=>({username,profileUrl:`https://www.threads.com/@${username}`});
const initial=()=>({type:'BLOCK_START',confirmed:true,target,accounts:[account('alice'),account('bob')],actorUsername:'me',includeAuthor:false});
const sender={tab:{id:7,url:target.url},url:target.url};
const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const gate=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return{promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate,label){for(let i=0;i<150;i++){if(predicate())return;await tick();}throw new Error('Timed out waiting for '+label);}

function harness(options={}) {
  const calls=[],tabs=new Map([[7,{id:7,url:target.url,status:'complete'}]]),store=options.saved?{[JOB_KEY]:clone(options.saved)}:{};
  for(const tab of options.tabs||[])tabs.set(tab.id,clone(tab));
  const listeners={};let workerId=100;
  const context=vm.createContext({URL,crypto:require('node:crypto').webcrypto,setTimeout:fn=>setImmediate(fn),clearTimeout:clearImmediate,console,
    chrome:{
      storage:{local:{async get(key){return{[key]:clone(store[key])};},async set(value){Object.assign(store,clone(value));calls.push({kind:'save',job:clone(value[JOB_KEY])});}}},
      runtime:{onMessage:{addListener(fn){listeners.message=fn;}}},
      action:{onClicked:{addListener(fn){listeners.action=fn;}},async setBadgeText(){},async setTitle(){}},
      tabs:{
        onRemoved:{addListener(fn){listeners.removed=fn;}},onUpdated:{addListener(fn){listeners.updated=fn;}},
        async create(value){const tab={id:workerId++,url:value.url,status:'complete'};tabs.set(tab.id,tab);calls.push({kind:'create',...value,id:tab.id});return clone(tab);},
        async get(id){calls.push({kind:'get',id});if(!tabs.has(id))throw new Error('Tab not found');return clone(tabs.get(id));},
        async update(id,value){if(!tabs.has(id))throw new Error('Tab not found');Object.assign(tabs.get(id),value,{status:'complete'});calls.push({kind:'navigate',id,...value});return clone(tabs.get(id));},
        async remove(id){tabs.delete(id);calls.push({kind:'remove',id});listeners.removed?.(id);}
      },
      scripting:{async executeScript(value){
        if(value.files){calls.push({kind:'inject',tabId:value.target.tabId,files:Array.from(value.files)});return[];}
        const args=value.args?.[0];
        if(args&&typeof args==='object'&&args.phase){
          const call={kind:'adapter',tabId:value.target.tabId,...clone(args)};calls.push(call);
          if(options.adapter)return options.adapter(args,call,calls);
          return[{result:args.phase==='prepare'?{status:'prepared',confirmationToken:'mock-token'}:{status:'success'}}];
        }
        if(String(value.func).includes('readableActorFromNavigation')){
          calls.push({kind:'read-actor',tabId:value.target.tabId});
          if(options.actorRead)return options.actorRead(tabs,calls);
          return[{result:options.actorUsername===undefined?'me':options.actorUsername}];
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
  assert.equal((await h.message({type:'BLOCK_RESUME',actorUsername:'me'},{tab:{id:7,url:target.url}})).ok,false);
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
  assert.equal((await h.message({type:'BLOCK_RESUME',actorUsername:'someone_else'})).ok,false);
  assert.equal((await h.message({type:'BLOCK_RESUME',actorUsername:'me'})).ok,true);
  await until(()=>h.job().status==='completed','resumed completion');assert.deepEqual(h.phases(),['prepare','prepare','confirm']);
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
  const response=await h.message({type:'BLOCK_RESUME',actorUsername:'me'});assert.equal(response.ok,true);
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
  assert.equal((await h.message({type:'BLOCK_RESUME',actorUsername:'me'},{tab:{id:7,url:'https://www.threads.com/@AUTHOR/post/test'}})).ok,false);
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
