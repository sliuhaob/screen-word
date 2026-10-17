'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.qa');fs.mkdirSync(out,{recursive:true});
const env={...process.env,SCREEN_WORD_TEST_PAYLOAD:process.argv.includes('--portable')?'.qa/portable-check':'dist/win-unpacked'};
delete env.ELECTRON_RUN_AS_NODE;
const electron=require('electron');
for(const file of ['scripts/generate-fixtures.cjs','test-ui.cjs','test-startup.cjs','scripts/test-ocr-app.cjs']) {
  const result=spawnSync(electron,[path.join(root,file)],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:8*1024*1024});
  const log=(result.stdout||'')+(result.stderr||'');
  fs.writeFileSync(path.join(out,path.basename(file)+'.log'),log);
  console.log(path.basename(file),result.status);if(result.stdout)console.log(result.stdout.trim());
  if(result.status!==0){console.error(result.stderr,result.error||'');process.exit(result.status||1);}
}
