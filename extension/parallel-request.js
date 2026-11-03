(function(root){
  'use strict';
  if(root.ThreadsParallelRequest?.version===2)return;
  root.ThreadsParallelRequest?.dispose();
  const Core=root.ThreadsRequestProbeCore,Parallel=root.ThreadsParallelCore;
  let state=null;
  const allowedName=name=>typeof name==='string'&&/^[A-Za-z0-9._]{1,30}$/.test(name);
  async function limitedText(response,max) {
    if(Number(response.headers.get('content-length'))>max)throw new Error('response-size');
    if(!response.body?.getReader){const text=await response.text();if(text.length>max)throw new Error('response-size');return text;}
    const reader=response.body.getReader(),decoder=new TextDecoder();let text='',size=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max)throw new Error('response-size');text+=decoder.decode(value,{stream:true});}return text+decoder.decode();}
    finally{await reader.cancel().catch(()=>{});}
  }
  const valid=s=>!!s&&state===s&&!s.closed&&Date.now()<s.expiresAt&&root.location.href===s.href;
  async function profile(s,username) {
    const controller=new root.AbortController(),timer=root.setTimeout(()=>controller.abort(),20000);
    try {
      const url='https://www.threads.com/@'+username;
      const response=await s.fetch.call(root,url,{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});
      if(response.status!==200)throw new Error('profile-http-'+response.status);
      if(response.url&&new URL(response.url).href!==url)throw new Error('profile-redirect');
      return Parallel.profileFromHTML(await limitedText(response,8*1024*1024),username);
    } finally {root.clearTimeout(timer);}
  }
  async function start({candidate,fetch,href,accounts,actorUsername,seedUsername}) {
    if(state&&!state.closed)throw new Error('parallel-active');
    if(!allowedName(actorUsername)||!allowedName(seedUsername)||!Array.isArray(accounts)||accounts.length>10000||!accounts.every(allowedName))throw new Error('parallel-input');
    const names=new Set(accounts.map(name=>name.toLowerCase()));names.delete(actorUsername.toLowerCase());
    if(!names.has(seedUsername.toLowerCase()))throw new Error('seed-not-selected');
    const s=state={candidate:{...candidate,body:Parallel.copyBody(candidate.body),headers:new Headers(candidate.headers)},fetch,href,actorUsername,seedUsername,names,enabled:false,closed:false,
      expiresAt:Date.now()+600000,cache:new Map(),sent:new Set(),sentIds:new Set(),active:0,actorId:null,epoch:0};
    s.timer=root.setTimeout(dispose,600000);
    try {
      const actor=await profile(s,actorUsername),seed=await profile(s,seedUsername);
      const variables=JSON.parse(s.candidate.body.get('variables'));
      const checks={actorSelf:actor.isSelf,authenticatedActor:actor.actorId!=='0',seedNotSelf:!seed.isSelf,actorMatches:seed.actorId===actor.actorId,differentUsers:seed.userId!==actor.userId,seedIdMatches:String(variables.user_id)===seed.userId};
      if(!Object.values(checks).every(Boolean)){dispose();return{ready:false,reason:'identity-calibration',checks};}
      if(!valid(s)||s.epoch!==0)return{ready:false,reason:'calibration-interrupted'};
      s.actorId=actor.actorId;s.actorUserId=actor.userId;
      s.cache.set(seedUsername.toLowerCase(),{...seed,expiresAt:Date.now()+30000});s.enabled=true;
      return {ready:true,seedUsername,seedUserId:seed.userId,actorMatches:true,identitySource:'profile-route-json',concurrency:10};
    } catch(error){dispose();return{ready:false,reason:String(error.message).replace(/[^A-Za-z0-9_-]/g,'').slice(0,80)};}
  }
  async function prepare({username}) {
    const s=state,epoch=s?.epoch;
    if(!valid(s)||!s.enabled)return{ready:false,deferred:true,reason:'parallel-not-ready'};
    if(!allowedName(username)||!s.names.has(username.toLowerCase())||s.sent.has(username.toLowerCase()))return{ready:false,reason:'target-not-eligible'};
    try {
      let target=s.cache.get(username.toLowerCase());if(!target||target.expiresAt<Date.now())target=await profile(s,username);
      if(!valid(s)||!s.enabled||s.epoch!==epoch)return{ready:false,deferred:true,reason:'parallel-paused'};
      if(target.actorId!==s.actorId||target.isSelf||target.userId===s.actorUserId)throw new Error('actor-or-self-mismatch');
      target={...target,expiresAt:Date.now()+30000};s.cache.set(username.toLowerCase(),target);
      const body=Parallel.forUser(s.candidate.body,target.userId);
      const description=Core.describeRequest({url:s.candidate.url,method:'POST',body:Object.fromEntries(Parallel.copyBody(body)),operationHeader:s.candidate.headers.get('x-fb-friendly-name')});
      return{ready:true,username,userId:target.userId,identitySource:'profile-route-json',capture:Core.cleanReport({records:[{transport:'fetch',request:description,response:{status:null,json:false,fields:[]}}]})};
    }catch(error){s.enabled=false;return{ready:false,reason:String(error.message).replace(/[^A-Za-z0-9_-]/g,'').slice(0,80)};}
  }
  async function submit({username}) {
    const s=state,key=String(username).toLowerCase(),target=s?.cache.get(key);
    if(!valid(s)||!s.enabled)return{attempted:false,deferred:true,reason:'parallel-paused'};
    if(!s.names.has(key)||s.sent.has(key)||!target||s.sentIds.has(target.userId)||target.expiresAt<Date.now()||s.active>=10)return{attempted:false,reason:'target-not-prepared'};
    const body=Parallel.forUser(s.candidate.body,target.userId),request=Core.describeRequest({url:s.candidate.url,method:'POST',body:Object.fromEntries(Parallel.copyBody(body))});
    s.sent.add(key);s.sentIds.add(target.userId);s.cache.delete(key);s.active++;
    const capture=Core.cleanReport({records:[{transport:'fetch',request,response:{status:null,json:false,fields:[]}}]});
    const record={transport:'fetch',request,response:{status:null,json:false,fields:[]}},controller=new root.AbortController(),timer=root.setTimeout(()=>controller.abort(),20000);
    let confirmed=false;
    try {
      const response=await s.fetch.call(root,s.candidate.url,{method:'POST',body,headers:new Headers(s.candidate.headers),credentials:'same-origin',redirect:'error',signal:controller.signal});
      const json=Core.parseJSON(await limitedText(response,1048576));record.response={status:response.status,json:!!json,fields:json?Core.fields(json):[]};
      confirmed=Core.blockEvidence({records:[record]},capture).confirmed;
    }catch{}finally{root.clearTimeout(timer);s.active--;if(!confirmed)s.enabled=false;}
    return{attempted:true,accepted:confirmed,report:Core.cleanReport({records:[record]})};
  }
  function pause(){if(state){state.enabled=false;state.epoch++;}return{paused:true};}
  async function resume(){const s=state,epoch=s?.epoch;if(!valid(s))return{ready:false};try{const actor=await profile(s,s.actorUsername);if(!valid(s)||s.epoch!==epoch||!actor.isSelf||actor.actorId!==s.actorId||actor.userId!==s.actorUserId)return{ready:false};s.enabled=true;return{ready:true};}catch{return{ready:false};}}
  function status(){return{ready:valid(state),enabled:state?.enabled===true,active:state?.active||0};}
  function dispose(){if(!state)return;const s=state;state=null;s.closed=true;s.enabled=false;s.cache.clear();s.candidate.body=null;s.candidate.headers=null;root.clearTimeout(s.timer);}
  root.ThreadsParallelRequest=Object.freeze({version:2,start,prepare,submit,pause,resume,status,dispose});
})(globalThis);
