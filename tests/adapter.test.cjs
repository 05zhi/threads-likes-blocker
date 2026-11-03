const test = require('node:test');
const assert = require('node:assert/strict');
const Adapter = require('../extension/block-adapter.js');

// Deliberately small DOM fixture: all writes are counters and node changes.
// These tests do not load a real Threads page or touch a real account.
let nextTop = 0;
class Element {
  constructor(tag, attrs = {}, value = '') { this.tagName=tag.toUpperCase();this.attrs={...attrs};this.value=value;this.children=[];this.parentElement=null;this.onClick=null;this.top=(nextTop+=24);this.disabled=false; }
  append(...nodes) { for(const node of nodes){node.parentElement=this;this.children.push(node);}return this; }
  remove() { if(this.parentElement){this.parentElement.children=this.parentElement.children.filter(n=>n!==this);this.parentElement=null;} }
  get isConnected() { let n=this;while(n.parentElement)n=n.parentElement;return n instanceof Document; }
  getAttribute(name) { return Object.hasOwn(this.attrs,name)?this.attrs[name]:null; }
  get textContent() { return [this.value,...this.children.map(n=>n.textContent)].filter(Boolean).join(' '); }
  get innerText() { return this.textContent; }
  getBoundingClientRect() { return {left:10,top:this.top,width:this.attrs.hidden!=null?0:160,height:this.attrs.hidden!=null?0:20}; }
  contains(node) { return node===this||this.children.some(n=>n.contains(node)); }
  matches(selector) {
    if(selector.includes(' ')){const parts=selector.split(/\s+/);return this.matches(parts.at(-1))&&!!this.parentElement?.closest(parts.slice(0,-1).join(' '));}
    const match=/^([a-z0-9-]+)?(?:\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\])?$/i.exec(selector.trim());
    if(!match)return false;const [,tag,attr,value]=match;
    return (!tag||this.tagName.toLowerCase()===tag.toLowerCase())&&(!attr||this.getAttribute(attr)!==null&&(value===undefined||this.getAttribute(attr)===value));
  }
  closest(selector) { for(let n=this;n;n=n.parentElement){if(selector.split(',').some(s=>n.matches(s)))return n;}return null; }
  querySelectorAll(selector) { const result=[];for(const child of this.children){if(selector.split(',').some(s=>child.matches(s)))result.push(child);result.push(...child.querySelectorAll(selector));}return result; }
  click() { this.onClick?.(); }
}
class Document extends Element {
  constructor(){super('document');this.hitOverride=null;}
  getElementById(id){return this.querySelectorAll('[id]').find(n=>n.getAttribute('id')===id)||null;}
  elementFromPoint(x,y){if(this.hitOverride)return this.hitOverride;return this.querySelectorAll('button,[role="button"],[role="menuitem"],a[href]').find(e=>{const r=e.getBoundingClientRect();return e.isConnected&&r.width&&y>=r.top&&y<=r.top+r.height&&x>=r.left&&x<=r.left+r.width;})||null;}
}
function fixture(options={}){
  nextTop=0;
  const doc=new Document(),nav=new Element('nav'),actor=new Element('a',{'href':'/@owner','aria-label':'Profile'}),main=new Element(options.mainTag||'main'),header=new Element('div'),identity=new Element(options.usernameTag||'h2',{},'victim'),more=new Element('button',{'aria-label':'More','aria-haspopup':options.popup||'menu'}),article=new Element('article');
  const actionRow=new Element('div'),profileHeader=options.siblingUnblock?new Element('div').append(header,actionRow):header;
  header.append(identity,more);
  doc.append(nav.append(actor),main.append(profileHeader,article.append(new Element('a',{href:'/@victim/post/POST'},'victim post'),new Element('button',{'aria-label':'More'}))));
  let location='https://www.threads.com/@victim',time=0,finalClicks=0,menuClicks=0,optionClicks=0;
  let dialog=null,confirmButton=null;
  const scheduled=[],timings={};
  const schedule=(ms,fn)=>scheduled.push({at:time+ms,fn});
  more.onClick=()=>{
    menuClicks++;timings.more=time;
    const renderMenu=()=>{
    const menu=new Element('div',options.roleless?{}:{role:options.actionsRole||'menu'},options.actionsText||''),option=new Element('button',{role:'menuitem'},options.unblockMenu?'Unblock':'Block');doc.append(menu.append(option));
    if((options.actionsRole==='dialog'||options.roleless)&&!options.noOtherAction)menu.append(new Element('button',{},'Mute'));
    if(options.zeroSizedMenu)menu.getBoundingClientRect=()=>({left:0,top:0,width:0,height:0});
    if(options.extraPopup)doc.append(new Element('div',{role:'menu'}).append(new Element('button',{},'Copy link')));
    if(options.secondBlockGroup)doc.append(new Element('div').append(new Element('button',{},'Block'),new Element('button',{},'Report')));
    if(options.menuInFeed){menu.remove();article.append(menu);}
    const optionCreatedAt=time,optionTop=option.top;
    if(options.movingOptionMs)option.getBoundingClientRect=()=>({left:10,top:optionTop+Math.max(0,options.movingOptionMs-(time-optionCreatedAt))/10,width:160,height:20});
    if(options.disabledOptionMs){option.disabled=true;schedule(options.disabledOptionMs,()=>{option.disabled=false;});}
    option.onClick=()=>{
      optionClicks++;timings.option=time;menu.remove();
      const renderDialog=()=>{
      dialog=new Element('div',{role:'dialog'},options.mention??'Block @victim?');
      confirmButton=new Element('button',{},'Block');dialog.append(confirmButton);
      if(options.ambiguous)dialog.append(new Element('button',{},'Block'));
      doc.append(dialog);
      if(options.disabledConfirmMs){confirmButton.disabled=true;schedule(options.disabledConfirmMs,()=>{confirmButton.disabled=false;});}
      confirmButton.onClick=()=>{finalClicks++;timings.final=time;dialog.remove();if(options.barrierAfterClick)doc.append(new Element('div',{role:'alert'},'Try again later'));else if(options.verify!==false){const row=options.siblingUnblock?actionRow:header;row.append(new Element('button',{},'Unblock'));if(options.duplicateUnblock)row.append(new Element('button',{},'Unblock'));}};
      };
      if(options.dialogDelay)schedule(options.dialogDelay,renderDialog);else renderDialog();
    };
    };
    if(options.menuDelay)schedule(options.menuDelay,renderMenu);else renderMenu();
  };
  if(options.alreadyBlocked)(options.siblingUnblock?actionRow:header).append(new Element('button',{},'Unblock'));
  if(options.withoutMore)more.remove();
  if(options.depth){identity.remove();let parent=header;for(let i=0;i<options.depth;i++){const wrapper=new Element('div');parent.append(wrapper);parent=wrapper;}parent.append(identity);}
  if(options.headerPostLink)header.append(new Element('a',{href:'/@victim/post/PINNED'},'Pinned post'));
  if(options.feedOnly){more.remove();identity.remove();article.append(new Element('h2',{},'victim'));}
  if(options.hydrateHeader)header.remove();
  if(options.hydrateActor)actor.remove();
  const adapter=Adapter.createAdapter({document:doc,href:()=>location,getComputedStyle:element=>options.style?.(element,time)||{},now:()=>time,delay:async ms=>{time+=ms;for(const task of [...scheduled])if(task.at<=time){scheduled.splice(scheduled.indexOf(task),1);task.fn();}options.onDelay?.({doc,time});if(time>=600){if(options.hydrateHeader&&!header.isConnected&&!options.neverHydrate)main.append(header);if(options.hydrateActor&&!actor.isConnected)nav.append(actor);if(options.changeActorDuringHydration)actor.attrs.href='/@someone_else';}},token:()=>`nonce-${time}`});
  const args={username:'victim',actorUsername:'owner'};
  return {doc,nav,actor,main,article,header,profileHeader,actionRow,more,identity,adapter,args,timings,get dialog(){return dialog;},get confirmButton(){return confirmButton;},get elapsed(){return time;},counts:()=>({finalClicks,menuClicks,optionClicks}),setLocation:value=>{location=value;}};
}

