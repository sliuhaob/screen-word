'use strict';
const {app,BrowserWindow}=require('electron');
const path=require('node:path'),fs=require('node:fs');
const root=path.resolve(__dirname,'..'),output=path.join(root,'qa-fixtures');
app.disableHardwareAcceleration();app.setPath('userData',path.join(root,'.qa/fixture-profile'));
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  fs.mkdirSync(output,{recursive:true});
  for(const [name,text] of [
    ['eight-generations','Eight generations is a very long time.'],
    ['seven-generations','Eight represents infinity. It is a lucky number.\nSeveral generations have lived here.']
  ]) {
    if(fs.existsSync(path.join(output,name+'.png')))continue;
    const window=new BrowserWindow({width:1800,height:1000,show:false,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
    const lines=text.split('\n').map(line=>`<p>${line}</p>`).join('');
    await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(`<html><body style="margin:0;padding:50px;background:#557c9a;color:white;font:48px Arial;-webkit-text-stroke:1px black">${lines}</body></html>`));
    await new Promise(resolve=>setTimeout(resolve,120));
    fs.writeFileSync(path.join(output,name+'.png'),(await window.webContents.capturePage()).toPNG());window.destroy();
  }
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
