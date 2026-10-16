import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createD1Adapter, cloudFailureCode, logCloudDiagnostic } from '../bot/d1.mjs';
import { CLOUD_HANDLER_MS, createWebhook, createCloudRuntime, health, readConfiguration } from '../bot/webhook.mjs';
import { SQL_SCHEMA, Store } from '../bot/core/store.js';
import { REPORT_CACHE_SCHEMA } from '../bot/report-cache.mjs';
const CHAT=-1004393474895;
const configuration={BOT_TOKEN:`123456:${'fixture_'.repeat(4)}`,FACEIT_API_KEY:'fixture-faceit-key-123456',TS_ENCRYPTION_KEY:'12'.repeat(32),WEBHOOK_SECRET:'fixture_'.repeat(6)};
function database(t){
 const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());for(const statement of [...SQL_SCHEMA,...REPORT_CACHE_SCHEMA])sql.exec(statement);
 const binding={prepare(query){const stmt=sql.prepare(query);const bound=(values=[])=>({bind(...next){return bound(next);},async run(){const result=stmt.run(...values);return{meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};},async first(){return stmt.get(...values)??null;},async all(){return{results:stmt.all(...values)};}});return bound();}};
 return{sql,binding};
}
function request(value={update_id:1},secret=configuration.WEBHOOK_SECRET){return new Request('https://example.test/api/telegram/webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':secret},body:JSON.stringify(value)});}
test('D1 adapter runs the shared Store with bound values and persisted lease/checkpoints',async t=>{
 const {binding}=database(t);const adapter=createD1Adapter(binding);const store=new Store(adapter,()=>1800000000);
 assert.equal(await store.claimDelivery('update-1',CHAT,null,'stats'),true);assert.equal(await store.claimDelivery('update-1',CHAT,null,'stats'),false);
 await store.createJob('job',CHAT,7,{kind:'stats'});assert.equal(await store.leaseJob('job',0),true);await store.saveJob('job',0,{kind:'stats',phase:'done'},'ready');assert.equal((await store.getJob('job')).version,1);
 await assert.rejects(adapter.get('SELECT :missing',{}),/CLOUD_DATABASE_BINDING/);
});
test('configuration and health expose no secrets',async()=>{
 assert.deepEqual(readConfiguration(configuration),{});for(const key of ['BOT_TOKEN','FACEIT_API_KEY','TS_ENCRYPTION_KEY','WEBHOOK_SECRET'])assert.throws(()=>readConfiguration({...configuration,[key]:''}),/CLOUD_CONFIGURATION/);
 const body=JSON.stringify(await health({...configuration,DB:{}}).json());assert.ok(!body.includes(configuration.BOT_TOKEN));assert.equal(JSON.parse(body).configured,true);assert.equal((await health({}).json()).configured,false);
});
test('legacy ALLOWED_CHAT_IDS is ignored rather than parsed or enforced',()=>{
 for(const legacy of ['[]','[-42]','invalid-json','[0,1]','null']) assert.deepEqual(readConfiguration({...configuration,ALLOWED_CHAT_IDS:legacy}),{});
});
test('cloud runtime accepts an unknown basic group or supergroup despite legacy allowlist',async t=>{
 const {sql,binding}=database(t);const messages=[];
 const runtime=createCloudRuntime({...configuration,ALLOWED_CHAT_IDS:'[-42]',DB:binding},{
  fetch:async(url,options)=>{
   const method=new URL(url).pathname.split('/').at(-1);const params=JSON.parse(options.body);
   if(method==='getChatMember')return Response.json({ok:true,result:{status:'member'}});
   assert.ok(['setMyCommands','sendMessage'].includes(method));if(method==='sendMessage')messages.push(params);
   return Response.json({ok:true,result:method==='setMyCommands'?true:{message_id:10}});
  },onMetrics:()=>{},onCacheEvent:()=>{},onDiagnostic:()=>{},
 });
 for(const [index,type] of ['group','supergroup'].entries()){
  const id=index===0?-12345:-1004418477887;
  await runtime({update_id:2000+index,message:{message_id:2000+index,chat:{id,type},from:{id:9,is_bot:false},text:'/menu'}});
  assert.equal(messages.at(-1).chat_id,id);
 }
 assert.equal(messages.length,2);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n,2);
});
test('webhook rejects unauthenticated and malformed requests before processing',async()=>{
 let handled=0;const handle=createWebhook({getEnv:()=>({...configuration,DB:{}}),getRuntime:()=>async()=>{handled++;}});
 assert.equal((await handle(request({},'bad'))).status,403);assert.equal((await handle(request({},'é'.repeat(configuration.WEBHOOK_SECRET.length)))).status,403);
 assert.equal((await handle(new Request('https://example.test'))).status,405);
 assert.equal((await handle(request({update_id:-1}))).status,400);
 assert.equal((await handle(request({update_id:1,text:'x'.repeat(66000)}))).status,413);
 assert.equal(handled,0);
});
test('webhook awaits successful handler and returns only sanitized errors',async()=>{
 let completed=false;const environment={...configuration,DB:{}};
 const handle=createWebhook({getEnv:()=>environment,getRuntime:()=>async()=>{await new Promise(resolve=>setTimeout(resolve,5));completed=true;}});
 assert.equal((await handle(request())).status,200);assert.equal(completed,true);
 const fail=createWebhook({getEnv:()=>environment,getRuntime:()=>async()=>{throw new Error(configuration.BOT_TOKEN);}});
 const result=await fail(request());assert.equal(result.status,503);assert.ok(!(await result.text()).includes(configuration.BOT_TOKEN));
});
for(const kind of ['last','stats'])test(`cloud ${kind} webhook returns a Dark PNG without text and deduplicates redelivery`,async t=>{
 const {sql,binding}=database(t);const environment={...configuration,DB:binding};const messages=[];let calls=0;
 const now=Math.floor(Date.now()/1000);const matches=Array.from({length:kind==='last'?1:30},(_,i)=>({match_id:`fixture-${i}`,game_id:'cs2',game:'cs2',status:'FINISHED',finished_at:now-1000-i*86400,best_of:1,teams:{faction1:{faction_id:'a',name:'Own',roster:[{player_id:'p',nickname:'Player'}]},faction2:{faction_id:'b',name:'Other',roster:[{player_id:'q',nickname:'Other'}]}},results:{winner:'faction1',score:{faction1:1,faction2:0}}}));
 const fetch=async(url,options)=>{
  const target=new URL(url);calls++;
  if(target.origin==='https://api.telegram.org'){
   const method=target.pathname.split('/').at(-1);messages.push(method);
   if(method==='getMe')return Response.json({ok:true,result:{id:999,username:'road_to_3_elo_bot'}});
   if(method==='getChatMember')return Response.json({ok:true,result:{status:'administrator'}});
   if(method==='sendPhoto'){assert.ok(options.body instanceof FormData);assert.equal(options.body.get('caption'),null);const photo=options.body.get('photo');assert.ok(photo.size<500000);assert.ok(photo.size>1000);return Response.json({ok:true,result:{message_id:99}});}
   assert.fail('Unexpected Telegram method');
  }
  assert.equal(target.origin,'https://open.faceit.com');
  if(target.pathname.endsWith('/players'))return Response.json({player_id:'p',nickname:'Player',games:{cs2:{faceit_elo:1710,skill_level:8}}});
  if(target.pathname.endsWith('/history')){const from=Number(target.searchParams.get('from'));return Response.json({items:matches.filter(m=>m.finished_at>=from)});}
  const match=matches.find(m=>target.pathname.includes(`/matches/${m.match_id}`));assert.ok(match);
  if(!target.pathname.endsWith('/stats'))return Response.json(match);
  return Response.json({rounds:[{match_id:match.match_id,game_id:'cs2',match_round:1,round_stats:{Map:'de_inferno',Rounds:'21',Winner:'a'},teams:[{team_id:'a',team_stats:{'Final Score':'13'},players:[{player_id:'p',nickname:'Player',player_stats:{Kills:'20',Deaths:'11',Assists:'5',Headshots:'5','Total Damage':'2100'}}]},{team_id:'b',team_stats:{'Final Score':'8'},players:[{player_id:'q',nickname:'Other',player_stats:{Kills:'11',Deaths:'20',Assists:'1'}}]}]}]});
 };
 const handle=createWebhook({getEnv:()=>environment,getRuntime:env=>createCloudRuntime(env,{fetch})});
 const update={update_id:701,message:{message_id:5,chat:{id:CHAT,type:'supergroup'},from:{id:123,is_bot:false},text:`/${kind} Player`}};
 assert.equal((await handle(request(update))).status,200);assert.equal((await handle(request(update))).status,200);
 assert.equal(messages.filter(m=>m==='sendPhoto').length,1);assert.ok(!messages.includes('sendMessage'));
 const row=sql.prepare('SELECT status,state FROM report_jobs').get();assert.equal(row.status,'ready');assert.equal(JSON.parse(row.state).matches.length,kind==='last'?1:30);assert.ok(calls<90);
});

