import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { openChrome, pause } from '../../scripts/lib/cdp.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const out=join(root,'screenshots');
await mkdir(out,{recursive:true});
const url=pathToFileURL(join(root,'mockup/index.html')).href;
const tab=await openChrome(url,{width:1440,height:1080});
const checks=[];
async function check(name,expression){assert.equal(await tab.evaluate(expression),true,name);checks.push(name);}
async function capture(name){await tab.evaluate("document.getElementById('toast').style.display='none'");const tall=/^(03|04|07)-/.test(name);if(tall)await tab.send('Emulation.setDeviceMetricsOverride',{width:1440,height:name.startsWith('04-')?1850:1550,deviceScaleFactor:1,mobile:false});await pause(100);await writeFile(join(out,`${name}.png`),await tab.screenshot());if(tall)await tab.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1080,deviceScaleFactor:1,mobile:false});}
async function scene(name){await tab.evaluate(`scenario(${JSON.stringify(name)})`);await pause(150);}
try{
  await tab.send('Page.addScriptToEvaluateOnNewDocument',{source:'window.__errors=[];window.addEventListener("error",e=>window.__errors.push(e.message));'});
  await tab.goto('#home',400);
  await capture('01-desktop-entry');
  await check('Empty text never analyzes',`(document.querySelector('[data-action="analyze"]').click(),!state.busy&&!state.draft)`);
  await tab.evaluate(`state.input=defaultText;analyze()`);await pause(550);
  await check('Text fixture is editable with RM77 total',`totals().net===7700 && !document.getElementById('save-button').disabled && document.querySelectorAll('.line-item').length===3`);
  await capture('02-desktop-text-review');
  await tab.evaluate(`const input=document.querySelector('[data-line="line-1"][data-key="amount"]');input.value='11.50';input.dispatchEvent(new Event('input',{bubbles:true}));`);
  await check('Editing amount recalculates',`totals().net===7850 && document.getElementById('save-total').textContent==='RM 78.50'`);
  await tab.evaluate(`state.draft.paid='';refreshSummary()`);
  await check('Missing payment blocks save',`document.getElementById('save-button').disabled && issue().includes('付款')`);
  await tab.evaluate(`state.draft.paid='paid';state.draft.lines[0].amount='10.00';refreshSummary();document.getElementById('save-button').click();document.getElementById('save-button').click();`);await pause(550);
  await check('One explicit confirm produces one in-memory record',`state.saved.length===1 && route==='saved' && state.saved[0].net===7700`);
  await capture('06-desktop-saved');
  await scene('receipt');
  await check('Desktop receipt source remains visible',`document.querySelector('.source-collapse').open && getComputedStyle(document.querySelector('.source-collapse')).display!=='none' && document.querySelector('.receipt-preview').getBoundingClientRect().width>0`);
  await check('Receipt discount allocated exactly once',`totals().gross===5400 && totals().net===5200 && netLines().reduce((a,b)=>a+b,0)===5200 && JSON.stringify(netLines())==='[963,3081,1156]'`);
  await capture('03-desktop-receipt-review');
  await scene('difference');
  await check('Receipt difference prevents posting',`totals().net===5500 && document.getElementById('save-button').disabled`);
  await capture('04-desktop-receipt-difference');
  await tab.evaluate(`document.querySelector('[data-action="override"]').click();document.querySelector('[data-action="confirm-override"]').click()`);
  await check('Difference requires reason',`document.getElementById('dialog').open && state.draft.override===null`);
  await tab.evaluate(`document.getElementById('override-reason').value='核对原图，肉碎实际为35';document.querySelector('[data-action="confirm-override"]').click()`);
  await check('Explicit override preserves original total',`state.draft.override===5500 && state.draft.declared===5200 && !document.getElementById('save-button').disabled`);
  await tab.evaluate(`state.draft.lines[0].amount='11.00';refreshSummary()`);
  await check('Later money edit invalidates override',`document.getElementById('save-button').disabled`);
  await scene('backup');await capture('05-desktop-backup');
  await scene('failure');
  await check('Provider failure offers manual entry',`!!document.querySelector('.demo-error [data-action="manual"]')`);
  await capture('08-desktop-provider-failure');
  await tab.evaluate(`document.querySelector('.demo-error [data-action="manual"]').click()`);await pause(120);
  await check('Manual draft does not invent quantity or payment',`state.draft.lines.length===1 && state.draft.lines[0].quantity==='' && state.draft.paid==='' && document.getElementById('save-button').disabled`);
  await tab.evaluate(`go('history')`);await pause(100);
  await tab.evaluate(`let s=document.getElementById('history-search');s.value='肉碎';s.dispatchEvent(new Event('input',{bubbles:true}));`);
  await check('Record search filters real demo rows',`document.querySelectorAll('.history-row').length===2`);
  await tab.evaluate(`go('analysis');state.answer=true;render()`);await pause(100);await capture('07-desktop-analysis');
  await check('Category chart renders visible bars',`[...document.querySelectorAll('.category-fill')].length===6 && [...document.querySelectorAll('.category-fill')].every(el=>el.getBoundingClientRect().height===10&&el.getBoundingClientRect().width>0)`);
  await check('Monthly stats include confirmed record once',`monthTotals().total===291770 && monthTotals().paid===257770 && monthTotals().unpaid===34000`);
  await tab.evaluate(`go('upload')`);await pause(100);
  await tab.evaluate(`addFiles([new File(['demo'],'preview.png',{type:'image/png'})])`);
  await check('Uploaded photos are preview only, explicitly labeled',`state.files.length===1 && document.body.textContent.includes('不会读取照片内容')`);
  for(const width of [1440,1024,768,390,375]){
    await tab.send('Emulation.setDeviceMetricsOverride',{width,height:width<768?844:1080,deviceScaleFactor:1,mobile:width<768});
    for(const view of ['home','text','receipt','difference','analysis']){
      await scene(view);
      await check(`${width}px ${view} has no horizontal page overflow`,`document.documentElement.scrollWidth<=innerWidth+1`);
      if(width<768&&['text','receipt'].includes(view))await check(`${width}px source collapses but stays accessible`,`!document.querySelector('.source-collapse').open && document.querySelector('.source-collapse>summary').getBoundingClientRect().height>=35`);
      if(width===390&&['home','text','receipt','analysis'].includes(view))await capture(`phone-${view}`);
      if(width<768&&['text','receipt'].includes(view))await check(`${width}px save action stays in viewport`,`(()=>{const r=document.querySelector('.save-dock').getBoundingClientRect();return r.bottom<=innerHeight+1&&r.left>=0&&r.right<=innerWidth+1})()`);
    }
  }
  await check('No JavaScript runtime errors',`window.__errors.length===0`);
  await writeFile(join(root,'prototype-verification.json'),JSON.stringify({verifiedAt:new Date().toISOString(),scope:'Standalone prototype only, not live AI or backend',checks},null,2)+'\n');
  console.log(`PASS: ${checks.length} prototype checks; screenshots in ${out}`);
}finally{await tab.close();}
