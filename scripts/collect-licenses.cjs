'use strict';
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'),output=path.join(root,'licenses/runtime');
fs.mkdirSync(output,{recursive:true});const seen=new Set(),index=[];
function collect(name,from){
  const request=createRequire(path.join(from,'package.json'));let file;
  try{file=request.resolve(name+'/package.json');}catch{
    let dir=path.dirname(request.resolve(name));
    while(dir!==path.dirname(dir)){
      const candidate=path.join(dir,'package.json');
      if(fs.existsSync(candidate)&&JSON.parse(fs.readFileSync(candidate)).name===name){file=candidate;break;}
      dir=path.dirname(dir);
    }
  }
  if(!file)throw Error('Cannot locate dependency '+name);
  const dir=path.dirname(file),pkg=JSON.parse(fs.readFileSync(file)),key=pkg.name+'@'+pkg.version;
  if(seen.has(key))return;seen.add(key);
  const notices=[];
  for(const item of fs.readdirSync(dir,{withFileTypes:true})){
    if(!item.isFile()||!/^(licen[cs]e|copying|notice)(\..*)?$/i.test(item.name))continue;
    const target=(pkg.name+'-'+pkg.version+'-'+item.name).replaceAll('/','_').replaceAll('@','');
    fs.copyFileSync(path.join(dir,item.name),path.join(output,target));notices.push(target);
  }
  index.push({name:pkg.name,version:pkg.version,license:pkg.license||'',notices});
  for(const dependency of Object.keys(pkg.dependencies||{}))collect(dependency,dir);
}
for(const name of Object.keys(require(path.join(root,'package.json')).dependencies))collect(name,root);
index.sort((a,b)=>a.name.localeCompare(b.name));fs.writeFileSync(path.join(output,'index.json'),JSON.stringify(index,null,2)+'\n');