function menuUpdate(id, user = 123) {
 return {update_id:id,message:{message_id:id,chat:{id:CHAT,type:'supergroup'},from:{id:user,is_bot:false},text:'/menu'}};
}
function fakeTimer() {
 const callbacks=[];const cleared=[];
 return {callbacks,cleared,setTimer(callback,milliseconds){callbacks.push({callback,milliseconds});return callbacks.length-1;},clearTimer(timer){cleared.push(timer);}};
}
test('absolute invocation deadline blocks new egress after awaited D1 operations',async t=>{
 const {binding}=database(t);let clock=0;const methods=[];
 const prepare=binding.prepare.bind(binding);
 binding.prepare=query=>{
  const statement=prepare(query);const bind=statement.bind;
  statement.bind=(...values)=>{
   const bound=bind(...values);const run=bound.run;
   bound.run=async()=>{const result=await run();if(query.includes('INSERT INTO deliveries'))clock=CLOUD_HANDLER_MS+1;return result;};
   return bound;
  };
  return statement;
 };
 const timer=fakeTimer();
 const runtime=createCloudRuntime({...configuration,DB:binding},{...timer,now:()=>clock,fetch:async(url)=>{
  const method=new URL(url).pathname.split('/').at(-1);methods.push(method);
  assert.equal(method,'getChatMember');return Response.json({ok:true,result:{status:'administrator'}});
 }});
 await assert.rejects(runtime(menuUpdate(810)));
 assert.deepEqual(methods,['getChatMember']);assert.equal(timer.callbacks[0].milliseconds,CLOUD_HANDLER_MS);assert.deepEqual(timer.cleared,[0]);
});
test('deadline aborts an already pending HTTP request and prevents fallback egress',async t=>{
 const {binding}=database(t);const timer=fakeTimer();let signal;let calls=0;
 const runtime=createCloudRuntime({...configuration,DB:binding},{...timer,now:()=>0,fetch:async(_url,options)=>{
  calls++;signal=options.signal;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Stopped','AbortError')),{once:true}));
 }});
 const outcome=runtime(menuUpdate(811)).then(()=>false,()=>true);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);assert.equal(signal.aborted,false);
 timer.callbacks[0].callback();assert.equal(await outcome,true);assert.equal(signal.aborted,true);assert.equal(calls,1);
});
test('concurrent updates have independent deadline controllers and retain awaited execution',async t=>{
 const {binding}=database(t);const timer=fakeTimer();const members=new Map();
 const runtime=createCloudRuntime({...configuration,DB:binding},{...timer,now:()=>0,fetch:async(url,options)=>{
  const method=new URL(url).pathname.split('/').at(-1);
  if(method==='getChatMember'){
   const user=JSON.parse(options.body).user_id;
   return new Promise((resolve,reject)=>{members.set(user,{signal:options.signal,resolve:()=>resolve(Response.json({ok:true,result:{status:'administrator'}}))});options.signal.addEventListener('abort',()=>reject(new DOMException('Stopped','AbortError')),{once:true});});
  }
  assert.ok(['setMyCommands','sendMessage'].includes(method));return Response.json({ok:true,result:method==='setMyCommands'?true:{message_id:1}});
 }});
 const first=runtime(menuUpdate(812,1)).then(()=>false,()=>true);const second=runtime(menuUpdate(813,2));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(members.size,2);
 timer.callbacks[0].callback();assert.equal(await first,true);assert.equal(members.get(2).signal.aborted,false);
 members.get(2).resolve();await second;assert.equal(members.get(2).signal.aborted,true);assert.deepEqual(timer.cleared.sort(),[0,1]);
});
test('webhook body read consumes the original 90-second budget and cannot restart it',async t=>{
 const {binding}=database(t);let clock=0;let calls=0;let body;
 const stream=new ReadableStream({start(controller){body=controller;}});
 const incoming=new Request('https://example.test/api/telegram/webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':configuration.WEBHOOK_SECRET},body:stream,duplex:'half'});
 const environment={...configuration,DB:binding};
 const handle=createWebhook({getEnv:()=>environment,now:()=>clock,getRuntime:env=>createCloudRuntime(env,{now:()=>clock,fetch:async()=>{calls++;throw new Error('No late egress allowed');}})});
 const result=handle(incoming);clock=CLOUD_HANDLER_MS+1;body.enqueue(new TextEncoder().encode(JSON.stringify(menuUpdate(814))));body.close();
 assert.equal((await result).status,503);assert.equal(calls,0);
});