test('slow menus and dialogs wait for enabled stable controls and do not double-click',async()=>{
  const f=fixture({menuDelay:5500,dialogDelay:5500,movingOptionMs:1600,disabledConfirmMs:900});
  const p=await f.adapter.perform({...f.args,phase:'prepare'});
  assert.equal(p.status,'prepared');assert.equal(f.counts().finalClicks,0);
  const r=await f.adapter.perform({...f.args,phase:'confirm',confirmationToken:p.confirmationToken});
  assert.equal(r.status,'success');assert.deepEqual(f.counts(),{menuClicks:1,optionClicks:1,finalClicks:1});
  assert.ok(f.timings.more>=900);assert.ok(f.timings.option-f.timings.more>=5500+1600+650);
  assert.ok(f.timings.final-f.timings.option>=5500+900+650);
});

test('capture phase consumes a prepared token once without claiming the UI means success', async()=>{
  const f=fixture(); const p=await f.adapter.perform({...f.args,phase:'prepare'});
  const captured=await f.adapter.perform({...f.args,phase:'capture',confirmationToken:p.confirmationToken});
  assert.equal(captured.status,'capture-triggered'); assert.equal(f.counts().finalClicks,1);
  await f.adapter.perform({...f.args,phase:'capture',confirmationToken:p.confirmationToken}); assert.equal(f.counts().finalClicks,1);
});
test('verification is read-only and requires the target profile unblock state', async()=>{
  for(const alreadyBlocked of [true,false]) {
    const f=fixture({alreadyBlocked}); const result=await f.adapter.perform({...f.args,phase:'verify'});
    assert.equal(result.status,alreadyBlocked?'success':'unknown'); assert.deepEqual(f.counts(),{menuClicks:0,optionClicks:0,finalClicks:0});
  }
});

