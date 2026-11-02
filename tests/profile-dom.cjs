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
      await check(`${name}: duplicate independent headers remain ambiguous`,async()=>{
        await cdp.eval(`document.querySelector('#profile-header').insertAdjacentHTML('afterend','<div id="duplicate">'+document.querySelector('#profile-header').innerHTML+'</div>')`);
        assert.equal((await cdp.eval('fixtureAdapter.inspect(fixtureArgs)')).profileHeaderCandidateCount,2);assert.equal(await cdp.eval('fixtureAdapter.profileScope(fixtureArgs.username)'),null);await cdp.eval(`document.querySelector('#duplicate').remove()`);
      });
      await check(`${name}: an explicit already-blocked header without More is skipped`,async()=>{
        await cdp.eval(`(()=>{const context=fixtureAdapter.profileScope(fixtureArgs.username);context.menu.remove();const button=document.createElement('button');button.textContent='解除封鎖';context.scope.append(button);})()`);
        const result=await cdp.eval(`fixtureAdapter.perform({...fixtureArgs,phase:'prepare'})`);assert.equal(result.status,'already-blocked');assert.equal(result.evidence.diagnostics.hasProfileMenu,false);assert.equal(result.evidence.diagnostics.hasUnblock,true);assert.equal(await cdp.eval('fixtureClicks'),0);
      });
      await check(`${name}: a feed username and menu cannot replace a removed header`,async()=>{
        await cdp.eval(`document.querySelector('#profile-header').remove()`);assert.equal((await cdp.eval('fixtureAdapter.inspect(fixtureArgs)')).profileHeaderCandidateCount,0);assert.equal(await cdp.eval('fixtureClicks'),0);
      });
    }
    const report={testedAt:new Date().toISOString(),browser:(await cdp.call('Browser.getVersion')).product,environment:'isolated headless Chrome; two sanitized real public-profile header hierarchies; all account names and external resources replaced; no live Threads actions',passed:passed.length,tests:passed};
    await fs.writeFile(path.join(scratch,'profile-dom-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  } finally {
    try{if(cdp)await cdp.call('Browser.close');}catch{}
    cdp?.ws.close();if(child.exitCode==null)child.kill();child.stderr.destroy();child.unref();
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
