const test = require('node:test');
const assert = require('node:assert/strict');
const Job = require('../extension/job.js');
const now = '2026-11-02T06:00:00.000Z';
const later = '2026-11-02T06:00:05.000Z';
const account = username => ({username,profileUrl:`https://www.threads.com/@${username}`});
function input(overrides={}) {return {id:'test-job',accounts:[account('Alice'),account('alice'),account('Bob'),account('Author'),account('ME')],target:{url:'https://www.threads.com/@author/post/TEST',kind:'reply'},actorUsername:'me',sourceTabId:7,includeAuthor:false,...overrides};}
const make = overrides => Job.createJob(input(overrides),now);

test('create removes author unless opted in, deduplicates and excludes actor',()=>{
  const original=input(),before=JSON.stringify(original),j=Job.createJob(original,now);
  assert.deepEqual(j.items.map(i=>i.username),['Alice','Bob']);assert.equal(j.includeAuthor,false);assert.equal(j.target.kind,'reply');assert.equal(j.current,null);assert.equal(j.status,'running');assert.equal(j.id,'test-job');assert.equal(JSON.stringify(original),before);
});
test('author opt-in adds exactly one author with a separate role',()=>{
  const j=make({includeAuthor:true});assert.deepEqual(j.items.map(i=>[i.username,i.role]),[['Alice','liker'],['Bob','liker'],['author','author']]);
  assert.ok(!make({includeAuthor:true,actorUsername:'AUTHOR'}).items.some(i=>i.role==='author'));
  assert.equal(make({includeAuthor:'true'}).includeAuthor,false);
});
test('create rejects invalid actors, source tabs, target identities and mismatched profile URLs',()=>{
  for(const overrides of [{actorUsername:'bad/user'},{sourceTabId:-1},{target:'https://evil.test/@author/post/TEST'},{target:{url:'https://www.threads.com/@author/post/TEST',username:'different'}},{target:{url:'https://www.threads.com/@author/post/TEST',postId:'OTHER'}},{accounts:[{username:'alice',profileUrl:'https://www.threads.com/@bob'}]},{accounts:[{username:'alice',profileUrl:'https://evil.test/@alice'}]}])assert.throws(()=>make(overrides));
  assert.equal(make({actorUsername:' @me '}).actorUsername,'me');
});
test('empty selection and more than 10000 eligible unique accounts are rejected',()=>{
  assert.throws(()=>make({accounts:[account('me'),account('author')]}),/No eligible/);
  assert.throws(()=>make({accounts:Array.from({length:10001},(_,i)=>account('person'+i))}),/10000/);
});
test('next dispatches only once and does not mutate the previous snapshot',()=>{
  const j=make(),n=Job.nextItem(j,later);assert.equal(j.current,null);assert.equal(j.items[0].attempts,0);assert.equal(n.current,'Alice');assert.equal(n.items[0].status,'in-progress');assert.equal(n.items[0].attempts,1);assert.deepEqual(Job.nextItem(n,later),n);
});
test('results must match the current account and use known status values',()=>{
  const j=Job.nextItem(make(),now);assert.throws(()=>Job.recordResult(j,'Bob',{status:'success'},later));assert.throws(()=>Job.recordResult(j,'Alice',{status:'done'},later));
  const evidence={visible:true},next=Job.recordResult(j,'alice',{status:'success',evidence},later);evidence.visible=false;assert.equal(next.items[0].evidence.visible,true);assert.equal(j.current,'Alice');assert.equal(next.current,null);
});
test('success, already-blocked, skipped and failed move forward without retrying',()=>{
  for(const status of ['success','already-blocked','skipped','failed']) {
    const j=Job.recordResult(Job.nextItem(make(),now),'Alice',{status,reason:'test'},later);
    const n=Job.nextItem(j,later);assert.equal(n.current,'Bob');assert.equal(n.items[0].status,status);assert.equal(n.items[0].attempts,1);
    const done=Job.recordResult(n,'Bob',{status:'success'},later);assert.equal(done.status,'completed');assert.equal(Job.nextItem(done,later).current,null);
  }
});
test('unknown or needs-attention pauses and requires an explicit resume without retry',()=>{
  for(const status of ['unknown','needs-attention']) {
    const j=Job.recordResult(Job.nextItem(make(),now),'Alice',{status,reason:'manual check'},later);
    assert.equal(j.status,'paused');assert.equal(j.reason,'manual check');assert.equal(Job.nextItem(j,later).current,null);
    const n=Job.nextItem(Job.resume(j,later),later);assert.equal(n.current,'Bob');assert.equal(n.items[0].status,status);
  }
});
test('pause keeps an in-flight item, blocks next dispatch, and accepts a late result',()=>{
  const before=Job.nextItem(make(),now),paused=Job.pause(before,later);assert.equal(paused.current,'Alice');assert.equal(paused.status,'paused');assert.equal(Job.nextItem(paused,later).current,'Alice');
  assert.equal(Job.resume(paused,later).status,'paused');
  const settled=Job.recordResult(paused,'Alice',{status:'success'},later);assert.equal(settled.status,'paused');assert.equal(settled.current,null);
  assert.equal(Job.nextItem(Job.resume(settled,later),later).current,'Bob');assert.equal(before.status,'running');
});
test('stop cancels queued items, marks current unknown and never resumes',()=>{
  const j=Job.nextItem(make(),now),stopped=Job.stop(j,later);assert.equal(stopped.status,'stopped');assert.equal(stopped.items[0].status,'unknown');assert.equal(stopped.items[1].status,'cancelled');assert.equal(stopped.current,'Alice');assert.equal(Job.resume(stopped,later).status,'stopped');
  const settled=Job.recordResult(stopped,'Alice',{status:'success'},later);assert.equal(settled.items[0].status,'success');assert.equal(settled.status,'stopped');assert.equal(settled.current,null);assert.equal(Job.nextItem(settled,later).status,'stopped');assert.equal(j.items[1].status,'pending');
});
test('restart recovery marks in-flight results unknown and never automatically runs',()=>{
  const j=Job.nextItem(make(),now),recovered=Job.recover(j,later);assert.equal(recovered.status,'paused');assert.equal(recovered.current,null);assert.equal(recovered.items[0].status,'unknown');assert.equal(recovered.items[1].status,'pending');assert.equal(Job.nextItem(recovered,later).current,null);
  assert.equal(Job.nextItem(Job.resume(recovered,later),later).current,'Bob');assert.equal(j.items[0].status,'in-progress');
  assert.equal(Job.recover(Job.stop(j,later),later).status,'stopped');
});
test('recovering running work with no dispatch still requires resume; terminal work stays terminal',()=>{
  assert.equal(Job.recover(make(),later).status,'paused');const stopped=Job.stop(make(),later);assert.deepEqual(Job.recover(stopped,later),stopped);
});
test('inconsistent previously dispatched pending items are never retried',()=>{
  const j=make();j.items[0].attempts=1;const n=Job.nextItem(j,later);assert.equal(n.status,'paused');assert.equal(n.current,null);assert.equal(n.items[0].status,'unknown');assert.equal(n.items[0].attempts,1);
  const bad=make();bad.items[0].status='in-progress';const safe=Job.nextItem(bad,later);assert.equal(safe.status,'paused');assert.equal(safe.current,null);
});
test('safe preparation deferral restores pending eligibility only after explicit resume',()=>{
  const j=Job.pause(Job.nextItem(make(),now),later),deferred=Job.deferPrepared(j,'Alice','Paused before final confirmation',later);
  assert.equal(deferred.status,'paused');assert.equal(deferred.current,null);assert.equal(deferred.items[0].status,'pending');assert.equal(deferred.items[0].attempts,0);assert.equal(deferred.items[0].startedAt,null);assert.equal(deferred.items[0].preparationsDeferred,1);assert.equal(j.current,'Alice');
  assert.equal(Job.nextItem(deferred,later).current,null);
  const next=Job.nextItem(Job.resume(deferred,later),later);assert.equal(next.current,'Alice');assert.equal(next.items[0].attempts,1);assert.equal(next.items[0].preparationsDeferred,1);
});
test('preparation deferral validates current identity, never retries unknown and leaves stopped jobs alone',()=>{
  const running=Job.nextItem(make(),now);assert.throws(()=>Job.deferPrepared(running,'Bob','bad',later));
  const unknown=Job.recordResult(running,'Alice',{status:'unknown'},later);assert.throws(()=>Job.deferPrepared(unknown,'Alice','cannot know',later));
  const stopped=Job.stop(running,later);assert.deepEqual(Job.deferPrepared(stopped,'Alice','ignored',later),stopped);
  const deferred=Job.deferPrepared(running,'Alice','No final click sent',later);assert.equal(deferred.status,'paused');
});
