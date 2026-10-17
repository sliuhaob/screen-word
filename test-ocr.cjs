'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeOcrWords } = require('./src/electron/ocr-merge.cjs');
const { ScreenOcrPipeline, scaleWords } = require('./src/electron/screen-ocr.cjs');
const { cleanDetectedWord, compoundComponents, expandCompoundWords } = require('./src/electron/ocr-utils.cjs');
const { extractWordsFromBlocks } = require('./src/electron/ocr-utils.cjs');
const { planRecovery, acceptRecovery, MAX_RETRIES } = require('./src/electron/ocr-recovery.cjs');
const word = (text, x, overrides = {}) => ({ text, x, y: 10, width: 40, height: 20, confidence: 85, lineId: '0', tokenIndex: x / 50, ...overrides });
test('merge supplements missing words, deduplicates geometry and prioritizes raw evidence', () => {
  const merged = mergeOcrWords([word('public', 0), word('updated', 50)], [word('public', 1), word('new', 100), word('noisy', 0, { confidence: 70 })]);
  assert.deepEqual(merged.map(w => w.text), ['public', 'updated', 'new']);
});
test('higher-confidence corrections win, without keeping nested wrong boxes', () => {
  assert.equal(mergeOcrWords([word('publlc', 0, { confidence: 55 })], [word('public', 1, { confidence: 92 })])[0].text, 'public');
  assert.equal(mergeOcrWords([word('repositories', 0, { width: 160 })], [word('po', 40, { width: 10, confidence: 60 })]).length, 1);
});
test('weak extra small fragments are rejected; large captions may use lower confidence', () => {
  assert.equal(mergeOcrWords([], [word('xx', 0, { confidence: 40 })]).length, 0);
  assert.equal(mergeOcrWords([], [word('akasaka', 0, { confidence: 40, height: 60 })]).length, 1);
});
test('cross-pass words share a line, separate rows/columns never do', () => {
  const merged = mergeOcrWords([word('tipped', 0)], [word('off', 50), word('far', 400), word('below', 0, { y: 50 })]);
  const get = text => merged.find(w => w.text === text);
  assert.equal(get('tipped').lineId, get('off').lineId);
  assert.notEqual(get('off').lineId, get('far').lineId);
  assert.notEqual(get('tipped').lineId, get('below').lineId);
});
test('missing OCR tokens and punctuation retain phrase boundaries', () => {
  const merged = mergeOcrWords([word('take', 0, { tokenIndex: 0, breakAfter: true }), word('off', 50, { tokenIndex: 2 })], []);
  assert.notEqual(merged[0].lineId, merged[1].lineId);
  assert.equal(merged[0].breakAfter, true);
});
test('supplement and symbol boxes are restored to capture coordinates', () => {
  const [scaled] = scaleWords([{ ...word('a-b', 20), components: [word('a', 25)] }], 2, 3);
  assert.equal(scaled.x, 40); assert.equal(scaled.y, 30); assert.equal(scaled.width, 80); assert.equal(scaled.components[0].x, 50);
});
test('CS2 is not silently changed into cs; apostrophes survive', () => {
  assert.equal(cleanDetectedWord('CS2'), ''); assert.equal(cleanDetectedWord('D1'), '');
  assert.equal(cleanDetectedWord('“We’re”'), "we're");
});
test('unknown compounds split at real character coordinates; known compounds stay whole', () => {
  const item = { symbols: [...'utility-lab'].map((text, i) => ({ text, bbox: { x0: 10 + i * 8, x1: 18 + i * 8, y0: 5, y1: 25 } })) };
  const components = compoundComponents(item, 'utility-lab', 90);
  const original = { ...word('utility-lab', 10), components };
  const split = expandCompoundWords([original], () => ({ found: false }));
  assert.deepEqual(split.map(w => w.text), ['utility', 'lab']); assert.equal(split[1].x, 74);
  assert.equal(expandCompoundWords([original], () => ({ found: true })).length, 1);
});
function capture(buffer = 'image', displayId = '1') {
  return { buffer: Buffer.from(buffer), width: 100, height: 80, displayId,
    makeSupplement: () => ({ buffer: Buffer.from('enhanced'), mode: 'bright-text', scaleX: 1, scaleY: 1 }) };
}
test('cache depends only on image pixels/size, not screen versus file provenance', async () => {
  let calls = 0;
  const lane = () => ({ recognize: async () => { calls++; return { words: [word('hello', 0)] }; } });
  const pipeline = new ScreenOcrPipeline(lane(), lane());
  assert.equal((await pipeline.recognize(capture())).cached, false);
  assert.equal((await pipeline.recognize(capture())).cached, true); assert.equal(calls, 2);
  await pipeline.recognize(capture('changed')); assert.equal(calls, 4);
  await pipeline.recognize(capture('changed', '2')); assert.equal(calls, 4);
  pipeline.clear(); await pipeline.recognize(capture('changed', '2')); assert.equal(calls, 6);
});
test('stop before/during recognition cannot publish or cache stale words', async () => {
  let stop = false, calls = 0;
  const lane = () => ({ recognize: async () => { calls++; stop = true; return { words: [word('hello', 0)] }; } });
  const pipeline = new ScreenOcrPipeline(lane(), lane());
  assert.equal((await pipeline.recognize(capture(), { shouldStop: () => true })).stopped, true); assert.equal(calls, 0);
  assert.equal((await pipeline.recognize(capture(), { shouldStop: () => stop })).stopped, true); assert.equal(calls, 2);
  assert.equal(pipeline.cache, null);
});

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferredLane() {
  let finish, fail;
  const lane = { started: false, recognize: () => { lane.started = true; return new Promise((resolve, reject) => { finish = resolve; fail = reject; }); } };
  return { lane, finish: words => finish({ words }), fail: () => fail(new Error('lane failed')) };
}
test('two lanes start together and the first finished lane publishes reliable words', async () => {
  const raw = deferredLane(), extra = deferredLane(), partials = [];
  const pipeline = new ScreenOcrPipeline(raw.lane, extra.lane);
  let done = false;
  const pending = pipeline.recognize(capture(), { onPartial: p => partials.push(p) }).then(r => { done = true; return r; });
  await tick(); assert.ok(raw.lane.started && extra.lane.started);
  extra.finish([word('later', 50)]); await tick();
  assert.equal(partials.length, 1); assert.equal(done, false);
  assert.equal(partials[0].complete, false);
  assert.equal(partials[0].stage, 'first-pass');
  assert.deepEqual(partials[0].words.map(w=>w.text), ['later']);
  raw.finish([word('hello', 0)]);
  assert.deepEqual((await pending).words.map(w => w.text), ['hello', 'later']);
  assert.equal(partials.length, 1);
});
test('empty first lane waits for useful words; one failing lane never caches degraded results', async () => {
  const raw = deferredLane(), extra = deferredLane(), partials = [];
  const pipeline = new ScreenOcrPipeline(raw.lane, extra.lane);
  const pending = pipeline.recognize(capture(), { onPartial: p => partials.push(p) });
  await tick(); raw.finish([]); await tick(); assert.equal(partials.length, 0);
  extra.finish([word('hello', 0)]); assert.equal((await pending).words.length, 1); assert.equal(partials.length, 0);
  pipeline.clear();
  const degraded = pipeline.recognize(capture()); await tick(); raw.fail(); extra.finish([word('hello', 0)]);
  assert.equal((await degraded).degraded, true); assert.equal(pipeline.cache, null);
  const failed = pipeline.recognize(capture()); await tick(); raw.fail(); extra.fail();
  await assert.rejects(failed, /lane failed/);
});
test('cancel between lanes drains both and never publishes or caches stale completion', async () => {
  const raw = deferredLane(), extra = deferredLane(); let stop = false, published = 0, done = false;
  const pipeline = new ScreenOcrPipeline(raw.lane, extra.lane);
  const pending = pipeline.recognize(capture(), { shouldStop: () => stop, onPartial: () => { published++; stop = true; } }).then(r => { done = true; return r; });
  await tick(); raw.finish([word('hello', 0)]); await tick(); assert.equal(done, false);
  stop = true;
  extra.finish([word('later', 50)]); assert.equal((await pending).stopped, true);
  assert.equal(published, 1); assert.equal(pipeline.cache, null);
});

