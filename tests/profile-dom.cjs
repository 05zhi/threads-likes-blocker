'use strict';
// Sanitized snapshots of real public profile headers; no live site or account actions.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const scratch = path.resolve(process.env.PROBE_TEST_WORK || path.join(process.cwd(), 'work', 'profile-dom-tests'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class CDP {
  constructor(ws) { this.ws=ws;this.seq=0;this.pending=new Map();ws.addEventListener('message',event=>{const m=JSON.parse(String(event.data));if(!m.id)return;const p=this.pending.get(m.id);this.pending.delete(m.id);if(m.error)p?.reject(new Error(JSON.stringify(m.error)));else p?.resolve(m.result);}); }
  call(method,params={}) { const id=++this.seq;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));}); }
  async eval(expression) { const result=await this.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value; }
}
async function run() {
  await fs.mkdir(scratch,{recursive:true});
  const profile=await fs.mkdtemp(path.join(scratch,'profile-'));
  const chrome=process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe';
  let errors='';const child=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-sync','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  child.stderr.on('data',data=>{errors+=String(data).slice(0,8000);});child.on('error',error=>{errors+=error.message;});
  let cdp;const passed=[];
  try {
    let port;for(let i=0;i<100;i++){try{port=+(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{await delay(100);}}
    if(!port)throw new Error(`Isolated Chrome failed: ${errors}`);
    const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json(),page=pages.find(item=>item.type==='page');
    const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});cdp=new CDP(ws);
    await cdp.call('Browser.setDownloadBehavior',{behavior:'deny'});
    const adapter=await fs.readFile(path.join(root,'extension/block-adapter.js'),'utf8');
    await cdp.eval(adapter);
    const check=async(name,fn)=>{await fn();passed.push(name);console.log('PASS',name);};
    for(const [name,username] of [['alpha','fixture.alpha'],['beta','fixture.beta']]) {
      const header=await fs.readFile(path.join(__dirname,'fixtures',`profile-header-${name}.html`),'utf8');
      const html=`<!doctype html><meta charset="utf-8"><style>body{font:16px system-ui}svg{width:24px;height:24px}img{width:40px;height:40px}</style><nav><a href="https://www.threads.com/@owner" aria-label="Profile">Profile</a></nav><div id="profile-header">${header}</div><article><a href="https://www.threads.com/@${username}/post/FAKE">${username}</a><button aria-label="More">Post more</button></article>`;
      await cdp.eval(`document.open();document.write(${JSON.stringify(html)});document.close();globalThis.fixtureClicks=0;document.addEventListener('click',()=>fixtureClicks++);globalThis.fixtureAdapter=ThreadsBlockAdapter.createAdapter({document,href:()=>${JSON.stringify('https://www.threads.com/@'+username)}});globalThis.fixtureArgs={username:${JSON.stringify(username)},actorUsername:'owner'};`);
      await check(`${name}: real header hierarchy is detected without main semantics`,async()=>{
        const result=await cdp.eval('fixtureAdapter.inspect(fixtureArgs)');assert.equal(result.mainCount,0);assert.equal(result.profileHeaderCandidateCount,1);assert.equal(result.hasProfileMenu,true);assert.equal(result.menuPopup,'dialog');assert.equal(result.actorMatches,true);
      });
      await check(`${name}: detected profile menu excludes the post menu`,async()=>{
        const result=await cdp.eval(`(()=>{const scope=fixtureAdapter.profileScope(fixtureArgs.username);return {inHeader:document.querySelector('#profile-header').contains(scope.menu),postLinks:scope.scope.querySelectorAll('a[href*="/post/"]').length,label:ThreadsBlockAdapter.exactAccessibleText(scope.menu,document)}})()`);assert.equal(result.inHeader,true);assert.equal(result.postLinks,0);assert.equal(result.label,'更多');
      });
      await check(`${name}: read-only inspection never clicks a control`,async()=>{
        await cdp.eval('fixtureAdapter.inspect(fixtureArgs);fixtureAdapter.profileScope(fixtureArgs.username)');assert.equal(await cdp.eval('fixtureClicks'),0);
      });
      await check(`${name}: logged-in column title cannot compete with the profile header`,async()=>{
        await cdp.eval(`(()=>{const title=document.createElement('div');title.id='column-title';const link=document.createElement('a');link.href=${JSON.stringify('https://www.threads.com/@'+username)};link.setAttribute('aria-label','直欄標題');const heading=document.createElement('h1');heading.textContent=${JSON.stringify(username)};link.append(heading);const more=document.createElement('button');more.setAttribute('aria-label','更多');more.setAttribute('aria-haspopup','menu');title.append(link,more);document.querySelector('#profile-header').before(title);})()`);
        const result=await cdp.eval(`(()=>{const info=fixtureAdapter.inspect(fixtureArgs);const scope=fixtureAdapter.profileScope(fixtureArgs.username);return {...info,inHeader:document.querySelector('#profile-header').contains(scope.menu)}})()`);assert.equal(result.profileHeaderCandidateCount,1);assert.equal(result.hasProfileMenu,true);assert.equal(result.menuPopup,'dialog');assert.equal(result.inHeader,true);assert.equal(await cdp.eval('fixtureClicks'),0);
      });
      await check(`${name}: duplicate independent headers remain ambiguous`,async()=>{
        await cdp.eval(`document.querySelector('#profile-header').insertAdjacentHTML('afterend','<div id="duplicate">'+document.querySelector('#profile-header').innerHTML+'</div>')`);
        assert.equal((await cdp.eval('fixtureAdapter.inspect(fixtureArgs)')).profileHeaderCandidateCount,2);assert.equal(await cdp.eval('fixtureAdapter.profileScope(fixtureArgs.username)'),null);await cdp.eval(`document.querySelector('#duplicate').remove()`);
      });
      await check(`${name}: a sibling profile action row exposes Unblock without changing the compact scope`,async()=>{
        await cdp.eval(`(()=>{const context=fixtureAdapter.profileScope(fixtureArgs.username);globalThis.originalCompactScope=context.scope;const header=document.createElement('div');header.id='account-header';context.scope.before(header);header.append(context.scope);const row=document.createElement('div');row.id='account-actions';const unblock=document.createElement('div');unblock.setAttribute('role','button');unblock.textContent='解除封鎖';row.append(unblock);header.append(row);})()`);
        const result=await cdp.eval('fixtureAdapter.inspect(fixtureArgs)');assert.equal(result.hasUnblock,true);assert.equal(result.profileHeaderCandidateCount,1);assert.equal(await cdp.eval('fixtureAdapter.profileScope(fixtureArgs.username).scope===originalCompactScope'),true);assert.equal(await cdp.eval(`originalCompactScope.querySelectorAll('#account-actions').length`),0);
        assert.equal((await cdp.eval(`fixtureAdapter.perform({...fixtureArgs,phase:'prepare'})`)).status,'already-blocked');assert.equal(await cdp.eval('fixtureClicks'),0);
      });
      await check(`${name}: the same Unblock moved into the feed cannot verify the account`,async()=>{
        await cdp.eval(`document.querySelector('article').append(document.querySelector('#account-actions'))`);
        assert.equal((await cdp.eval('fixtureAdapter.inspect(fixtureArgs)')).hasUnblock,false);assert.equal(await cdp.eval('fixtureAdapter.profileScope(fixtureArgs.username).scope===originalCompactScope'),true);assert.equal(await cdp.eval('fixtureClicks'),0);
      });
      await check(`${name}: an explicit already-blocked header without More is skipped`,async()=>{
        await cdp.eval(`(()=>{const context=fixtureAdapter.profileScope(fixtureArgs.username);context.menu.remove();const button=document.createElement('button');button.textContent='解除封鎖';context.scope.append(button);})()`);
        const result=await cdp.eval(`fixtureAdapter.perform({...fixtureArgs,phase:'prepare'})`);assert.equal(result.status,'already-blocked');assert.equal(result.evidence.diagnostics.hasProfileMenu,false);assert.equal(result.evidence.diagnostics.hasUnblock,true);assert.equal(await cdp.eval('fixtureClicks'),0);
      });
      await check(`${name}: column title and feed controls cannot replace a removed header`,async()=>{
        await cdp.eval(`document.querySelector('#profile-header').remove()`);assert.equal((await cdp.eval('fixtureAdapter.inspect(fixtureArgs)')).profileHeaderCandidateCount,0);assert.equal(await cdp.eval('fixtureClicks'),0);
      });
      for(const mode of ['roleless','zero-box-menu','unrelated-popup','animation-frame','slow-transition']) {
        await check(`${name}: full prepare/confirm handles ${mode} account actions`,async()=>{
          await cdp.eval(`document.open();document.write(${JSON.stringify(html)});document.close();
            globalThis.fixtureAdapter=ThreadsBlockAdapter.createAdapter({document,href:()=>${JSON.stringify('https://www.threads.com/@'+username)},token:()=>'isolated-fixture-token'});
            globalThis.fixtureArgs={username:${JSON.stringify(username)},actorUsername:'owner'};
            globalThis.finalClicks=0;globalThis.actionTimes={};
            fixtureAdapter.profileScope(fixtureArgs.username).menu.addEventListener('click',()=>{
              actionTimes.more=performance.now();
              const renderActions=()=>{
              const portal=document.createElement('div');portal.style.cssText='position:fixed;top:30px;right:30px;z-index:100;background:white;padding:24px';
              const group=document.createElement('div');
              if(${JSON.stringify(mode)}==='zero-box-menu'){group.setAttribute('role','menu');group.style.display='contents';}
              const block=document.createElement('button');block.textContent='封鎖';
              const mute=document.createElement('button');mute.textContent='噤聲';group.append(block,mute);portal.append(group);document.body.append(portal);
              if(${JSON.stringify(mode)}==='slow-transition')portal.animate([{opacity:0,transform:'translateY(30px)'},{opacity:1,transform:'translateY(0px)'}],{duration:900,fill:'both'});
              if(${JSON.stringify(mode)}==='unrelated-popup'){const unrelated=document.createElement('div');unrelated.setAttribute('role','menu');unrelated.textContent='複製連結';portal.append(unrelated);}
              block.addEventListener('click',()=>{
                actionTimes.option=performance.now();
                portal.remove();const dialog=document.createElement('div');dialog.setAttribute('role','dialog');dialog.style.cssText='position:fixed;top:30px;right:30px;z-index:100;background:white;padding:24px';dialog.textContent='封鎖 '+fixtureArgs.username+'？';
                const confirm=document.createElement('button');confirm.textContent='封鎖';dialog.append(confirm);document.body.append(dialog);
                if(${JSON.stringify(mode)}==='slow-transition'){confirm.disabled=true;setTimeout(()=>{confirm.disabled=false},1200);dialog.animate([{opacity:0},{opacity:1}],{duration:700,fill:'both'});}
                confirm.addEventListener('click',()=>{actionTimes.final=performance.now();finalClicks++;dialog.remove();const unblock=document.createElement('button');unblock.textContent='解除封鎖';fixtureAdapter.profileScope(fixtureArgs.username).scope.append(unblock);});
              });
              };
              if(${JSON.stringify(mode)}==='animation-frame')requestAnimationFrame(renderActions);else renderActions();
            });`);
          const prepared=await cdp.eval(`fixtureAdapter.perform({...fixtureArgs,phase:'prepare'}).then(result=>(globalThis.fixturePrepared=result))`);
          assert.equal(prepared.status,'prepared',JSON.stringify(prepared));assert.equal(await cdp.eval('finalClicks'),0);
          assert.equal(prepared.evidence.diagnostics.menuDiscovery.candidateCount,1);
          const confirmed=await cdp.eval(`fixtureAdapter.perform({...fixtureArgs,phase:'confirm',confirmationToken:fixturePrepared.confirmationToken})`);
          assert.equal(confirmed.status,'success');assert.equal(await cdp.eval('finalClicks'),1);
          if(mode==='slow-transition'){const timings=await cdp.eval('actionTimes');assert.ok(timings.option-timings.more>=1400);assert.ok(timings.final-timings.option>=1700);}
        });
      }
    }
    await check('a real background tab defers without a click, then renders animation frames after activation',async()=>{
      const original=(await cdp.call('Target.getTargetInfo')).targetInfo.targetId;
      const other=(await cdp.call('Target.createTarget',{url:'about:blank',background:false})).targetId;
      try {
        for(let i=0;i<30&&(await cdp.eval('document.visibilityState'))!=='hidden';i++)await delay(100);
        assert.equal(await cdp.eval('document.visibilityState'),'hidden');
        await cdp.eval('globalThis.visibilityFrameRan=false;requestAnimationFrame(()=>{visibilityFrameRan=true});');
        const deferred=await cdp.eval(`fixtureAdapter.perform({...fixtureArgs,phase:'prepare'})`);
        assert.equal(deferred.status,'deferred');assert.equal(deferred.evidence.finalActionAttempted,false);
        await delay(250);assert.equal(await cdp.eval('visibilityFrameRan'),false);
        await cdp.call('Target.activateTarget',{targetId:original});
        for(let i=0;i<30&&!(await cdp.eval('visibilityFrameRan'));i++)await delay(100);
        assert.equal(await cdp.eval('document.visibilityState'),'visible');assert.equal(await cdp.eval('visibilityFrameRan'),true);
      } finally {await cdp.call('Target.closeTarget',{targetId:other});}
    });
    for (const format of ['urlencoded','formdata','opaque-fields']) await check(`native Chrome XHR holds ${format} and one direct fetch receives unchanged fields`,async()=>{
      const core=await fs.readFile(path.join(root,'extension/request-probe-core.js'),'utf8');
      const bridge=await fs.readFile(path.join(root,'extension/direct-request.js'),'utf8');
      await cdp.eval(core);
      const result=await cdp.eval(`(async()=>{
        const nativeSend=XMLHttpRequest.prototype.send, calls=[];
        const fakeRoot={ThreadsRequestProbeCore,XMLHttpRequest,URL,URLSearchParams,FormData,Headers,AbortController,setTimeout:setTimeout.bind(window),clearTimeout:clearTimeout.bind(window),document,
          location:{href:'https://www.threads.com/@fixture'},fetch:async(url,init)=>{calls.push({url,body:init.body,credentialMode:init.credentials});return new Response(JSON.stringify({data:{record:{user:{id:'123456',friendship_status:{blocking:true}}}}}),{status:200});}};
        new Function('globalThis',${JSON.stringify(bridge)})(fakeRoot);
        const api=fakeRoot.ThreadsDirectRequest;api.arm({username:'fixture'});
        const encoded=new URLSearchParams({fb_api_req_friendly_name:'useTHUserBlockMutation',doc_id:'12345',fb_dtsg:'synthetic-secret',variables:JSON.stringify({user_id:'123456',container_module:'fixture_profile',media_id:null,barcelona_source_quote_post_id:null,barcelona_source_reply_id:null,is_messaging_nua:null,consistent_thread_fbid:null,...(${JSON.stringify(format)}==='opaque-fields'?{session_id:'synthetic-secret-value'}:{})})});
        const body=${JSON.stringify(format)}==='formdata'?new FormData():encoded.toString();if(body instanceof FormData)for(const [key,value]of encoded)body.append(key,value);
        const xhr=new XMLHttpRequest();xhr.open('POST','https://www.threads.com/api/graphql');if(typeof body==='string')xhr.setRequestHeader('Content-Type','application/x-www-form-urlencoded');xhr.send(body);
        const before={ready:api.status().captured,calls:calls.length,xhrState:xhr.readyState};
        const submitted=await api.submit(),second=await api.submit();api.dispose();
        const fields=calls[0]?.body instanceof FormData?new URLSearchParams(calls[0].body).toString():calls[0]?.body;
        return {before,submitted,second,exact:calls.length===1&&fields===encoded.toString(),restored:XMLHttpRequest.prototype.send===nativeSend};
      })()`);
      assert.equal(result.before.ready,true);assert.equal(result.before.calls,0);assert.equal(result.before.xhrState,1);
      assert.equal(result.submitted.accepted,true);assert.equal(result.second.attempted,false);assert.equal(result.exact,true);assert.equal(result.restored,true);
      assert.equal(JSON.stringify(result).includes('synthetic-secret'),false);
    });
    const report={testedAt:new Date().toISOString(),browser:(await cdp.call('Browser.getVersion')).product,environment:'isolated headless Chrome; two sanitized real public-profile header hierarchies; all account names and external resources replaced; no live Threads actions',passed:passed.length,tests:passed};
    await fs.writeFile(path.join(scratch,'profile-dom-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  } finally {
    try{if(cdp)await cdp.call('Browser.close');}catch{}
    cdp?.ws.close();if(child.exitCode==null)child.kill();child.stderr.destroy();child.unref();
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