test('quickly mounted controls still have a settling interval before each action',async()=>{
  const f=fixture(),p=await f.adapter.perform({...f.args,phase:'prepare'});
  await f.adapter.perform({...f.args,phase:'confirm',confirmationToken:p.confirmationToken});
  assert.ok(f.timings.more>=900);assert.ok(f.timings.option-f.timings.more>=900);assert.ok(f.timings.final-f.timings.option>=900);
});

test('fade-in ancestors and temporary overlays must clear before the stability interval starts',async()=>{
  const faded=fixture({style:(element,time)=>({opacity:element.tagName==='MAIN'&&time<1800?'0.4':'1'})});
  assert.equal((await faded.adapter.perform({...faded.args,phase:'prepare'})).status,'prepared');assert.ok(faded.timings.more>=1800+650);
  const covered=fixture({onDelay:({doc,time})=>{if(time>=1300)doc.hitOverride=null;}});covered.doc.hitOverride=new Element('div');
  assert.equal((await covered.adapter.perform({...covered.args,phase:'prepare'})).status,'prepared');assert.ok(covered.timings.more>=1300+650);
});

test('a perpetually moving control times out without trying a click',async()=>{
  const f=fixture();f.more.getBoundingClientRect=()=>({left:10,top:100+f.elapsed/10,width:160,height:20});
  const result=await f.adapter.perform({...f.args,phase:'prepare'});
  assert.equal(result.status,'needs-attention');assert.ok(f.elapsed>=12000&&f.elapsed<12500);assert.equal(f.counts().menuClicks,0);
});

test('leaving the foreground during the settling delay cancels before the first click',async()=>{
  const f=fixture({onDelay:({doc})=>{doc.visibilityState='hidden';}});
  const result=await f.adapter.perform({...f.args,phase:'prepare'});
  assert.equal(result.status,'deferred');assert.equal(f.counts().menuClicks,0);assert.equal(result.evidence.finalActionAttempted,false);
});

test('a final button that moved or was replaced after readiness is never clicked',async()=>{
  for(const change of ['move','replace','disable']){
    const f=fixture(),p=await f.adapter.perform({...f.args,phase:'prepare'});
    if(change==='move')f.confirmButton.top+=20;
    if(change==='replace'){f.confirmButton.remove();f.dialog.append(new Element('button',{},'Block'));}
    if(change==='disable')f.confirmButton.disabled=true;
    assert.equal((await f.adapter.perform({...f.args,phase:'confirm',confirmationToken:p.confirmationToken})).status,'needs-attention');assert.equal(f.counts().finalClicks,0);
  }
});