test('confirmed whole word survives confident fragments from the other lane', () => {
  const parts = [word('generati', 100, { width: 260, height: 50, confidence: 91 }), word('ons', 365, { width: 100, height: 50, confidence: 90 })];
  const whole = word('generations', 100, { width: 365, height: 50, confidence: 96 });
  const result = mergeOcrWords(parts, [whole], { isKnownWord: w => w === 'generations' });
  assert.deepEqual(result.map(w => w.text), ['generations']); assert.equal(result[0].width, 365);
});
test('real adjacent words and unsupported whole guesses are not blindly joined', () => {
  const parts = [word('in', 100, { width: 50, height: 50, confidence: 98 }), word('side', 156, { width: 110, height: 50, confidence: 98 })];
  const whole = word('inside', 100, { width: 166, height: 50, confidence: 80 });
  const result = mergeOcrWords(parts, [whole], { isKnownWord: () => true });
  assert.deepEqual(result.map(w => w.text), ['in', 'side']);
  const unknown = mergeOcrWords(parts, [{ ...whole, text: 'insidex' }], { isKnownWord: () => false });
  assert.deepEqual(unknown.map(w => w.text), ['in', 'side']);
});
test('transparent word coordinates map captured pixels to the whole monitor viewport', () => {
  const { frameLayout } = require('./src/desktop/frame-layout.js');
  assert.deepEqual(frameLayout(2560, 1600, 1280, 800), { scaleX: .5, scaleY: .5, left: 0, top: 0, width: 1280, height: 800 });
  assert.deepEqual(frameLayout(1000, 1000, 1280, 800), { scaleX: 1.28, scaleY: .8, left: 0, top: 0, width: 1280, height: 800 });
  assert.deepEqual(frameLayout(1600, 900, 800, 800), { scaleX: .5, scaleY: 800/900, left: 0, top: 0, width: 800, height: 800 });
});
test('worker pool prewarms and terminates both lanes, even when one rejects', async () => {
  const seen = [];
  const lane = id => ({ getWorker: async () => { seen.push(`warm${id}`); if (id === 1) throw Error('init failed'); },
    terminate: async () => { seen.push(`end${id}`); if (id === 1) throw Error('init failed'); } });
  const pipeline = new ScreenOcrPipeline(lane(1), lane(2));
  await assert.rejects(pipeline.prewarm(), /init failed/); await pipeline.terminate();
  assert.deepEqual(seen, ['warm1', 'warm2', 'end1', 'end2']);
  const same = lane(3); assert.throws(() => new ScreenOcrPipeline(same, same), /independent/);
});

