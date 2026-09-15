import {workbenchPrompt,awaitExperience} from './workbench.mjs';
import {readFileSync,readdirSync,mkdirSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
export function disabledExecutors(base=root){
 const p=join(base,'config/operator-executors.json');
 if(!existsSync(p))return [];
 const data=JSON.parse(readFileSync(p,'utf8'));
 if(!Array.isArray(data.disabled)||data.disabled.some(x=>typeof x!=='string'))throw Error('Invalid operator executor restrictions');
 return data.disabled;
}
export function filterExecutors(adapters,base=root){
 const disabled=new Set(disabledExecutors(base));
 return Object.fromEntries(Object.entries(adapters).filter(([id])=>!disabled.has(id)));
}
function atomic(path,data){mkdirSync(dirname(path),{recursive:true});const temp=path+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(data),{mode:0o600});renameSync(temp,path);}
export function instrumentAdapter(id,adapter,base=root){
 if(adapter.__instrumented) return adapter;
 const origRun = adapter.run;
 const origResume = adapter.resume;
 const wrap=(method, orig)=>async(...args)=>{
  if(disabledExecutors(base).includes(id))throw Error(`OPERATOR_EXECUTOR_DISABLED: ${id}`);
  const capsule={...args.at(-1)};
  const taskId=String(capsule.task_id||'').replace(/-S\d+$/,'');
  if(!/^[A-Za-z0-9_-]+$/.test(taskId))return orig(...args);
  const runId=/^[A-Za-z0-9_-]+$/.test(capsule.runId||'')?capsule.runId:randomUUID();
  capsule.prompt=(capsule.prompt||'')+workbenchPrompt(taskId,runId,base);
  const inputDir=join(base,'runtime/operator-input',taskId);
  let names=[];try{names=readdirSync(inputDir).filter(n=>/^[a-f0-9-]+\.json$/i.test(n)).sort();}catch(e){if(e.code!=='ENOENT')throw e;}
  const inputs=names.map(name=>({path:join(inputDir,name),value:JSON.parse(readFileSync(join(inputDir,name),'utf8'))}));
  if(inputs.length)capsule.prompt=(capsule.prompt||'')+'\n\nUSER MESSAGES FOR THIS TASK (in chronological order; preserve permissions and governance):\n'+inputs.sort((a,b)=>a.value.created_at.localeCompare(b.value.created_at)).map(x=>`[${x.value.created_at}] ${x.value.message}`).join('\n');
  const activity={task_id:taskId,run_id:runId,executor:id,role:capsule.assigned_role||null,step: /-S(\d+)$/.exec(capsule.task_id)?.[1]||null,
   model:capsule.model||null,effort:capsule.effort||capsule.reasoning_effort||(id==='cline'&&capsule.model?.includes('deepseek')?'xhigh':null),
   parameter_source:'adapter-call',status:'running',started_at:new Date().toISOString(),input_ids:inputs.map(x=>x.value.id)};
  const path=join(base,'runtime/operator-activity',taskId,`${runId}.json`);
  atomic(path,activity);
  for(const input of inputs)atomic(join(base,'runtime/operator-received',taskId,`${input.value.id}-${runId}.json`),{input_id:input.value.id,run_id:runId,received_at:new Date().toISOString()});
  args[args.length-1]=capsule;
  try{const result=await orig(...args);if(result.status==='completed'){const stopped=await awaitExperience(taskId,runId,base);if(stopped==='cancelled')result.status='cancelled';if(stopped==='changes_requested'){atomic(path,{...activity,status:'changes_requested',finished_at:new Date().toISOString()});return wrap(method, orig)(...args);}}atomic(path,{...activity,status:result.status||'finished',finished_at:new Date().toISOString()});return result;}
  catch(e){atomic(path,{...activity,status:'failed',finished_at:new Date().toISOString()});throw e;}
 };
 if(origRun) adapter.run = wrap('run', origRun);
 if(origResume) adapter.resume = wrap('resume', origResume);
 Object.defineProperty(adapter, '__instrumented', { value: true, enumerable: false });
 return adapter;
}
