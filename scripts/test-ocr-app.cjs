'use strict';
const {app,nativeImage}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),resources=path.join(root,process.env.SCREEN_WORD_TEST_PAYLOAD||'dist/win-unpacked','resources');
const source=path.join(resources,'app.asar/electron');
const {OfflineRecognizer}=require(path.join(source,'ocr.cjs'));
const {ScreenOcrPipeline,lookupWords}=require(path.join(source,'screen-ocr.cjs'));
const {frameFromCapture,frameFromFile}=require(path.join(source,'ocr-frame.cjs'));
const {ChineseDictionary}=require(path.join(source,'chinese-dictionary.cjs'));
app.disableHardwareAcceleration();app.setPath('userData',path.join(root,'.qa/ocr-profile'));
let pool,dictionary;
async function main(){
  dictionary=new ChineseDictionary({packaged:true,resourcesPath:resources});
  const lookup=word=>dictionary.lookup(word),options={packaged:true,resourcesPath:resources};
  pool=new ScreenOcrPipeline(new OfflineRecognizer(options),new OfflineRecognizer(options),{lookup});await pool.prewarm();
  const cases=[];
  for(const [name,targets] of [['eight-generations',['eight','generations','long','time']],['seven-generations',['represents','generations']]]) {
    const file=path.join(root,'qa-fixtures',name+'.png');
    const capture=frameFromCapture(nativeImage.createFromPath(file),nativeImage),imported=await frameFromFile(file,nativeImage);
    pool.clear();const a=lookupWords((await pool.recognize(capture,{onPartial:p=>assert.equal(p.complete,false)})).words,lookup);
    pool.clear();const b=lookupWords((await pool.recognize(imported)).words,lookup);
    assert.deepEqual(a,b);for(const target of targets)assert.ok(a.some(w=>w.text===target),target);
    cases.push({name,targets,words:a.map(w=>w.text),identical:true});
  }
  const report={passed:true,resources,cases,desktopCaptured:false};
  fs.writeFileSync(path.join(root,'.qa/ocr.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
async function finish(){await pool?.terminate();dictionary?.close();}
app.whenReady().then(main).then(async()=>{await finish();app.exit(0);}).catch(async error=>{console.error(error);await finish();app.exit(1);});