function recognizerWith(createWorker) {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const filename = path.join(__dirname, 'src/electron/ocr.cjs');
  const realRequire = require('node:module').createRequire(filename);
  const context = vm.createContext({ module: { exports: {} },
    require: name => name === 'tesseract.js' ? { createWorker, PSM: { AUTO: '3' } } : realRequire(name) });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context);
  return new context.module.exports.OfflineRecognizer({ packaged: true, resourcesPath: __dirname });
}
test('preload and first use share one initialization; shutdown during preload releases it', async () => {
  let finish, created = 0, ended = 0;
  const worker = { setParameters: async () => {}, terminate: async () => { ended++; } };
  const recognizer = recognizerWith(() => { created++; return new Promise(resolve => { finish = resolve; }); });
  const first = recognizer.getWorker(), second = recognizer.getWorker(), shutdown = recognizer.terminate();
  assert.equal(created, 1); finish(worker);
  await Promise.all([first, second, shutdown]); assert.equal(ended, 1);
  await assert.rejects(recognizer.getWorker(), /terminated/);
});
test('failed preload resets initialization and the next key can retry', async () => {
  let created = 0, ended = 0;
  const worker = { setParameters: async () => {}, terminate: async () => { ended++; } };
  const recognizer = recognizerWith(async () => { if (++created === 1) throw Error('model load failed'); return worker; });
  await assert.rejects(recognizer.getWorker(), /model load failed/);
  assert.equal(await recognizer.getWorker(), worker); assert.equal(created, 2);
  await recognizer.terminate(); assert.equal(ended, 1);
});
test('configuration failure terminates the worker instead of leaking it', async () => {
  let ended = 0;
  const recognizer = recognizerWith(async () => ({ setParameters: async () => { throw Error('bad config'); }, terminate: async () => { ended++; } }));
  await assert.rejects(recognizer.getWorker(), /bad config/); assert.equal(ended, 1);
  await recognizer.terminate(); assert.equal(ended, 1);
});