test('diagnostics emit only whitelisted codes and never raw secret-bearing errors',async()=>{
 const secret=configuration.BOT_TOKEN;const output=[];const previous=console.error;
 try{
  console.error=value=>output.push(value);
  logCloudDiagnostic(secret,secret);
  logCloudDiagnostic(cloudFailureCode(new TypeError(`Illegal invocation ${secret}`)),'telegram');
  const adapter=createD1Adapter({prepare(){throw new Error(`D1_ERROR: no such table: ${secret}`);}});
  await assert.rejects(adapter.get('SELECT 1'),/CLOUD_DATABASE_SCHEMA/);
 }finally{console.error=previous;}
 assert.equal(output.length,3);assert.ok(!JSON.stringify(output).includes(secret));
 assert.deepEqual(output.map(value=>JSON.parse(value).code),['CLOUD_UNEXPECTED','CLOUD_FETCH_RECEIVER','CLOUD_DATABASE_SCHEMA']);
});
test('unavailable AbortSignal features fail safely with an explicit diagnostic',async t=>{
 const {binding}=database(t);const diagnostics=[];let calls=0;const original=AbortSignal.any;
 const runtime=createCloudRuntime({...configuration,DB:binding},{fetch:async()=>{calls++;throw new Error(configuration.BOT_TOKEN);},onDiagnostic:code=>diagnostics.push(code)});
 try{
  AbortSignal.any=undefined;
  await assert.rejects(runtime(menuUpdate(815)));
 }finally{AbortSignal.any=original;}
 assert.equal(calls,0);assert.ok(diagnostics.includes('CLOUD_ABORT_UNSUPPORTED'));assert.ok(!JSON.stringify(diagnostics).includes(configuration.BOT_TOKEN));
});
test('webhook resolves a fresh runtime even when the environment object is reused',async()=>{
 const environment={...configuration,DB:{}};let created=0;
 const handle=createWebhook({getEnv:()=>environment,getRuntime:()=>{created++;return async()=>{};}});
 assert.equal((await handle(request({update_id:816}))).status,200);
 assert.equal((await handle(request({update_id:817}))).status,200);
 assert.equal(created,2);
});

