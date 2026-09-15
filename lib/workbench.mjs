import {readFileSync,writeFileSync,mkdirSync,renameSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
const valid=id=>{if(!/^[A-Za-z0-9_-]+$/.test(id||''))throw Error('Invalid task ID');return id;};
export function modeCommand(message){
 const s=String(message).trim().replace(/[。！!]$/,'');
 if(/^(?:这个任务)?(?:开启工作台协作模式|按工作台协作模式执行)$/.test(s))return 'collaborative';
 if(/^(?:这个任务)?关闭工作台协作模式$/.test(s))return 'quick';
 return null;
}
export function readWorkbench(id,root=ROOT){
 try{return JSON.parse(readFileSync(join(root,'runtime/workbench',valid(id)+'.json'),'utf8'));}
 catch(e){if(e.code!=='ENOENT')throw e;return {mode:'quick',revision:0,need:'',experience:'',boundaries:'',checkpoints:[]};}
}
export function changeWorkbench(id,fn,root=ROOT){
 const dir=join(root,'runtime/workbench');mkdirSync(dir,{recursive:true});const path=join(dir,valid(id)+'.json');let lock;
 try{lock=openSync(path+'.lock','wx');}catch(e){if(e.code==='EEXIST')throw Object.assign(Error('工作台状态正在更新，请重试'),{status:409});throw e;}
 try{const next=fn(readWorkbench(id,root));next.revision++;next.updated_at=new Date().toISOString();const temp=path+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(next),{mode:0o600});renameSync(temp,path);return next;}
 finally{closeSync(lock);unlinkSync(path+'.lock');}
}
export function checkpoint(id,{run_id,question,artifact,instructions},root=ROOT){
 if(!run_id||!question||!artifact)throw Error('run_id, question and artifact required');
 return changeWorkbench(id,s=>{
  if(s.mode!=='collaborative')throw Error('工作台协作模式未开启');
  if(s.checkpoints.some(c=>c.status==='pending'&&c.run_id===run_id))throw Error('此执行步骤已有待体验节点');
  s.checkpoints.push({id:randomUUID(),run_id,question,artifact,instructions:instructions||'',status:'pending',created_at:new Date().toISOString()});return s;
 },root);
}
export function workbenchPrompt(id,run,root=ROOT){
 const s=readWorkbench(id,root);if(s.mode!=='collaborative')return '';
 return `\n\n工作台协作模式（仅本任务）：\n核心需求：${s.need||'从用户目标与反馈中提炼，已有信息不重复询问'}\n预期体验：${s.experience||'以用户核心需求为准'}\n不可偏离：${s.boundaries||'遵守原任务红线'}\n客观可验证工作自主推进，不增加执行前确认。审美、体验或需求取舍需要用户判断时，先产出可打开的真实成果，再创建待体验节点；不要继续扩大依赖该判断的实现。没有反馈不视为认可。技术检查不等于用户认可。\n创建节点命令（仅创建待体验，不能代表用户批准）：\n${process.execPath} ${join(ROOT,'lib/workbench.mjs')} checkpoint '${id}' '${run}' '<一个关键体验问题>' '<成果路径或本机预览URL>' '<如何测试>'\n调用完成后交回当前执行步骤，调度桥接会等待该节点的反馈；其他任务不受影响。不要主动轮询占用模型。\n历史反馈：${s.checkpoints.filter(c=>c.status!=='pending').map(c=>`${c.status}: ${c.feedback||''}`).join('\n')||'无'}\n用户否定方向后，依据反馈调整后续工作，保留已有文件。`;
}
export async function awaitExperience(id,run,root=ROOT,{sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 let waiting;
 for(;;){
  const s=readWorkbench(id,root);
  if(s.mode!=='collaborative')return;
  const pending=s.checkpoints.find(c=>c.run_id===run&&c.status==='pending');
  if(!pending)return waiting?s.checkpoints.find(c=>c.id===waiting)?.status:undefined;
  waiting=pending.id;
  try{if(JSON.parse(readFileSync(join(root,'tasks',id+'.json'),'utf8')).state==='CANCELLED')return 'cancelled';}catch(e){if(e.code!=='ENOENT')throw e;}
  await sleep(1000);
 }
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 const [cmd,id,run_id,question,artifact,instructions]=process.argv.slice(2);
 if(cmd!=='checkpoint')throw Error('Only checkpoint creation is exposed to agents');
 console.log(JSON.stringify(checkpoint(id,{run_id,question,artifact,instructions})));
}
