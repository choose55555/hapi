const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');

test('就绪/权限真实结束后继续原队列，不要求再来一条手机消息',async()=>{
 const h=fixture({onPause:h=>{h.ready(true);h.blocked(false);}});
 h.ready(false);h.blocked(true);await h.drain();
 assert.deepEqual(h.consumed,['one']);assert.equal(h.writes.length,2);
});
test('启动超时后下一次就绪触发可重试同一条保留消息',async()=>{
 const h=fixture();h.ready(false);await h.drain();assert.equal(h.queue.size(),1);
 h.ready(true);await h.drain();assert.deepEqual(h.consumed,['one']);
});
test('aborted发生于任何按键之前：保留原消息并通知',async()=>{
 const h=fixture();h.controller.abort();await h.drain();
 assert.equal(h.writes.length,0);assert.equal(h.queue.size(),1);assert.match(h.events.at(-1),/aborted/);
});
import assert from 'node:assert/strict';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { createLocalMessageDrain, requiresRemoteSwitch } from './localMessageDrain.ts';
import { ConsoleMessageInjector, buildMessageKeyRecords, encodeInputRecords, decodeInputRecords } from './consoleInject.ts';
const mode = {permissionMode:'default'};
function fixture(overrides = {}) {
 const queue = new MessageQueue2(() => 'mode');
 queue.push('hello\r\nworld', mode, 'one');
 const events=[], echoes=[], discarded=[], consumed=[], writes=[];
 queue.onBatchConsumed = ids => consumed.push(...ids);
 const controller = new AbortController();
 let ready=true, blocked=false, exited=false, tick=0;
 const injector = new ConsoleMessageInjector({
   platform:'win32', isProcessAlive:()=>!exited, abortSignal:controller.signal, stashDelayMs:0, sleep:async()=>{},
   ffi:{openConin:()=>1,closeHandle:()=>true,writeConsoleInput:(_h,_b,n)=>{writes.push(n); return n;}},
   ...overrides.injectorOptions
 });
 const options = {
   queue, injector, signal:controller.signal,
   client:{notePendingHubPromptEcho:(text,ids)=>echoes.push({text,ids,writes:writes.length}),
     discardPendingHubPromptEcho:id=>discarded.push(id),sendSessionEvent:e=>events.push(e.message)},
   isReady:()=>ready,isPermissionBlocked:()=>blocked,isExited:()=>exited,
   now:()=>tick,timeoutMs:100,pause:async()=>{tick+=50; await overrides.onPause?.(h);},
   platform:'win32',
   ...overrides.options
 };
 const drain=createLocalMessageDrain(options);
 const h={queue,drain,events,echoes,discarded,consumed,writes,controller,
    now:()=>tick,ready:v=>ready=v,blocked:v=>blocked=v,exit:()=>exited=true};
 return h;
}
test('普通附件/非文字保持切换，正文路径字符串不是附件身份',async()=>{
 assert.equal(requiresRemoteSwitch({message:'x',mode:{...mode,hasAttachments:true}}),true);
 assert.equal(requiresRemoteSwitch({message:'x',mode:{...mode,nonTextContent:true}}),true);
 assert.equal(requiresRemoteSwitch({message:'attachment/path.txt',mode}),false);
 const h=fixture();h.queue.queue[0].mode={...mode,hasAttachments:true};
 assert.equal(await h.drain(),'handled');assert.equal(h.writes.length,0);assert.equal(h.queue.size(),0);
 assert.match(h.events.at(-1),/\[local-console one\].*请在电脑上发/);
 assert.match(h.events.at(-1),/窗口未重开/);
 assert.deepEqual(h.consumed,[]);
 assert.equal(h.queue.cancelByLocalId('one'),false);
});