function coldStatsWithClock(t, { initialDelay = 0, readMs = 450, rateLimit = false } = {}) {
 const {sql,binding}=database(t);const base=1800000000000;let clock=base+initialDelay;
 // Keep legacy implicit clocks under test too: the former 25-second setting
 // must reproduce the real pause instead of passing under instant mock I/O.
 const originalDateNow=Date.now;Date.now=()=>clock;t.after(()=>{Date.now=originalDateNow;});
 const calls=[];const metrics=[];const methods=[];const timer=fakeTimer();
 const prepare=binding.prepare.bind(binding);
 binding.prepare=query=>{
  const original=prepare(query);
  const wrap=statement=>Object.fromEntries(Object.entries(statement).map(([name,fn])=>[name,name==='bind'? (...args)=>wrap(fn(...args)) : async(...args)=>{const result=await fn(...args);clock+=120;return result;}]));
  return wrap(original);
 };
 const item=i=>({match_id:`slow-${i}`,game_id:'cs2',game:'cs2',status:'FINISHED',finished_at:base/1000-1000-i*86400,best_of:1,
  teams:{faction1:{faction_id:'a',name:'Own',roster:[{player_id:'p',nickname:'Player'}]},faction2:{faction_id:'b',name:'Other',roster:[{player_id:'q',nickname:'Other'}]}},results:{winner:'faction1',score:{faction1:1,faction2:0}}});
 const matches=Array.from({length:30},(_,i)=>item(i));
 const fetch=async(url,options)=>{
  const target=new URL(url);const started=clock;
  if(target.origin==='https://api.telegram.org'){
   const method=target.pathname.split('/').at(-1);methods.push({method,started});clock+=250;
   if(method==='getMe')return Response.json({ok:true,result:{id:999,username:'road_to_3_elo_bot'}});
   if(method==='getChatMember')return Response.json({ok:true,result:{status:'member'}});
   assert.equal(method,'sendPhoto');assert.ok(options.body instanceof FormData);assert.equal(options.body.get('caption'),null);
   return Response.json({ok:true,result:{message_id:99}});
  }
  assert.equal(target.origin,'https://open.faceit.com');calls.push({path:target.pathname,started});clock+=readMs;
  if(target.pathname.endsWith('/players'))return Response.json({player_id:'p',nickname:'Player',games:{cs2:{faceit_elo:1710,skill_level:8}}});
  if(target.pathname.endsWith('/history'))return Response.json({items:matches});
  const match=matches.find(m=>target.pathname.includes(`/matches/${m.match_id}`));assert.ok(match);
  if(!target.pathname.endsWith('/stats'))return Response.json(match);
  if(rateLimit)return Response.json({}, {status:429,headers:{'retry-after':'120'}});
  return Response.json({rounds:[{match_id:match.match_id,game_id:'cs2',match_round:1,round_stats:{Map:'de_inferno',Rounds:'21',Winner:'a'},teams:[
   {team_id:'a',team_stats:{'Final Score':'13'},players:[{player_id:'p',nickname:'Player',player_stats:{Kills:'20',Deaths:'11',Assists:'5',Headshots:'5','Total Damage':'2100'}}]},
   {team_id:'b',team_stats:{'Final Score':'8'},players:[{player_id:'q',nickname:'Other',player_stats:{Kills:'11',Deaths:'20',Assists:'1'}}]},
  ]}]});
 };
 const runtime=createCloudRuntime({...configuration,DB:binding},{...timer,now:()=>clock,fetch,onDiagnostic:()=>{},onMetrics:value=>metrics.push(value),onCacheEvent:()=>{}});
 return {sql,calls,methods,metrics,base,clock:()=>clock,run:()=>runtime({update_id:950,message:{message_id:950,chat:{id:CHAT,type:'supergroup'},from:{id:123,is_bot:false},text:'/stats Player'}},{startedAt:base})};
}

