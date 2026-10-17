'use strict';
const fs = require('node:fs'), path = require('node:path'), {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname,'..');
const pkg = require(path.join(root,'package.json'));
require('./collect-licenses.cjs');
const native = spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'build-mouse-hook.ps1')],{cwd:root,encoding:'utf8',windowsHide:true});
if(native.status!==0)throw Error(native.stderr||native.stdout||'Mouse helper build failed');
const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder','Cache');
for(const [key,folder,match,relative] of [
  ['ELECTRON_BUILDER_7ZIP_PATH','7zip@1.0.0','7zip-win-x64-','bin/7za.exe'],
  ['ELECTRON_BUILDER_NSIS_DIR','nsis-3.0.4.1','nsis-3.0.4.1-',''],
  ['ELECTRON_BUILDER_NSIS_RESOURCES_DIR','nsis-resources-3.4.1','nsis-resources-3.4.1-','']
]) {
  const parent=path.join(cache,folder);
  if(!process.env[key]&&fs.existsSync(parent)) {
    const name=fs.readdirSync(parent).find(n=>n.startsWith(match));
    if(name)process.env[key]=path.join(parent,name,relative);
  }
}
const {build,Platform,Arch} = require('electron-builder');
const config = {
  appId:'com.screenword.standalone',productName:'屏幕取词',asar:true,npmRebuild:false,
  electronDist:path.join(path.dirname(require.resolve('electron/package.json')),'dist'),
  extraMetadata:{name:pkg.name,version:pkg.version,main:'electron/main.cjs'},
  directories:{output:path.join(root,'dist')},
  files:[{from:path.join(root,'src'),to:'.',filter:['desktop/**/*','electron/**/*']},'package.json'],
  asarUnpack:['node_modules/tesseract.js/**/*','node_modules/tesseract.js-core/**/*'],
  extraResources:[
    {from:path.join(root,'resources'),to:'dictionary',filter:['**/*']},
    {from:require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'),to:'ocr/eng.traineddata.gz'},
    {from:path.join(root,'native/MouseSideHotkey.exe'),to:'native/MouseSideHotkey.exe'},
    {from:path.join(root,'licenses'),to:'licenses'},
    {from:path.join(root,'LICENSE'),to:'APPLICATION-LICENSE.txt'},
    {from:path.join(root,'THIRD_PARTY_NOTICES.md'),to:'THIRD_PARTY_NOTICES.md'}
  ],
  win:{target:[{target:'portable',arch:['x64']}],artifactName:'screen-word-v1.0-windows-x64.exe',signExecutable:false}
};
build({projectDir:root,config,targets:Platform.WINDOWS.createTarget(process.argv.includes('--dir')?'dir':'portable',Arch.x64)})
  .catch(error=>{console.error(error);process.exitCode=1;});