test('profile URLs accept only exact HTTPS Threads profiles',()=>{
  assert.equal(Adapter.profileUsernameFromUrl('https://www.threads.com/@a.b_1/'),'a.b_1');
  assert.equal(Adapter.profileUsernameFromUrl('/@user','https://www.threads.net'),'user');
  for(const raw of ['https://www.threads.com.evil.test/@user','https://user:pw@www.threads.com/@user','https://www.threads.com:999/@user','http://www.threads.com/@user','https://www.threads.com/@user/post/ID','https://www.threads.com/login','javascript:alert(1)'])assert.equal(Adapter.profileUsernameFromUrl(raw),null,raw);
});
test('accessible text uses explicit labels and icon labels exactly',()=>{
  const doc=new Document(),button=new Element('button',{'aria-label':'  More  '},'wrong');doc.append(button);assert.equal(Adapter.exactAccessibleText(button,doc),'More');
  const label=new Element('span',{id:'block-label'},'Block'),referenced=new Element('button',{'aria-labelledby':'block-label'});doc.append(label,referenced);assert.equal(Adapter.exactAccessibleText(referenced,doc),'Block');
  const iconButton=new Element('button').append(new Element('svg',{'aria-label':'更多'}));doc.append(iconButton);assert.equal(Adapter.exactAccessibleText(iconButton,doc),'更多');
});
test('actor must be uniquely readable from profile navigation',()=>{
  const f=fixture();assert.equal(f.adapter.readableActorFromNavigation(),'owner');f.nav.append(new Element('a',{href:'/@other','aria-label':'Profile'}));assert.equal(f.adapter.readableActorFromNavigation(),null);
});
test('prepare opens confirmation but never submits the final action',async()=>{
  const f=fixture(),r=await f.adapter.perform({...f.args,phase:'prepare'});assert.equal(r.status,'prepared');assert.equal(typeof r.confirmationToken,'string');assert.deepEqual(f.counts(),{finalClicks:0,menuClicks:1,optionClicks:1});
});

test('hidden work pages defer before clicking More instead of reporting a missing menu',async()=>{
  const f=fixture();f.doc.visibilityState='hidden';
  const result=await f.adapter.perform({...f.args,phase:'prepare'});
  assert.equal(result.status,'deferred');assert.equal(result.evidence.finalActionAttempted,false);
  assert.equal(result.evidence.diagnostics.documentVisibility,'hidden');assert.equal(f.counts().menuClicks,0);
});

test('hiding during menu opening or before final confirmation never sends the final block',async()=>{
  const during=fixture(),open=during.more.onClick;
  during.more.onClick=()=>{open();during.doc.visibilityState='hidden';};
  assert.equal((await during.adapter.perform({...during.args,phase:'prepare'})).status,'deferred');assert.equal(during.counts().optionClicks,0);
  const beforeFinal=fixture(),p=await beforeFinal.adapter.perform({...beforeFinal.args,phase:'prepare'});beforeFinal.doc.visibilityState='hidden';
  const result=await beforeFinal.adapter.perform({...beforeFinal.args,phase:'confirm',confirmationToken:p.confirmationToken});
  assert.equal(result.status,'deferred');assert.equal(result.evidence.finalActionAttempted,false);assert.equal(beforeFinal.counts().finalClicks,0);
});

test('hiding after final submission remains unknown and cannot become a retryable deferral',async()=>{
  const f=fixture(),p=await f.adapter.perform({...f.args,phase:'prepare'}),submit=f.confirmButton.onClick;
  f.confirmButton.onClick=()=>{submit();f.doc.visibilityState='hidden';};
  const result=await f.adapter.perform({...f.args,phase:'confirm',confirmationToken:p.confirmationToken});
  assert.equal(result.status,'unknown');assert.notEqual(result.evidence.finalActionAttempted,false);assert.equal(f.counts().finalClicks,1);
});

