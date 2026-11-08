import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import assert from 'node:assert/strict';
import {Store} from '../src/core/store.js';
import {Projects} from '../src/core/projects.js';
import {Workspace} from '../src/core/workspace.js';
import {validateProject} from '../src/core/validation.js';
import {runMutation} from '../src/core/mutation.js';
import {PreviewServers} from '../src/core/preview-server.js';
const parent=await realpath(tmpdir()), base=await mkdtemp(join(parent,'cw-docker-simulation-'));
const checks=[];
try {
  const root=join(base,'project');await mkdir(root);
  const store=new Store(join(base,'data'),{});await store.init();
  const projects=new Projects(store), id=(await projects.list()).activeId, workspace=new Workspace(projects);
  const pending=await workspace.prepare(id,root);await workspace.consent(id,pending.ticket,true);
  const grant=await workspace.grant(id);await workspace.setExecutionApproval(id,grant.grantId,true);
  await writeFile(join(base,'host-canary'),'keep');
  await writeFile(join(root,'.env'),'PRIVATE_FIXTURE=DO_NOT_COPY_THIS_VALUE');
  await writeFile(join(root,'app.cjs'),'exports.value=2;');await mkdir(join(root,'tests'));
  await writeFile(join(root,'tests','isolation.test.cjs'),`const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http');
test('T1 no credentials',()=>{assert.equal(fs.existsSync('/input/.env'),false);assert.equal(process.env.OPENAI_API_KEY,undefined);});
test('T2 read-only input',()=>{assert.throws(()=>fs.writeFileSync('/input/app.cjs','damaged'));assert.equal(require('/input/app.cjs').value,2);});
test('T3 no host access',()=>{assert.equal(fs.existsSync(${JSON.stringify(join(base,'host-canary'))}),false);assert.equal(fs.existsSync('/var/run/docker.sock'),false);});
test('T4 network denied',async()=>{await new Promise((resolve,reject)=>{const req=http.get('http://1.1.1.1',()=>reject(Error('network was reachable')));req.on('error',()=>resolve());req.setTimeout(1500,()=>{req.destroy();resolve();});});});`);
  await writeFile(join(root,'package.json'),JSON.stringify({private:true,scripts:{'test:mutation':'node mutation.cjs'}}));
  await writeFile(join(root,'mutation.cjs'),`require('node:fs').writeFileSync(process.env.TOWER_MUTATION_REPORT,JSON.stringify({files:{'app.cjs':{mutants:[{status:'Killed',mutatorName:'fixture',replacement:'1'}]}}}));`);
  const options={allowExecution:true,executionBackend:'docker',dockerImage:'node:24-bookworm-slim',testPlan:{runner:'node-test',files:['tests/isolation.test.cjs'],cases:[1,2,3,4].map(i=>({id:'T'+i,title:'Isolation '+i}))}};
  const context={projectId:id,grantId:grant.grantId,options,signal:new AbortController().signal};
  const result=await validateProject(workspace,context);
  if(result.requiresSetup) {
    console.log(JSON.stringify({status:'not-run',reason:result.summary}));
    if(process.argv.includes('--require'))throw Error(result.summary);
  } else {
    assert.equal(result.passed,true,JSON.stringify(result));
    assert.equal(await readFile(join(root,'app.cjs'),'utf8'),'exports.value=2;');
    assert.equal(await readFile(join(base,'host-canary'),'utf8'),'keep');
    checks.push('Actual Linux container passes four tests for credential exclusion, read-only source, absent host/socket access and denied network; host canary and project source stay unchanged');
    const mutation=await runMutation(workspace,context);assert.equal(mutation.passed,true,JSON.stringify(mutation));
    assert.equal(mutation.total,1);assert.ok(await access(join(root,mutation.reportPath)).then(()=>true,()=>false));
    checks.push('A fresh fixture mutation JSON report returns through bounded stdout and is parsed by the actual mutation pipeline; this is not a Stryker engine benchmark');
    await writeFile(join(root,'package.json'),JSON.stringify({private:true,scripts:{preview:'node preview.cjs'}}));
    await writeFile(join(root,'preview.cjs'),`const http=require('node:http'),fs=require('node:fs');http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ready:true,secretCopied:fs.existsSync('/input/.env'),socket:fs.existsSync('/var/run/docker.sock'),key:process.env.OPENAI_API_KEY??null,interfaces:fs.readdirSync('/sys/class/net')}));}).listen(Number(process.env.PORT),'0.0.0.0');`);
    const previews=new PreviewServers(workspace,store),previewOptions={...options};await previews.approve(id,previewOptions,{mode:'script',script:'preview',url:'http://127.0.0.1:15173/',profiles:[]});let preview;
    try{preview=await previews.start({...context,options:previewOptions,sourceHash:(await workspace.snapshot(id)).hash});const response=await preview.fetch(preview.url),body=await response.json();assert.deepEqual(body,{ready:true,secretCopied:false,socket:false,key:null,interfaces:['lo']});assert.equal(preview.unverifiedSource,false);}finally{await preview?.close();}
    await assert.rejects(preview.fetch(preview.url,{signal:AbortSignal.timeout(1500)}));
    checks.push('A real managed preview container returns bounded loopback HTTP responses through docker exec with network=none and no published ports; no credentials/socket are copied and teardown closes the endpoint without host execution');
  }
  await mkdir(resolve('artifacts'),{recursive:true});
  await writeFile(resolve('artifacts/docker-isolation-report.json'),JSON.stringify({passed:checks.length,checks,paidCalls:0},null,2));
  console.log(JSON.stringify({passed:checks.length,checks,paidCalls:0},null,2));
} finally {
  const actual=await realpath(base),part=relative(parent,actual);
  if(part.startsWith('cw-docker-simulation-')&&!part.startsWith('..')&&!isAbsolute(part))await rm(actual,{recursive:true,force:true,maxRetries:5});
}
