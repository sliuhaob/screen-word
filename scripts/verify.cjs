'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const asar=require('@electron/asar'),root=path.resolve(__dirname,'..');
const resources=path.join(root,process.argv.includes('--portable')?'.qa/portable-check':'dist/win-unpacked','resources');
const archive=path.join(resources,'app.asar');
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]);}
let sourceFiles=0;
for(const file of files(path.join(root,'src'))){const relative=path.relative(path.join(root,'src'),file).replaceAll('\\','/');assert.equal(hash(asar.extractFile(archive,relative)),hash(fs.readFileSync(file)),relative);sourceFiles++;}
const metadata=JSON.parse(asar.extractFile(archive,'package.json').toString());assert.equal(metadata.version,'1.0.0');assert.equal(metadata.name,'screen-word');
assert.equal(hash(fs.readFileSync(path.join(resources,'dictionary/ecdict.sqlite'))),'eb14ac57a49824cca96764f98a565cd8b6b63c2d4b1f5ebbe73b822467f72a21');
assert.equal(hash(fs.readFileSync(path.join(resources,'dictionary/verb-inflections.json'))),'5bc7679318280f0794568cfa1ad9f51dbd8fcdf280a1bb06dc093120fd1520ea');
for(const file of ['APPLICATION-LICENSE.txt','THIRD_PARTY_NOTICES.md','dictionary/ECDICT-LICENSE.txt','dictionary/ECDICT-CORRECTIONS-LICENSE.txt','dictionary/NOTICE.md'])assert.ok(fs.existsSync(path.join(resources,file)),file);
const core=JSON.parse(fs.readFileSync(path.join(root,'.qa/core.json'))),ui=JSON.parse(fs.readFileSync(path.join(root,'ui-test-result.json'))),startup=JSON.parse(fs.readFileSync(path.join(root,'startup-test-result.json'))),ocr=JSON.parse(fs.readFileSync(path.join(root,'.qa/ocr.json')));
assert.ok(core.passed&&ui.passed&&startup.passed&&ocr.passed);assert.ok(startup.contentProtectionDisabled&&startup.captureOverlayHidden&&startup.generationsClickable&&startup.representsWhole&&startup.startupPaused);
for(const r of [ui,startup,ocr])assert.equal(r.resources,resources);
const exe=path.join(root,'dist/screen-word-v1.0-windows-x64.exe');assert.ok(fs.statSync(exe).size>100000000);
const sum=hash(fs.readFileSync(exe));fs.writeFileSync(path.join(root,'dist/SHA256SUMS'),`${sum}  ${path.basename(exe)}\n`);
const report={passed:true,version:'v1.0',sourceFiles,coreChecks:core.passedCount,uiChecks:ui.checks,executableSha256:sum};
fs.writeFileSync(path.join(root,'.qa/verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