test('newly opened profile actions do not require a menu/dialog role or a container layout box',async()=>{
  for(const options of [{roleless:true},{zeroSizedMenu:true},{roleless:true,extraPopup:true},{actionsRole:'dialog',extraPopup:true}]){
    const f=fixture(options),p=await f.adapter.perform({...f.args,phase:'prepare'});
    assert.equal(p.status,'prepared',JSON.stringify(options));assert.equal(f.counts().optionClicks,1);assert.equal(f.counts().finalClicks,0);
    assert.equal((await f.adapter.perform({...f.args,phase:'confirm',confirmationToken:p.confirmationToken})).status,'success');
  }
});

test('roleless action discovery rejects final confirmations, feeds and multiple block groups',async()=>{
  for(const options of [{roleless:true,noOtherAction:true,actionsText:'Block @victim?'},{roleless:true,secondBlockGroup:true},{roleless:true,menuInFeed:true}]){
    const f=fixture(options),p=await f.adapter.perform({...f.args,phase:'prepare'});
    assert.equal(p.status,'needs-attention');assert.equal(f.counts().optionClicks,0);assert.equal(f.counts().finalClicks,0);
  }
});

test('pre-existing block controls cannot supply the newly opened account menu',async()=>{
  const f=fixture({roleless:true,noOtherAction:true});
  f.doc.append(new Element('div').append(new Element('button',{},'Block'),new Element('button',{},'Report')));
  assert.equal((await f.adapter.perform({...f.args,phase:'prepare'})).status,'needs-attention');assert.equal(f.counts().optionClicks,0);
});
test('confirm requires its prepare token and verifies the profile unblock control',async()=>{
  const f=fixture(),p=await f.adapter.perform({...f.args,phase:'prepare'}),r=await f.adapter.perform({...f.args,phase:'confirm',confirmationToken:p.confirmationToken});assert.equal(r.status,'success');assert.equal(f.counts().finalClicks,1);
  const repeat=await f.adapter.perform({...f.args,phase:'confirm',confirmationToken:p.confirmationToken});assert.equal(repeat.status,'needs-attention');assert.equal(f.counts().finalClicks,1);
});

test('a sibling account action row verifies success without widening the prepared scope',async()=>{
  const f=fixture({mainTag:'div',popup:'dialog',siblingUnblock:true});
  const originalScope=f.adapter.profileScope('victim').scope;
  assert.equal(originalScope,f.header);assert.equal(f.adapter.inspect(f.args).hasUnblock,false);
  const p=await f.adapter.perform({...f.args,phase:'prepare'});
  assert.equal(p.status,'prepared');assert.equal(f.adapter.profileScope('victim').scope,originalScope);
  const result=await f.adapter.perform({...f.args,phase:'confirm',confirmationToken:p.confirmationToken});
  assert.equal(result.status,'success');assert.equal(f.adapter.inspect(f.args).hasUnblock,true);assert.equal(f.adapter.profileScope('victim').scope,originalScope);assert.equal(f.counts().finalClicks,1);
});

test('an already-blocked sibling action row is recognized before any menu click',async()=>{
  const f=fixture({mainTag:'div',popup:'dialog',siblingUnblock:true,alreadyBlocked:true});
  assert.equal(f.adapter.inspect(f.args).hasUnblock,true);assert.equal((await f.adapter.perform({...f.args,phase:'prepare'})).status,'already-blocked');assert.deepEqual(f.counts(),{finalClicks:0,menuClicks:0,optionClicks:0});
});

test('feed, recommendation and other-account unblock controls cannot verify the target',async()=>{
  for(const unrelated of [
    ()=>new Element('article').append(new Element('button',{},'Unblock')),
    ()=>new Element('div',{role:'feed'}).append(new Element('button',{},'Unblock')),
    ()=>new Element('aside').append(new Element('button',{},'Unblock')),
    ()=>new Element('div').append(new Element('a',{href:'/@another'},'another'),new Element('button',{},'Unblock')),
    ()=>new Element('div').append(new Element('a',{href:'/@victim/post/POST'},'post'),new Element('button',{},'Unblock')),
    ()=>new Element('div').append(new Element('button',{'aria-label':'More'}),new Element('button',{},'Unblock'))
  ]){
    const f=fixture({mainTag:'div',siblingUnblock:true,verify:false});f.profileHeader.append(unrelated());
    assert.equal(f.adapter.inspect(f.args).hasUnblock,false);
    const p=await f.adapter.perform({...f.args,phase:'prepare'}),r=await f.adapter.perform({...f.args,phase:'confirm',confirmationToken:p.confirmationToken});
    assert.equal(p.status,'prepared');assert.equal(r.status,'unknown');assert.equal(f.counts().finalClicks,1);
  }
});