test('low-confidence candidates preserve exact letter geometry and quoted punctuation without bypassing filtering', () => {
  const token = { text: 'generations!”', confidence: 23, bbox: { x0: 10, y0: 5, x1: 150, y1: 35 },
    symbols: [...'generations!'].map((text, i) => ({ text, bbox: { x0: 10+i*10, y0: 5, x1: 20+i*10, y1: 35 } })) };
  const blocks = [{ paragraphs: [{ lines: [{ words: [token] }] }] }];
  assert.equal(extractWordsFromBlocks(blocks, 45).length, 0);
  const [candidate] = extractWordsFromBlocks(blocks, 0);
  assert.equal(candidate.text, 'generations'); assert.equal(candidate.breakAfter, true);
  assert.deepEqual(candidate.textBox, {x:10,y:5,width:110,height:30});
  assert.equal(scaleWords([candidate],2,3)[0].textBox.width,220);
});

test('recovery requires two agreeing low-confidence lanes and a known word', () => {
  const low=word('generations',10,{confidence:23,width:110,height:40});
  const other={...low,confidence:0};
  assert.equal(planRecovery([low],[other],[],()=>true).length,1);
  assert.equal(planRecovery([low],[],[],()=>true).length,0);
  assert.equal(planRecovery([low],[{...other,text:'generationz'}],[],()=>true).length,0);
  assert.equal(planRecovery([low],[other],[],()=>false).length,0);
  assert.equal(planRecovery([low],[other],[{...low,confidence:90}],()=>true).length,0);
  assert.equal(planRecovery([low],[{...other,y:200}],[],()=>true).length,0);
});

test('recovery is spatially deduplicated and capped at six crops', () => {
  const all=[...'abcdefghij'].map((letter,i)=>word(`word${letter}`,i*100,{confidence:10}));
  assert.equal(planRecovery(all,all,[],()=>true).length,MAX_RETRIES);
  assert.equal(MAX_RETRIES,6);
});

test('one surviving suffix triggers re-reading; real neighboring words are protected', () => {
  const full=word('represents',0,{width:140,confidence:96});
  const part=word('ents',95,{width:45,confidence:95});
  assert.equal(planRecovery([part],[full],[part],()=>true)[0].text,'represents');
  const inside=word('inside',0,{width:140,confidence:90});
  const parts=[word('in',0),word('side',50,{width:90})];
  assert.equal(planRecovery(parts,[inside],parts,()=>true).length,0);
  assert.equal(planRecovery([part],[{...full,text:'unrelated'}],[part],()=>true).length,0);
});

test('local recovery accepts only a high-confidence exact token at the original location', () => {
  const candidate=word('generations',20,{width:110,breakAfter:true});
  const crop={x:10,y:0,width:150,height:50};
  const local=word('generations',10,{width:110,confidence:96});
  const accepted=acceptRecovery(candidate,crop,{candidates:[local]});
  assert.equal(accepted.x,20);assert.equal(accepted.confidence,96);assert.equal(accepted.breakAfter,true);
  assert.equal(acceptRecovery(candidate,crop,{candidates:[{...local,confidence:69}]}),null);
  assert.equal(acceptRecovery(candidate,crop,{candidates:[{...local,text:'generation'}]}),null);
  assert.equal(acceptRecovery(candidate,crop,{candidates:[local,word('a',140)]}),null);
  assert.equal(acceptRecovery(candidate,crop,{candidates:[{...local,x:1000}]}),null);
  assert.equal(acceptRecovery(candidate,{...crop,y:200},{candidates:[local]}),null);
});

