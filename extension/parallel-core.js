(function(root){
  'use strict';
  const USER=/^[A-Za-z0-9._]{1,30}$/, ID=/^[1-9][0-9]{0,29}$/;
  function profileFromScripts(scripts,username,origin='https://www.threads.com') {
    if(!USER.test(username)||origin!=='https://www.threads.com')throw new Error('profile-input');
    const found=[];let visited=0,parsed=0;
    for(const source of scripts.slice(0,150)) {
      if(typeof source!=='string'||source.length>4*1024*1024)continue;
      let value;try{value=JSON.parse(source);parsed++;}catch{continue;}
      const stack=[value];
      while(stack.length) {
        if(++visited>150000)throw new Error('profile-data-limit');
        const node=stack.pop();if(!node||typeof node!=='object')continue;
        const route=node.initialRouteInfo?.route;
        if(route?.tracePolicy==='barcelona.profilePage') {
          let url;try{url=new URL(route.url,origin);}catch{url=null;}
          if(url?.origin===origin&&decodeURIComponent(url.pathname).toLowerCase()==='/@'+username.toLowerCase()) {
            const vanity=route.params?.vanity;
            if(vanity!==undefined&&String(vanity).replace(/^@/,'').toLowerCase()!==username.toLowerCase())throw new Error('profile-name-mismatch');
            const props=[route.rootView?.props,route.hostableView?.props].filter(Boolean);
            for(const item of props) {
              if((typeof item.user_id!=='string'&&!Number.isSafeInteger(item.user_id))||(typeof route.actorID!=='string'&&!Number.isSafeInteger(route.actorID)))throw new Error('profile-id-precision');
              if(!ID.test(String(item.user_id))||typeof item.is_self_profile!=='boolean'||!/^\d{1,30}$/.test(String(route.actorID)))throw new Error('profile-schema');
              found.push({username,userId:String(item.user_id),actorId:String(route.actorID),isSelf:item.is_self_profile});
            }
          }
        }
        for(const child of Object.values(node))if(child&&typeof child==='object')stack.push(child);
      }
    }
    const identities=new Map(found.map(row=>[`${row.userId}:${row.actorId}:${row.isSelf}`,row]));
    if(identities.size!==1)throw new Error(identities.size?'profile-id-ambiguous':'profile-id-not-found');
    return {...identities.values().next().value,diagnostics:{jsonScripts:parsed,routeCandidates:found.length}};
  }
  function profileFromHTML(html,username,Parser=root.DOMParser) {
    if(typeof html!=='string'||html.length>8*1024*1024)throw new Error('profile-size');
    const doc=new Parser().parseFromString(html,'text/html');
    return profileFromScripts([...doc.querySelectorAll('script[type="application/json"]')].map(node=>node.textContent),username);
  }
  function copyBody(body) {
    if(typeof body==='string')return new URLSearchParams(body);
    if(body instanceof URLSearchParams)return new URLSearchParams(body);
    if(root.FormData&&body instanceof root.FormData){const copy=new root.FormData();for(const [key,value]of body){if(typeof value!=='string')throw new Error('binary-body');copy.append(key,value);}return copy;}
    throw new Error('body-format');
  }
  function forUser(body,userId) {
    if(!ID.test(userId))throw new Error('target-id');
    const copy=copyBody(body),variables=JSON.parse(copy.get('variables'));
    if(!variables||typeof variables!=='object'||Array.isArray(variables)||!Object.hasOwn(variables,'user_id'))throw new Error('variables');
    variables.user_id=userId;copy.set('variables',JSON.stringify(variables));
    return typeof body==='string'?copy.toString():copy;
  }
  const api=Object.freeze({profileFromScripts,profileFromHTML,copyBody,forUser});root.ThreadsParallelCore=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);
