/* Real headless Chrome DOM tests; no npm dependencies or user browser profile. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const scratch = path.resolve(process.env.PROBE_TEST_WORK || path.join(process.cwd(), 'work', 'probe-browser-test'));
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const delay = ms => new Promise(r => setTimeout(r, ms));
const fixture = `<!doctype html><meta charset="utf-8"><title>本機測試頁（不是 Threads）</title>
<style>body{font:16px system-ui;background:#edf1f7;padding:40px;margin-right:400px}#dialog{background:white;width:420px;padding:20px;border-radius:16px}#list{overflow-y:auto;height:180px;border:1px solid #ccc}.row{height:62px;padding:15px;border-bottom:1px solid #eee}a{color:#2455b5}</style>
<h1>本機測試頁 · 非 Threads 實測</h1><p>以模擬名單驗證讀取、去重與中斷行為。</p><div role="dialog" id="dialog"><h2>按讚</h2><div role="list" id="list">
<div class="row"><a href="https://www.threads.com/@alice">Alice</a></div>
<div class="row"><a href="https://www.threads.net/@BOB">Bob</a></div>
<div class="row"><a href="https://www.threads.com/@Alice">Alice 重複</a></div>
<div class="row"><a href="https://example.com/@outsider">外部網址</a></div>
<div class="row" hidden><a href="https://www.threads.com/@hidden">隱藏帳號</a></div>
<div class="row"><a href="https://www.threads.com/@alice/post/TEST">貼文連結</a></div></div></div>
<aside><a href="https://www.threads.com/@recommended">區域外推薦帳號</a></aside>
<script>window.realPageClicks=0;document.addEventListener('click',()=>window.realPageClicks++);</script>`;

class CDP {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); ws.addEventListener('message', e => { const m = JSON.parse(String(e.data)); if (m.id) { const p=this.pending.get(m.id); this.pending.delete(m.id); if (m.error) p?.reject(new Error(JSON.stringify(m.error))); else p?.resolve(m.result); } }); }
  async call(method, params = {}) { const id=++this.seq; return new Promise((resolve,reject) => { this.pending.set(id,{resolve,reject}); this.ws.send(JSON.stringify({id,method,params})); }); }
  async eval(expression) { const r=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true}); if(r.exceptionDetails) throw new Error(r.exceptionDetails.text+': '+r.exceptionDetails.exception?.description); return r.result.value; }
}
(async () => {
  await fs.mkdir(scratch,{recursive:true});
  const profile = await fs.mkdtemp(path.join(scratch,'profile-'));
  const server = http.createServer((req,res) => {res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end(fixture);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const pageUrl = `http://127.0.0.1:${server.address().port}/fixture`;
  let browserError='';
  const child=spawn(chromePath,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-sync','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--window-size=1280,960',pageUrl],{stdio:['ignore','ignore','pipe'],windowsHide:true});
  child.stderr.on('data',data=>{browserError+=String(data).slice(0,8000);});
  child.on('error',error=>{browserError+=error.message;});
  let cdp;
  const results=[];
  const check = async (name,fn) => {await fn();results.push(name);console.log('PASS',name);};
  try {
    let port;
    for(let i=0;i<100;i++){try{port=Number((await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{await delay(100);}}
    if(!port) throw new Error(`Chrome did not expose its isolated test endpoint (exit ${child.exitCode}): ${browserError}`);
    let targets=[];
    for(let i=0;i<50;i++){targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(targets.some(t=>t.url===pageUrl))break;await delay(100);}
    const target=targets.find(t=>t.url===pageUrl); if(!target)throw new Error('Missing fixture page');
    const ws=new WebSocket(target.webSocketDebuggerUrl); await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
    cdp=new CDP(ws);
    await cdp.call('Page.enable');
    await cdp.call('Browser.setDownloadBehavior',{behavior:'deny'});
    for(let i=0;i<50;i++){if(await cdp.eval(`document.readyState==='complete' && !!document.querySelector('#list')`))break;await delay(100);}
    const core=await fs.readFile(path.join(root,'extension/core.js'),'utf8');
    const content=await fs.readFile(path.join(root,'extension/content.js'),'utf8');
    const setup = seed => `globalThis.__threadsProbeTabId=123;globalThis.__saved=${JSON.stringify(seed||{})};globalThis.confirm=()=>true;globalThis.__originalCreateURL=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{globalThis.__exportBlob=blob;return __originalCreateURL(blob)};globalThis.chrome={storage:{local:{get:async k=>({[k]:__saved[k]}),set:async o=>{Object.assign(__saved,JSON.parse(JSON.stringify(o)))},remove:async k=>{delete __saved[k]}}}};`;
    await cdp.eval(setup()); await cdp.eval(core); await cdp.eval(content); await delay(100);
    const ui=`document.querySelector('#threads-likes-probe-host').shadowRoot`;
    const click = id => cdp.eval(`${ui}.getElementById(${JSON.stringify(id)}).click()`);
    const status=()=>cdp.eval(`${ui}.getElementById('status').textContent`);
    const snapshot=()=>cdp.eval(`Object.values(__saved).find(x=>x?.mode==='read-only-probe')`);
    await check('source and scope confirmations required',async()=>{
      await cdp.eval(`${ui}.getElementById('target').value='https://www.threads.com/@author/post/TEST'`); await click('start');
      assert.match(await cdp.eval(`${ui}.getElementById('notice').textContent`),/勾選/); assert.equal(await status(),'尚未開始');
    });
    await check('picker prevents account navigation and isolates a scrollable list',async()=>{
      await click('pick'); const before=await cdp.eval('realPageClicks'); await cdp.eval(`document.querySelector('#list a').click()`);
      assert.equal(await cdp.eval('realPageClicks'),before);assert.match(await cdp.eval(`${ui}.getElementById('scopeInfo').textContent`),/2 個帳號/);
    });
    await cdp.eval(`${ui}.getElementById('targetConfirmed').checked=true;${ui}.getElementById('scopeConfirmed').checked=true;${ui}.getElementById('kind').value='reply'`);
    await check('changing activity after selection requires selecting the scope again',async()=>{
      await cdp.eval(`document.querySelector('#dialog h2').textContent='轉發'`);await click('start');assert.equal(await status(),'尚未開始');assert.match(await cdp.eval(`${ui}.getElementById('notice').textContent`),/失效/);
      await cdp.eval(`document.querySelector('#dialog h2').textContent='按讚'`);
    });
    await click('start');await delay(500);
    await check('only scoped visible profile URLs collected with case-insensitive dedup',async()=>{
      const s=await snapshot();assert.deepEqual(s.accounts.map(a=>a.username.toLowerCase()).sort(),['alice','bob']);assert.equal(s.target.kind,'reply');assert.equal(s.completeness,'unknown');assert.equal(s.liveCompatibility,'not-verified');
    });
    await check('mutation observation captures virtualized replacement rows',async()=>{
      await cdp.eval(`document.querySelector('#list').innerHTML='<div class="row"><a href="https://www.threads.com/@charlie">Charlie</a></div>'`);await delay(500);
      assert.equal((await snapshot()).accounts.length,3);
    });
    await check('pause stops sampling and further automatic scrolling',async()=>{
      await click('pause'); const top=await cdp.eval(`document.querySelector('#list').scrollTop`);
      await cdp.eval(`document.querySelector('#list').insertAdjacentHTML('beforeend','<div class="row"><a href="https://www.threads.com/@dora">Dora</a></div>')`);await delay(1200);
      assert.equal(await status(),'已暫停');assert.equal((await snapshot()).accounts.length,3);assert.equal(await cdp.eval(`document.querySelector('#list').scrollTop`),top);
    });
    await check('resume collects pending rows; stop retains data and cancels work',async()=>{
      await click('resume');await delay(150);await click('stop');
      assert.equal((await snapshot()).accounts.length,4);assert.equal(await status(),'已中止');
      await cdp.eval(`document.querySelector('#list').insertAdjacentHTML('beforeend','<div class="row"><a href="https://www.threads.com/@erin">Erin</a></div>')`);await delay(1100);
      assert.equal((await snapshot()).accounts.length,4);assert.equal((await snapshot()).status,'stopped');
    });
    await check('new run has explicit source metadata; bottom never implies completeness',async()=>{
      await click('start');await delay(5600);const s=await snapshot();assert.equal(s.status,'ended');assert.equal(s.completeness,'unknown');assert.match(s.reason,/完整性未知/);assert.equal(s.accounts.length,3);
    });
    await check('navigation automatically pauses an active task',async()=>{
      await click('start');await delay(100);await cdp.eval(`history.pushState({},'', '/another-page')`);await delay(1100);assert.equal(await status(),'已暫停');
      await click('stop');await cdp.eval(`history.replaceState({},'', '/fixture')`);
    });
    await check('hidden or disconnected scope automatically pauses',async()=>{
      await click('start');await delay(100);await cdp.eval(`document.querySelector('#dialog').hidden=true`);await delay(1100);assert.equal(await status(),'已暫停');
      await click('stop');await cdp.eval(`document.querySelector('#dialog').hidden=false`);
    });
    await check('activity context change pauses before collecting replacement profiles',async()=>{
      await click('start');await delay(100);
      await cdp.eval(`document.querySelector('#dialog h2').textContent='轉發';document.querySelector('#list').innerHTML='<div class="row"><a href="https://www.threads.com/@wrongactivity">Wrong activity</a></div>'`);await delay(1200);
      assert.equal(await status(),'已暫停');assert.ok(!(await snapshot()).accounts.some(a=>a.username==='wrongactivity'));
      await click('stop');await cdp.eval(`document.querySelector('#dialog h2').textContent='按讚'`);
    });
    await check('page interaction pauses before a user can switch lists',async()=>{
      await click('start');await delay(100);await cdp.eval(`document.querySelector('#dialog h2').dispatchEvent(new MouseEvent('pointerdown',{bubbles:true}))`);assert.equal(await status(),'已暫停');await click('stop');
    });
    await check('reinjection creates only one panel',async()=>{
      await cdp.eval(content);assert.equal(await cdp.eval(`document.querySelectorAll('#threads-likes-probe-host').length`),1);
    });
    await check('closing the panel hides it and pauses; toolbar reinjection reopens it',async()=>{
      await click('start');await delay(100);await click('close');assert.equal(await status(),'已暫停');assert.equal(await cdp.eval(`document.querySelector('#threads-likes-probe-host').getBoundingClientRect().width`),0);
      await cdp.eval(content);assert.ok(await cdp.eval(`document.querySelector('#threads-likes-probe-host').getBoundingClientRect().width>0`));await click('stop');
    });
    const saved=await cdp.eval('__saved');const priorSeen=(await snapshot()).accounts.map(a=>a.lastSeenAt);
    await cdp.call('Page.navigate',{url:pageUrl});
    for(let i=0;i<50;i++){if(await cdp.eval(`document.readyState==='complete' && !!document.querySelector('#list')`))break;await delay(100);}
    await cdp.eval(setup(saved));await cdp.eval(core);await cdp.eval(content);await delay(100);
    await check('reload restores records without resuming or restoring confirmations',async()=>{
      assert.match(await status(),/還原/);assert.equal(await cdp.eval(`${ui}.getElementById('scopeConfirmed').checked`),false);assert.equal(await cdp.eval(`${ui}.getElementById('resume').disabled`),true);
      await click('json');
      const exported=await cdp.eval(`__exportBlob.text().then(JSON.parse)`);
      assert.deepEqual(exported.accounts.map(a=>a.lastSeenAt),priorSeen);
      assert.equal(await cdp.eval(`${ui}.querySelectorAll('.account').length`),priorSeen.length);
    });
    await cdp.call('Page.captureScreenshot',{format:'png'}).then(r=>fs.writeFile(path.join(scratch,'fixture-preview.png'),Buffer.from(r.data,'base64')));
    const report={testedAt:new Date().toISOString(),browser:(await cdp.call('Browser.getVersion')).product,environment:'isolated headless Chrome, simulated local fixture, mocked chrome.storage; not a live Threads test or installed-extension end-to-end test',passed:results.length,tests:results};
    await fs.writeFile(path.join(scratch,'browser-results.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
  } finally {
    try{if(cdp)await cdp.call('Browser.close');}catch{}
    cdp?.ws.close(); if(child.exitCode==null)child.kill(); child.stderr.destroy();child.unref();server.closeAllConnections();server.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