function recoveryPool({fail=false,wrong=false,defer=false}={}) {
  const counts=[0,0];let release;
  const low=word('generations',5,{width:80,confidence:23});
  const lanes=[0,1].map(index=>({recognize:async(_buffer,options)=>{
    counts[index]++;
    if(options.pageSegMode==='11')return {words:[],candidates:[{...low,confidence:index?0:23}]};
    assert.equal(options.pageSegMode,'7');assert.equal(options.minimumConfidence,70);
    if(defer)await new Promise(resolve=>{release=resolve});
    if(fail)throw Error('retry failed');
    const recovered={...low,text:wrong?'generation':'generations',confidence:96};
    return {words:[recovered],candidates:[recovered]};
  }}));
  const pipeline=new ScreenOcrPipeline(...lanes,{lookup:()=>({found:true})});
  const frame={...capture(),makeCrop:()=>({buffer:Buffer.from('crop'),x:0,y:0,width:100,height:80})};
  return {pipeline,frame,counts,release:()=>release()};
}

test('pipeline retries rejected candidates once and caches final verified words',async()=>{
  const {pipeline,frame,counts}=recoveryPool();
  const result=await pipeline.recognize(frame);
  assert.deepEqual(result.recovery,{attempted:1,accepted:['generations']});
  assert.deepEqual(counts,[2,1]);assert.equal(result.words[0].confidence,96);
  assert.equal((await pipeline.recognize(frame)).cached,true);assert.deepEqual(counts,[2,1]);
});

test('failed local retries are nonfatal and never cached; changed letters are not accepted',async()=>{
  const failed=recoveryPool({fail:true});
  const result=await failed.pipeline.recognize(failed.frame);
  assert.equal(result.degraded,true);assert.equal(result.words.length,0);assert.equal(failed.pipeline.cache,null);
  const wrong=recoveryPool({wrong:true});
  assert.equal((await wrong.pipeline.recognize(wrong.frame)).words.length,0);
});

test('cancellation during local retry drains it and cannot publish or cache results',async()=>{
  const {pipeline,frame,release,counts}=recoveryPool({defer:true});let stop=false,done=false;
  const pending=pipeline.recognize(frame,{shouldStop:()=>stop}).then(r=>{done=true;return r});
  await tick();assert.deepEqual(counts,[2,1]);stop=true;await tick();assert.equal(done,false);
  release();assert.equal((await pending).stopped,true);assert.equal(pipeline.cache,null);
});

test('verified whole word replaces a competing suffix without duplicating boxes',()=>{
  const whole=word('represents',0,{width:140,confidence:94});
  const part=word('ents',95,{width:45,confidence:95});
  assert.deepEqual(mergeOcrWords([part],[{...whole,confidence:96}],{verifiedWords:[whole]}).map(w=>w.text),['represents']);
  assert.deepEqual(mergeOcrWords([part],[],{verifiedWords:[{...whole,confidence:69}]}).map(w=>w.text),['ents']);
});

test('dense-page rejected tokens do not consume the accepted-word limit',async()=>{
  const tokens=Array.from({length:950},(_,i)=>({text:'noise',confidence:1,bbox:{x0:0,y0:i*20,x1:40,y1:i*20+15}}));
  tokens.push({text:'target',confidence:95,bbox:{x0:0,y0:20000,x1:60,y1:20020}});
  const recognizer=recognizerWith(async()=>({setParameters:async()=>{},terminate:async()=>{},
    recognize:async()=>({data:{blocks:[{paragraphs:[{lines:[{words:tokens}]}]}]}})}));
  const result=await recognizer.recognize(Buffer.from('fake'));
  assert.equal(result.words.length,1);assert.equal(result.words[0].text,'target');assert.equal(result.candidates.length,900);
  await recognizer.terminate();
});

