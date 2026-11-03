/* A single foreground capture seeds a private page-world template. All other
 * profiles are read with fetch; only reviewed usernames enter the pool. */
async function parallelCall(tabId, method, args) {
  const rows = await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:(method,args)=>globalThis.ThreadsParallelRequest?.[method](args),args:[method,args ?? null]});
  return rows.length === 1 ? rows[0].result : null;
}
async function pauseParallel() {
  if (job?.parallelBatch && Number.isInteger(job.workerTabId)) {
    try { await parallelCall(job.workerTabId,'pause'); } catch {}
  }
}
async function runParallel() {
  const taskId = job.id;
  const authorized = () => job?.id === taskId && job.status === 'running';
  const deferred = () => ({status:'deferred',reason:'已暫停或中止；此帳號尚未送出。',evidence:{finalActionAttempted:false}});
  async function record(username,result) {
    await mutate(async()=>{
      if(job?.id !== taskId || !job.activeUsernames?.includes(username))return;
      job=Jobs.recordParallel(job,username,result,now());
      if(job.status !== 'running')await pauseParallel();
      await save();
    });
  }
  async function claim(limit,preferred) {
    let username=null;
    await mutate(async()=>{
      if(!authorized())return;
      const previous=new Set(job.activeUsernames||[]);
      job=Jobs.claimParallel(job,limit,now(),preferred);
      username=job.activeUsernames?.find(name=>!previous.has(name))||null;
      await save();
    });
    return username;
  }
  async function process(username) {
    let dispatched=false,result;
    try {
      if(!authorized())return await record(username,deferred());
      const prepared=await parallelCall(job.workerTabId,'prepare',{username});
      if(prepared?.deferred || !authorized())return await record(username,deferred());
      if(prepared?.ready!==true || prepared.username!==username || !/^[1-9][0-9]{0,29}$/.test(prepared.userId))throw new Error('無法核對帳號 ID：'+(prepared?.reason||'missing-result'));
      await assertSource(job);
      const actor=await readActor(job.sourceTabId);
      if(actor.toLowerCase()!==job.actorUsername.toLowerCase())throw new Error('登入帳號已變更。');
      if(!authorized())return await record(username,deferred());
      dispatched=true;
      const sent=await parallelCall(job.workerTabId,'submit',{username});
      if(sent?.attempted===false){dispatched=false;if(sent.deferred)return await record(username,deferred());throw new Error('請求未送出：'+(sent.reason||'unknown'));}
      const report=globalThis.ThreadsRequestProbeCore.cleanReport(sent?.report);
      const server=globalThis.ThreadsRequestProbeCore.blockEvidence(report,prepared.capture);
      const confirmed=sent?.attempted===true&&sent?.accepted===true&&server.confirmed&&server.requestUserId===prepared.userId;
      result={status:confirmed?'success':'unknown',reason:confirmed?'背景請求已確認此帳號封鎖成功。':'回應未確認同一帳號已封鎖；停止派發，不重送。',evidence:{backgroundParallel:true,identitySource:'profile-route-json',server,report}};
    } catch(error) { result={status:dispatched?'unknown':'needs-attention',reason:String(error.message)}; }
    await record(username,result);
  }
  async function setup(username) {
    let triggered=false,captured=false;
    try {
      await assertSource(job);
      if(!authorized())return await record(username,deferred());
      // Old templates never survive navigation/restart. One new calibration
      // profile is permitted per start/resume, never a per-target UI fallback.
      await closeWorker(job);
      if(!authorized())return await record(username,deferred());
      const tab=await chrome.tabs.create({url:'https://www.threads.com/@'+username,active:true});
      workerOwnership={tabId:tab.id,jobId:taskId};job.workerTabId=tab.id;job.phase='parallel-calibration';await save();
      if(!await waitForProfile(tab.id,username,taskId))return await record(username,deferred());
      await chrome.scripting.executeScript({target:{tabId:tab.id},files:['core.js','block-adapter.js']});
      const prepared=await adapter(tab.id,{username,actorUsername:job.actorUsername,phase:'prepare'});
      if(prepared.status==='deferred'&&prepared.evidence?.finalActionAttempted===false)return await record(username,deferred());
      if(prepared.status!=='prepared') {
        await record(username,['already-blocked','needs-attention','failed','unknown'].includes(prepared.status)?prepared:{status:'needs-attention',reason:'未取得準備結果。'});
        await mutate(async()=>{if(authorized()){job=Jobs.pause(job,now());job.reason='首次準備未取得封鎖請求；不會逐人開頁。請繼續以另一個待處理帳號準備。';await save();}});
        return;
      }
      await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',files:['request-probe-core.js','parallel-core.js','parallel-request.js','direct-request.js']});
      if((await directCall(tab.id,'arm',{username}))?.active!==true)throw new Error('無法準備請求範本。');
      if(!authorized())return await record(username,deferred());
      await assertSource(job);
      if(!authorized())return await record(username,deferred());
      triggered=true;
      const trigger=await adapter(tab.id,{username,actorUsername:job.actorUsername,phase:'capture',confirmationToken:prepared.confirmationToken});
      if(trigger.status!=='capture-triggered')throw new Error('無法攔截準備請求。');
      const deadline=Date.now()+6000;
      while(Date.now()<deadline) {
        const status=await directCall(tab.id,'status');
        if(status?.captured||status?.refused){job.directCapture=cleanDirectCapture(status.diagnostics);await save();}
        if(status?.refused)throw new Error('網站請求格式未通過核對；未重送。');
        if(status?.captured){captured=true;break;}
        if(!authorized())break;
        await wait(100);
      }
      if(!captured)throw new Error('未確認攔截成功，結果不明，不重送。');
      if(!authorized())return await record(username,deferred());
      const result=await directCall(tab.id,'handoffParallel',{accounts:job.items.map(row=>row.username),actorUsername:job.actorUsername,seedUsername:username});
      job.parallelCalibration={ready:result?.ready===true,reason:typeof result?.reason==='string'?result.reason.slice(0,80):'',checks:Object.fromEntries(Object.entries(result?.checks||{}).filter(([k,v])=>/^[A-Za-z]{1,30}$/.test(k)&&typeof v==='boolean'))};await save();
      if(!authorized()){await pauseParallel();return await record(username,deferred());}
      if(result?.ready!==true)throw new Error('背景身份核對失敗：'+(result?.reason||'missing-result'));
      job.parallelReady=true;job.phase='background-parallel';job.reason='最多 3 筆背景並行；無須保持工作分頁在前景。';await save();
      await chrome.tabs.update(job.sourceTabId,{active:true});
      await process(username);
    } catch(error) {await record(username,{status:triggered&&!captured?'unknown':'needs-attention',reason:error.message});}
    finally {
      if(!job.parallelReady&&Number.isInteger(job.workerTabId)){try{await directCall(job.workerTabId,'dispose');}catch{}await closeWorker(job);}
    }
  }
  try {
    let reusable=false;
    if(job.parallelReady&&workerOwnership?.jobId===taskId&&workerOwnership.tabId===job.workerTabId) {
      await assertSource(job);
      reusable=(await parallelCall(job.workerTabId,'resume'))?.ready===true;
    }
    if(!reusable) {
      job.parallelReady=false;
      const seed=await claim(1,job.parallelSeed);
      if(seed)await setup(seed);
      if(!job.parallelReady||!authorized())return;
    }
    const pool=new Set();
    while(authorized()||pool.size) {
      while(authorized()&&pool.size<3) {
        const username=await claim(3);
        if(!username)break;
        const task=process(username).finally(()=>pool.delete(task));pool.add(task);
      }
      if(pool.size)await Promise.race(pool);else break;
    }
  } catch(error) {
    await mutate(async()=>{if(job?.id===taskId){await pauseParallel();job=Jobs.recover(job,now());job.reason='背景工作中斷：'+error.message;await save();}});
  } finally {
    if(job?.id===taskId&&['completed','stopped'].includes(job.status)) {
      try{await directCall(job.workerTabId,'dispose');}catch{}
      await closeWorker(job);
    }
  }
}