test('不传处理入口：已有队列不启动直接切换，新消息也保持原切换',async()=>{
 const {BaseLocalLauncher}=await import('../../modules/common/launcher/BaseLocalLauncher.ts');
 const make=(queue,launch)=>new BaseLocalLauncher({
  label:'test',failureLabel:'failed',queue,rpcHandlerManager:{registerHandler(){}},
  launch,sendFailureMessage:()=>{},recordLocalLaunchFailure:()=>{}
 });
 let launched=0;
 const q1=new MessageQueue2(()=> 'mode');q1.push('x',mode,'x');
 assert.equal(await make(q1,async()=>{launched++;}).run(),'switch');assert.equal(launched,0);
 const q2=new MessageQueue2(()=> 'mode');
 const runner=make(q2,async signal=>{
   launched++;
   q2.push('x',mode,'x');
   if(!signal.aborted) await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
 });
 assert.equal(await runner.run(),'switch');assert.equal(launched,1);assert.equal(q2.size(),1);
});
test('成功：注入前登记规范化回显，提交预留并发消费通知',async()=>{
 const h=fixture();await h.drain();
 assert.deepEqual(h.echoes,[{text:'hello\nworld',ids:['one'],writes:0}]);
 assert.deepEqual(h.consumed,['one']);assert.equal(h.queue.size(),0);
 assert.equal(h.queue.cancelByLocalId('one'),'consumed');
});
test('启动未就绪：超时不注入，恢复队首，不切换',async()=>{
 const h=fixture();h.ready(false);
 assert.equal(await h.drain(),'handled');assert.equal(h.writes.length,0);
 assert.equal(h.queue.queue[0].localId,'one');assert.match(h.events.at(-1),/timeout/);
});
test('钩子已返回但原生确认仍在：阻塞至超时，零注入',async()=>{
 const h=fixture();h.blocked(true);await h.drain();
 assert.equal(h.writes.length,0);assert.equal(h.queue.size(),1);
 assert.match(h.events[0],/tool completion/);
});
test('等待期间取消：不注入，通知手机，不恢复被取消的消息',async()=>{
 const h=fixture({onPause:h=>h.queue.cancelByLocalId('one')});h.ready(false);await h.drain();
 assert.equal(h.writes.length,0);assert.equal(h.queue.size(),0);assert.match(h.events.at(-1),/cancelled/);
});
test('等待期间进程退出：不注入，消息恢复',async()=>{
 const h=fixture({onPause:h=>h.exit()});h.ready(false);await h.drain();
 assert.equal(h.writes.length,0);assert.equal(h.queue.size(),1);assert.match(h.events.at(-1),/aborted/);
});
test('确定零写入：撤销回显，恢复队首，下次就绪或新消息到来可再试',async()=>{
 let allowWrite=false;
 const h=fixture({injectorOptions:{ffi:{openConin:()=>1,closeHandle:()=>true,writeConsoleInput:(_h,_b,n)=>{
   if(!allowWrite) return 0;
   h.writes.push(n);
   return n;
 }}}});
 await h.drain();
 assert.equal(h.queue.size(),1);assert.equal(h.queue.queue[0].localId,'one');
 assert.deepEqual(h.discarded,['one']);assert.deepEqual(h.consumed,[]);
 assert.match(h.events.at(-1),/zero write/);assert.equal(h.echoes.length,1);
 allowWrite=true;
 await h.drain();
 assert.deepEqual(h.consumed,['one']);assert.equal(h.queue.size(),0);
 assert.equal(h.writes.length,2);assert.equal(h.echoes.length,2);
});
test('注入器内部等待超时（尚未写任何键）：放回队首、通知手机、允许以后再试',async()=>{
 let injectorPending=true;
 const h=fixture({
   injectorOptions:{
     hasPendingPermissions:()=>injectorPending,
     waitForPermissionsIdle:signal=>new Promise(resolve=>{
       const t=setTimeout(()=>{injectorPending=false;resolve();},60);
       signal?.addEventListener('abort',()=>{clearTimeout(t);resolve();},{once:true});
     })
   }
 });
 await h.drain();
 assert.equal(h.writes.length,0);
 assert.equal(h.queue.size(),1);assert.equal(h.queue.queue[0].localId,'one');
 assert.deepEqual(h.consumed,[]);
 assert.match(h.events.at(-1),/permission_timeout.*zero write/);
 injectorPending=false;
 await h.drain();
 assert.deepEqual(h.consumed,['one']);assert.equal(h.queue.size(),0);assert.equal(h.writes.length,2);
});
test('注入器内部等待超时（已写过Ctrl+S键）：标为结果不确定、通知手机、不自动重发',async()=>{
 let injectorPending=false;
 const h=fixture({
   injectorOptions:{
     hasPendingPermissions:()=>injectorPending,
     sleep:async()=>{injectorPending=true;},
     waitForPermissionsIdle:signal=>new Promise(resolve=>{
       const t=setTimeout(()=>{injectorPending=false;resolve();},60);
       signal?.addEventListener('abort',()=>{clearTimeout(t);resolve();},{once:true});
     })
   }
 });
 h.queue.push('second',mode,'two');
 await h.drain();
 assert.deepEqual(h.writes,[2]);
 assert.deepEqual(h.consumed,[]);assert.deepEqual(h.discarded,[]);
 assert.match(h.events.at(-1),/permission_timeout.*result uncertain/);
 injectorPending=false;
 await h.drain();
 assert.deepEqual(h.writes,[2]);
 assert.equal(h.queue.size(),1);assert.equal(h.queue.queue[0].localId,'two');
 assert.equal(h.queue.cancelByLocalId('one'),true);
});
test('注入器内部等待期间收到取消：退出等待、不写后续键、按写入状态处理',async()=>{
 let injectorPending=true;
 const h1=fixture({
   onPause:h=>h.queue.cancelByLocalId('one'),
   injectorOptions:{
     hasPendingPermissions:()=>injectorPending,
     waitForPermissionsIdle:signal=>new Promise(resolve=>{
       const t=setTimeout(()=>{injectorPending=false;resolve();},60);
       signal?.addEventListener('abort',()=>{clearTimeout(t);resolve();},{once:true});
     })
   }
 });
 await h1.drain();
 assert.equal(h1.now(),50);
 assert.equal(h1.writes.length,0);assert.equal(h1.queue.size(),0);
 assert.match(h1.events.at(-1),/zero write/);
 injectorPending=false;
 h1.queue.push('after-cancel',mode,'two');
 await h1.drain();
 assert.deepEqual(h1.consumed,['two']);

 let postStashPending=false;
 const h2=fixture({
   onPause:h=>h.controller.abort(),
   injectorOptions:{
     hasPendingPermissions:()=>postStashPending,
     sleep:async()=>{postStashPending=true;},
     waitForPermissionsIdle:signal=>new Promise(resolve=>{
       const t=setTimeout(()=>{postStashPending=false;resolve();},60);
       signal?.addEventListener('abort',()=>{clearTimeout(t);resolve();},{once:true});
     })
   }
 });
 await h2.drain();
 assert.deepEqual(h2.writes,[2]);
 assert.match(h2.events.at(-1),/result uncertain/);
 assert.equal(h2.queue.cancelByLocalId('one'),true);
});
test('短写：保留为不确定，后续消息也不自动写入，不撤销回显',async()=>{
 let calls=0;
 const h=fixture({injectorOptions:{ffi:{openConin:()=>1,closeHandle:()=>true,writeConsoleInput:()=>{calls++;return 1;}}}});
 h.queue.push('second',mode,'two');await h.drain();await h.drain();
 assert.equal(calls,1);assert.equal(h.queue.size(),1);assert.equal(h.queue.queue[0].localId,'two');
 assert.deepEqual(h.consumed,[]);assert.deepEqual(h.discarded,[]);
 assert.match(h.events.at(-1),/uncertain/);assert.equal(h.queue.cancelByLocalId('one'),true);
});
test('FFI异常视为不确定，不整条自动重发',async()=>{
 let calls=0;
 const h=fixture({injectorOptions:{ffi:{openConin:()=>1,closeHandle:()=>true,writeConsoleInput:()=>{calls++;throw Error('native failure');}}}});
 await h.drain();await h.drain();assert.equal(calls,1);
 assert.match(h.events.at(-1),/uncertain/);assert.deepEqual(h.consumed,[]);
});
test('Ctrl+S之后中止：结果不确定且通知手机',async()=>{
 // Process exit during the stash must stop the body.
 // Process guard models the launcher abort being observed after the stash.
 const h2=fixture({injectorOptions:{sleep:async()=>h2.exit()}});
 await h2.drain();assert.match(h2.events.at(-1),/uncertain/);assert.deepEqual(h2.consumed,[]);
});
test('发送前取消预留：beforeWrite阻止所有按键',async()=>{
 const h=fixture({options:{injector:{enqueueMessage:async(_text,before)=>{
   h.queue.cancelByLocalId('one');assert.equal(before(),false);
   return {ok:false,reason:'aborted',message:'cancelled',writeState:'zero'};
 }}}});
 await h.drain();assert.equal(h.writes.length,0);assert.equal(h.queue.size(),0);
 assert.match(h.events.at(-1),/aborted/);
});
test('按键：Ctrl+S首、Ctrl+J换行、UTF16代理对、Enter末，无恢复键；布局20字节',()=>{
 const records=buildMessageKeyRecords('中\n😀');
 assert.equal(records.length,12);
 assert.equal(records[0].unicodeChar,0x13);assert.equal(records[0].controlKeyState,8);
 assert.equal(records[4].unicodeChar,10);assert.equal(records[4].virtualKeyCode,0x4a);
 assert.equal(records[6].unicodeChar,0xd83d);assert.equal(records[8].unicodeChar,0xde00);
 assert.equal(records.at(-2).unicodeChar,13);assert.equal(records.at(-1).keyDown,false);
 assert.equal(encodeInputRecords(records).length,records.length*20);
 assert.deepEqual(decodeInputRecords(encodeInputRecords(records)),records);
});
test('Windows 本地：斜杠和 $ 不切换并提示，后面的普通文字照送',async()=>{
 const h=fixture();
 h.queue.reset();
 h.queue.push('/compact',mode,'slash');
 h.queue.push('$skill',mode,'dollar');
 h.queue.push('普通文字',mode,'plain');
 assert.equal(await h.drain(),'handled');
 assert.deepEqual(h.consumed,['plain']);
 assert.equal(h.writes.length,2);
 assert.match(h.events[0],/\[local-console slash\].*请在电脑上发/);
 assert.match(h.events[0],/窗口未重开/);
 assert.match(h.events[1],/\[local-console dollar\].*请在电脑上发/);
 assert.equal(h.queue.cancelByLocalId('slash'),false);
 assert.equal(h.queue.cancelByLocalId('dollar'),false);
 assert.equal(h.queue.cancelByLocalId('plain'),'consumed');
});
test('Windows 本地：非字符串、非文字、附件、internal 都不切换，后面的普通文字照送',async()=>{
 const h=fixture();
 h.queue.reset();
 h.queue.push('x',mode,'obj');
 h.queue.queue[0].message={raw:true};
 h.queue.push('y',{...mode,nonTextContent:true},'nontext');
 h.queue.push('z',{...mode,hasAttachments:true},'file');
 h.queue.push('inner text',mode,'inner');
 h.queue.queue[3].internal=true;
 h.queue.push('普通文字',mode,'plain');
 assert.equal(await h.drain(),'handled');
 assert.deepEqual(h.consumed,['plain']);
 assert.equal(h.events.length,4);
 for (const id of ['obj','nontext','file','inner']) {
  assert.ok(h.events.some(event => event.includes('[local-console '+id+']') && event.includes('请在电脑上发') && event.includes('窗口未重开')));
  assert.equal(h.queue.cancelByLocalId(id),false);
 }
 assert.equal(h.writes.length,2);
});
test('Windows 本地：无 localId 的 internal 取出且不切换，后面的普通文字照送',async()=>{
 const h=fixture();
 h.queue.reset();
 h.queue.push('placeholder',mode,'drop-me');
 const internal=h.queue.queue[0];
 delete internal.localId;
 internal.internal=true;
 internal.message='/auto-review';
 h.queue.push('后面的话',mode,'plain');
 assert.equal(await h.drain(),'handled');
 assert.deepEqual(h.consumed,['plain']);
 assert.equal(h.writes.length,2);
 assert.match(h.events[0],/\[local-console no-localId\].*请在电脑上发/);
 assert.match(h.events[0],/窗口未重开/);
 assert.equal(h.queue.size(),0);
});
test('Windows 本地：未就绪时斜杠命令也不等待、不切换',async()=>{
 const h=fixture();
 h.ready(false);
 h.queue.reset();
 h.queue.push('  /exit',mode,'slash');
 assert.equal(await h.drain(),'handled');
 assert.equal(h.now(),0);
 assert.equal(h.writes.length,0);
 assert.equal(h.queue.size(),0);
 assert.match(h.events[0],/\[local-console slash\]/);
});
test('非 Windows：附件仍返回切换，不取出、不提示',async()=>{
 const h=fixture({options:{platform:'linux'}});
 h.queue.queue[0].mode={...mode,hasAttachments:true};
 assert.equal(await h.drain(),'switch');
 assert.equal(h.writes.length,0);
 assert.equal(h.queue.size(),1);
 assert.equal(h.events.length,0);
});