test('bounded retries reuse two idle workers without overlapping calls on either worker',async()=>{
  const candidates='alpha bravo charlie delta echo foxtrot golf hotel'.split(' ').map((text,i)=>word(text,i*100,{confidence:20}));
  const active=[false,false],calls=[0,0];let crops=0;
  const lanes=[0,1].map(index=>({recognize:async(buffer,options)=>{
    assert.equal(active[index],false);active[index]=true;calls[index]++;await tick();active[index]=false;
    if(options.pageSegMode==='11')return {words:[],candidates};
    const local=word(buffer.toString(),0,{y:0,confidence:96});return {words:[local],candidates:[local]};
  }}));
  const pipeline=new ScreenOcrPipeline(...lanes,{lookup:()=>({found:true})});
  const result=await pipeline.recognize({...capture(),width:1000,makeCrop:c=>{crops++;return {buffer:Buffer.from(c.text),x:c.x,y:c.y,width:40,height:20}}});
  assert.equal(crops,6);assert.deepEqual(calls,[4,4]);assert.equal(result.recovery.accepted.length,6);
  assert.equal(result.words.length,6);assert.deepEqual(active,[false,false]);
});

test('early results exclude low-confidence and unknown words without dropping them from the final result', async () => {
  const raw = deferredLane(), extra = deferredLane(), partials = [];
  const pipeline = new ScreenOcrPipeline(raw.lane, extra.lane, { lookup: text => ({ found: text !== 'unknownname' }) });
  const pending = pipeline.recognize(capture(), { onPartial: p => partials.push(p) });
  await tick(); raw.finish([word('hello', 0), word('weak', 50, { confidence: 65 }), word('unknownname', 100)]); await tick();
  assert.deepEqual(partials[0].words.map(w=>w.text), ['hello']);
  extra.finish([]);
  assert.deepEqual((await pending).words.map(w=>w.text), ['hello','weak','unknownname']);
  const cached = await pipeline.recognize(capture(), { onPartial: () => assert.fail('Cache should publish once as final') });
  assert.equal(cached.complete, true); assert.equal(cached.cached, true);
});

test('slow display callback never blocks second lane or local recovery; final result drains display in order', async () => {
  let releaseDisplay, recovered = false, done = false;
  const partials = [], low = word('generations', 50, { width: 40, confidence: 23 });
  const raw = { recognize: async (_b, options) => {
    if (options.pageSegMode === '7') { recovered = true; return { words: [word('generations',0,{y:0,confidence:96})] }; }
    return { words: [word('hello',0)], candidates: [word('hello',0),low] };
  } };
  const extra = { recognize: async () => { await tick(); return { words: [], candidates: [low] }; } };
  const pipeline = new ScreenOcrPipeline(raw, extra, { lookup: () => ({ found: true }) });
  const frame = { ...capture(), makeCrop: () => ({ buffer: Buffer.from('crop'), x:50,y:10,width:40,height:20 }) };
  const pending = pipeline.recognize(frame, { onPartial: async p => {
    partials.push(p.stage); if (partials.length===1) await new Promise(resolve=>{releaseDisplay=resolve});
  } }).then(r=>{done=true;return r});
  await tick(); await tick();
  assert.equal(recovered,true); assert.equal(done,false);
  releaseDisplay(); const result = await pending;
  assert.deepEqual(partials,['first-pass','merged']);
  assert.deepEqual(result.words.map(w=>w.text),['hello','generations']);
});

test('display errors are reported only after workers settle and do not poison the OCR cache', async () => {
  const raw=deferredLane(),extra=deferredLane();let done=false;
  const pipeline=new ScreenOcrPipeline(raw.lane,extra.lane);
  const pending=pipeline.recognize(capture(),{onPartial:()=>{throw Error('display failed')}});
  pending.catch(()=>{done=true});
  await tick();raw.finish([word('hello',0)]);await tick();assert.equal(done,false);
  extra.finish([]);await assert.rejects(pending,/display failed/);assert.equal(pipeline.cache,null);
});