test('multiple unblock controls and controls beyond the profile region remain unverified',async()=>{
  const duplicate=fixture({siblingUnblock:true,duplicateUnblock:true}),p=await duplicate.adapter.perform({...duplicate.args,phase:'prepare'});
  assert.equal((await duplicate.adapter.perform({...duplicate.args,phase:'confirm',confirmationToken:p.confirmationToken})).status,'unknown');assert.equal(duplicate.adapter.inspect(duplicate.args).hasUnblock,false);
  const outside=fixture({siblingUnblock:true,verify:false});outside.profileHeader.attrs.role='region';outside.main.append(new Element('button',{},'Unblock'));outside.article.remove();
  assert.equal(outside.adapter.inspect(outside.args).hasUnblock,false);
});

test('moving the compact header to a replacement scope still invalidates confirmation',async()=>{
  const f=fixture({siblingUnblock:true}),p=await f.adapter.perform({...f.args,phase:'prepare'});
  f.identity.remove();f.more.remove();f.header.remove();f.profileHeader.append(new Element('div').append(f.identity,f.more));
  assert.equal((await f.adapter.perform({...f.args,phase:'confirm',confirmationToken:p.confirmationToken})).status,'needs-attention');assert.equal(f.counts().finalClicks,0);
});
test('wrong tokens and confirms without preparation never click',async()=>{
  const f=fixture();assert.equal((await f.adapter.perform({...f.args,phase:'confirm',confirmationToken:'none'})).status,'needs-attention');await f.adapter.perform({...f.args,phase:'prepare'});assert.equal((await f.adapter.perform({...f.args,phase:'confirm',confirmationToken:'wrong'})).status,'needs-attention');assert.equal(f.counts().finalClicks,0);
});
test('self, wrong actor and changed profile URL all fail before any menu click',async()=>{
  for(const change of ['self','actor','url']){const f=fixture();let args={...f.args};if(change==='self')args.actorUsername='victim';if(change==='actor')f.actor.attrs.href='/@other';if(change==='url')f.setLocation('https://www.threads.com/@other');assert.equal((await f.adapter.perform({...args,phase:'prepare'})).status,'needs-attention');assert.equal(f.counts().menuClicks,0);}
});
test('a post menu cannot stand in for the profile menu',async()=>{
  const f=fixture({feedOnly:true});assert.equal((await f.adapter.perform({...f.args,phase:'prepare'})).status,'needs-attention');assert.equal(f.counts().menuClicks,0);
});
test('dialog must mention the exact @target and have exactly one block button',async()=>{
  for(const options of [{mention:'Block display name?'},{mention:'Block @victim.other?'},{mention:'Block @victim_2?'},{ambiguous:true}]){const f=fixture(options);assert.equal((await f.adapter.perform({...f.args,phase:'prepare'})).status,'needs-attention');assert.equal(f.counts().finalClicks,0);}
});
test('actor changes after preparation prevent confirmation',async()=>{
  const f=fixture(),p=await f.adapter.perform({...f.args,phase:'prepare'});f.actor.attrs.href='/@another';assert.equal((await f.adapter.perform({...f.args,phase:'confirm',confirmationToken:p.confirmationToken})).status,'needs-attention');assert.equal(f.counts().finalClicks,0);
});
test('replacement confirmation dialogs invalidate the prepared context',async()=>{
  const f=fixture(),p=await f.adapter.perform({...f.args,phase:'prepare'});f.dialog.remove();f.doc.append(new Element('div',{role:'dialog'},'Block @victim?').append(new Element('button',{},'Block')));assert.equal((await f.adapter.perform({...f.args,phase:'confirm',confirmationToken:p.confirmationToken})).status,'needs-attention');assert.equal(f.counts().finalClicks,0);
});
test('already blocked accounts never click a block option',async()=>{
  for(const options of [{alreadyBlocked:true},{unblockMenu:true}]){const f=fixture(options),r=await f.adapter.perform({...f.args,phase:'prepare'});assert.equal(r.status,'already-blocked');assert.equal(f.counts().optionClicks,0);assert.equal(f.counts().finalClicks,0);}
});
test('obscured controls are never clicked',async()=>{
  const f=fixture();f.doc.hitOverride=new Element('div');assert.equal((await f.adapter.perform({...f.args,phase:'prepare'})).status,'needs-attention');assert.equal(f.counts().menuClicks,0);
});
test('a sent block without clear unblock evidence is unknown and not retried',async()=>{
  const f=fixture({verify:false}),p=await f.adapter.perform({...f.args,phase:'prepare'}),r=await f.adapter.perform({...f.args,phase:'confirm',confirmationToken:p.confirmationToken});assert.equal(r.status,'unknown');assert.equal(f.counts().finalClicks,1);assert.equal((await f.adapter.perform({...f.args,phase:'confirm',confirmationToken:p.confirmationToken})).status,'needs-attention');assert.equal(f.counts().finalClicks,1);
});
test('rate limiting after the final click yields unknown, not success',async()=>{
  const f=fixture({barrierAfterClick:true}),p=await f.adapter.perform({...f.args,phase:'prepare'}),r=await f.adapter.perform({...f.args,phase:'confirm',confirmationToken:p.confirmationToken});assert.equal(r.status,'unknown');assert.match(r.reason,/操作限制/);assert.equal(f.counts().finalClicks,1);
});