test('ordinary cold 30-match report crossing 25 seconds completes in one update with fewer D1 checkpoints',async t=>{
 const h=coldStatsWithClock(t);await h.run();
 const row=h.sql.prepare('SELECT status,state FROM report_jobs').get();assert.equal(row.status,'ready');assert.equal(JSON.parse(row.state).matches.length,30);
 assert.equal(h.calls.length,62);assert.ok(h.metrics[0].elapsedMs>25000);assert.ok(h.metrics[0].elapsedMs<65000);
 assert.ok(h.metrics[0].databaseCalls<50);assert.deepEqual(h.methods.filter(x=>x.method==='sendPhoto').length,1);
 assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE kind='notice'").get().n,0);
 assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE kind='photo' AND status='sent'").get().n,1);
});

test('work budget includes initial webhook delay and stops new FACEIT reads before the 90-second delivery deadline',async t=>{
 const h=coldStatsWithClock(t,{initialDelay:50000,readMs:1500});await h.run();
 assert.ok(h.calls.length>2 && h.calls.length<62);
 assert.ok(h.calls.every(c=>c.started<h.base+65000));
 const row=h.sql.prepare('SELECT status,state FROM report_jobs').get();assert.equal(row.status,'pending');assert.ok(JSON.parse(row.state).matches.length<30);
 const photo=h.methods.find(x=>x.method==='sendPhoto');assert.ok(photo);assert.ok(photo.started<h.base+CLOUD_HANDLER_MS);
 assert.ok(h.clock()<h.base+CLOUD_HANDLER_MS);
 assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE kind='notice' AND status='sent'").get().n,1);
});

test('expanded cloud budget still checkpoints and pauses immediately for FACEIT Retry-After',async t=>{
 const h=coldStatsWithClock(t,{rateLimit:true});await h.run();
 const row=h.sql.prepare('SELECT status,state FROM report_jobs').get();const state=JSON.parse(row.state);
 assert.equal(row.status,'pending');assert.equal(h.calls.filter(c=>c.path.endsWith('/stats')).length,1);
 assert.ok(state.retryAt>Math.floor(h.clock()/1000));assert.equal(state.phase,'stats');
 assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE kind='notice' AND status='sent'").get().n,1);
});
