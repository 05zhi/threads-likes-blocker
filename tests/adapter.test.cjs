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
  const doc=new Document(),nav=new Element('nav'),actor=new Element('a',{'href':'/@owner','aria-label':'Profile'}),main=new Element('main'),header=new Element('div'),identity=new Element('h2',{},'victim'),more=new Element('button',{'aria-label':'More','aria-haspopup':'menu'}),article=new Element('article');
  doc.append(nav.append(actor),main.append(header.append(identity,more),article.append(new Element('a',{href:'/@victim/post/POST'},'victim post'),new Element('button',{'aria-label':'More'}))));
  let location='https://www.threads.com/@victim',time=0,finalClicks=0,menuClicks=0,optionClicks=0;
  let dialog=null,confirmButton=null;
  more.onClick=()=>{
    menuClicks++;
    const menu=new Element('div',{role:'menu'}),option=new Element('button',{role:'menuitem'},options.unblockMenu?'Unblock':'Block');doc.append(menu.append(option));
    option.onClick=()=>{
      optionClicks++;menu.remove();dialog=new Element('div',{role:'dialog'},options.mention??'Block @victim?');
      confirmButton=new Element('button',{},'Block');dialog.append(confirmButton);
      if(options.ambiguous)dialog.append(new Element('button',{},'Block'));
      doc.append(dialog);
      confirmButton.onClick=()=>{finalClicks++;dialog.remove();if(options.barrierAfterClick)doc.append(new Element('div',{role:'alert'},'Try again later'));else if(options.verify!==false)header.append(new Element('button',{},'Unblock'));};
    };
  };
  if(options.alreadyBlocked)header.append(new Element('button',{},'Unblock'));
  if(options.feedOnly){more.remove();identity.remove();article.append(new Element('h2',{},'victim'));}
  const adapter=Adapter.createAdapter({document:doc,href:()=>location,getComputedStyle:()=>({}),now:()=>time,delay:async ms=>{time+=ms;},token:()=>`nonce-${time}`});
  const args={username:'victim',actorUsername:'owner'};
  return {doc,nav,actor,main,header,more,identity,adapter,args,get dialog(){return dialog;},get confirmButton(){return confirmButton;},counts:()=>({finalClicks,menuClicks,optionClicks}),setLocation:value=>{location=value;}};
}

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
test('confirm requires its prepare token and verifies the profile unblock control',async()=>{
  const f=fixture(),p=await f.adapter.perform({...f.args,phase:'prepare'}),r=await f.adapter.perform({...f.args,phase:'confirm',confirmationToken:p.confirmationToken});assert.equal(r.status,'success');assert.equal(f.counts().finalClicks,1);
  const repeat=await f.adapter.perform({...f.args,phase:'confirm',confirmationToken:p.confirmationToken});assert.equal(repeat.status,'needs-attention');assert.equal(f.counts().finalClicks,1);
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