test('profile headers do not require main semantics or heading-only username tags',async()=>{
  for(const options of [{mainTag:'div'},{mainTag:'div',usernameTag:'div'},{mainTag:'div',usernameTag:'span',depth:12,popup:'dialog'}]){
    const f=fixture(options),r=await f.adapter.perform({...f.args,phase:'prepare'});assert.equal(r.status,'prepared');assert.equal(f.counts().finalClicks,0);assert.equal(r.evidence.diagnostics.profileHeaderCandidateCount,1);
  }
});

test('navigation, recommendations and post identities cannot supply profile actions',async()=>{
  const f=fixture({feedOnly:true,mainTag:'div'});f.nav.append(new Element('span',{},'victim'),new Element('button',{'aria-label':'More'}));
  f.doc.append(new Element('aside').append(new Element('span',{},'victim'),new Element('button',{'aria-label':'More'})));
  assert.equal((await f.adapter.perform({...f.args,phase:'prepare'})).status,'needs-attention');assert.equal(f.counts().menuClicks,0);
  const linked=fixture({headerPostLink:true});assert.equal((await linked.adapter.perform({...linked.args,phase:'prepare'})).status,'needs-attention');assert.equal(linked.counts().menuClicks,0);
});

test('ambiguous independent profile headers fail closed',async()=>{
  const f=fixture({mainTag:'div'});f.main.append(new Element('div').append(new Element('span',{},'victim'),new Element('button',{'aria-label':'More'})));
  assert.equal(f.adapter.inspect(f.args).profileHeaderCandidateCount,2);assert.equal((await f.adapter.perform({...f.args,phase:'prepare'})).status,'needs-attention');assert.equal(f.counts().menuClicks,0);
});

test('logged-in column titles do not compete with the account profile header',async()=>{
  for(const label of ['直欄標題','Column header','Column title']){
    const f=fixture({mainTag:'div',popup:'dialog'});
    let columnClicks=0;
    const columnMore=new Element('button',{'aria-label':'More','aria-haspopup':'menu'});columnMore.onClick=()=>columnClicks++;
    f.doc.append(new Element('div').append(new Element('a',{href:'/@victim','aria-label':label}).append(new Element('h1',{},'victim')),columnMore));
    assert.equal(f.adapter.inspect(f.args).profileHeaderCandidateCount,1);
    const result=await f.adapter.perform({...f.args,phase:'prepare'});assert.equal(result.status,'prepared');assert.equal(columnClicks,0);assert.equal(f.counts().finalClicks,0);
  }
});

