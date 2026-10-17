'use strict';
const{test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const{ChineseDictionary}=require('./src/electron/chinese-dictionary.cjs');
const dictionary=new ChineseDictionary({dictionaryPath:path.resolve(__dirname,'resources/ecdict.sqlite')});
after(()=>dictionary.close());
test('all declared forms offer the literal form and every verified lemma',()=>{
  const forms=JSON.parse(fs.readFileSync(path.resolve(__dirname,'resources/verb-inflections.json'),'utf8')).forms;
  let count=0;
  for(const[form,items]of Object.entries(forms)){
    const r=dictionary.lookup(form,{manual:true});
    assert.ok(r.found,form);
    assert.ok(r.entries.some(e=>e.headword===form&&!e.isInflection),form+' original');
    for(const item of items)assert.ok(r.entries.some(e=>e.headword===item.lemma&&e.isInflection),form+' -> '+item.lemma);
    assert.ok(r.entries.every(e=>e.translations.length>0),form+' meanings');count++;
  }
  console.log('Verified complete switch coverage: '+count+' forms');
});
test('asked, atoned and atoning retain their own entries beside the correct base',()=>{
  for(const[form,lemma]of[['asked','ask'],['atoned','atone'],['atoning','atone']]){
    const r=dictionary.lookup(form);assert.deepEqual(r.entries.map(e=>e.headword),[form,lemma]);
    assert.equal(r.entries[0].isVirtual,undefined);
  }
  assert.match(dictionary.lookup('asked').entries[0].translations.join(' '),/卖方要价/);
});
test('alias-only forms expose a grammatical note and reuse existing verb senses',()=>{
  const r=dictionary.lookup('actioned');
  const original=r.entries.find(e=>e.headword==='actioned');
  assert.ok(original.isVirtual);assert.equal(original.phonetic,'');assert.match(original.formNote,/过去式和过去分词/);
  assert.ok(r.entries.some(e=>e.headword==='action'&&e.isInflection));
});
test('homographs, established phrases and unrelated notes remain distinct',()=>{
  assert.ok(dictionary.lookup('found').entries.some(e=>e.headword==='found'));
  assert.ok(dictionary.lookup('found').entries.some(e=>e.headword==='find'));
  assert.equal(dictionary.lookup('saw off').headword,'saw off');
  assert.equal(dictionary.lookup('fed up').headword,'fed up');
  assert.ok(!dictionary.lookup('enhancing').entries.some(e=>e.headword==='etymologize'));
  assert.ok(!dictionary.lookup('barrackings').entries.some(e=>e.headword==='barrack'));
  for(const form of ['apeing','anteing','cacheing','cueing','axeing'])assert.ok(dictionary.lookup(form).entries.length>=2,form);
});