test('a column title alone never supplies a profile when account header is missing',async()=>{
  const f=fixture({mainTag:'div',feedOnly:true});
  f.doc.append(new Element('div').append(new Element('a',{href:'/@victim','aria-label':'直欄標題'}).append(new Element('h1',{},'victim')),new Element('button',{'aria-label':'More','aria-haspopup':'menu'})));
  assert.equal(f.adapter.inspect(f.args).profileHeaderCandidateCount,0);assert.equal((await f.adapter.perform({...f.args,phase:'prepare'})).status,'needs-attention');assert.equal(f.counts().menuClicks,0);
});

test('an already-blocked profile without a More menu is safely skipped',async()=>{
  const f=fixture({mainTag:'div',alreadyBlocked:true,withoutMore:true});assert.equal((await f.adapter.perform({...f.args,phase:'prepare'})).status,'already-blocked');assert.deepEqual(f.counts(),{finalClicks:0,menuClicks:0,optionClicks:0});
});

test('profile actions support role dialog without mistaking it for final confirmation',async()=>{
  const f=fixture({popup:'dialog',actionsRole:'dialog',actionsText:'Actions for @victim'}),p=await f.adapter.perform({...f.args,phase:'prepare'});
  assert.equal(p.status,'prepared');assert.equal(f.counts().finalClicks,0);assert.equal(f.counts().optionClicks,1);
  assert.equal((await f.adapter.perform({...f.args,phase:'confirm',confirmationToken:p.confirmationToken})).status,'success');
  const ambiguous=fixture({actionsRole:'dialog',actionsText:'Block @victim?',noOtherAction:true});assert.equal((await ambiguous.adapter.perform({...ambiguous.args,phase:'prepare'})).status,'needs-attention');assert.equal(ambiguous.counts().optionClicks,0);
});

test('confirmation accepts a bounded exact username with or without at-sign',async()=>{
  for(const mention of ['Block victim?','封鎖 victim？','Block @victim?']){const f=fixture({mention}),p=await f.adapter.perform({...f.args,phase:'prepare'});assert.equal(p.status,'prepared');assert.equal((await f.adapter.perform({...f.args,phase:'confirm',confirmationToken:p.confirmationToken})).status,'success');}
  for(const mention of ['Block victim.other?','Block victim_2?','Block other_victim?','Block thisvictim?']){const f=fixture({mention});assert.equal((await f.adapter.perform({...f.args,phase:'prepare'})).status,'needs-attention');assert.equal(f.counts().finalClicks,0);}
});

test('preparation waits for React header and actor hydration without clicking early',async()=>{
  const f=fixture({mainTag:'div',hydrateHeader:true,hydrateActor:true}),r=await f.adapter.perform({...f.args,phase:'prepare'});assert.equal(r.status,'prepared');assert.ok(f.elapsed>=600&&f.elapsed<8000);assert.equal(f.counts().finalClicks,0);
  const absent=fixture({hydrateHeader:true,neverHydrate:true}),missing=await absent.adapter.perform({...absent.args,phase:'prepare'});assert.equal(missing.status,'needs-attention');assert.ok(absent.elapsed>=8000);assert.match(missing.reason,/profile-hydration/);
});

test('a changed actor during hydration fails immediately and inspect is read-only',async()=>{
  const f=fixture({hydrateHeader:true,neverHydrate:true,changeActorDuringHydration:true}),r=await f.adapter.perform({...f.args,phase:'prepare'});assert.equal(r.status,'needs-attention');assert.match(r.reason,/登入帳號已改變/);assert.ok(f.elapsed<8000);assert.equal(f.counts().menuClicks,0);
  const ready=fixture({mainTag:'div',popup:'dialog'}),d=ready.adapter.inspect(ready.args);assert.equal(d.mainCount,0);assert.equal(d.profileHeaderCandidateCount,1);assert.equal(d.hasProfileMenu,true);assert.equal(d.menuPopup,'dialog');assert.equal(d.actorMatches,true);assert.deepEqual(ready.counts(),{finalClicks:0,menuClicks:0,optionClicks:0});assert.equal(Object.hasOwn(d,'html'),false);
});
