import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawn, execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import {buildDemoGroup} from '../src/demo.js';

const base = 'http://127.0.0.1:5187';
const output = 'output/playwright';
await fs.mkdir(output, {recursive:true});
const env = {...process.env, VITE_API_BASE_URL:'', VITE_SUPABASE_URL:'https://probable-qa.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY:'qa-public-key', VITE_ENABLE_DEV_AUTH_BYPASS:'false',
  VITE_PUBLIC_APP_BASE_URL:base, VITE_PUBLIC_SHARE_BASE_URL:base};
execFileSync(process.execPath, ['node_modules/vite/bin/vite.js','build','--outDir',`${output}/dist`], {env,stdio:'pipe'});
const server=spawn(process.execPath, ['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','5187','--strictPort','--outDir',`${output}/dist`], {env,stdio:'pipe'});
let serverLog='';
server.stderr.on('data',data=>{serverLog+=data;});
const checks=[];
let browser;
const actor='00000000-0000-0000-0000-000000000001';
const fixture=buildDemoGroup('QA Owner');
fixture.id='qa-group';
fixture.name='QA Friends';
fixture.createdByUserId=actor;
fixture.memberRecords=[{userId:actor,name:'QA Owner',balance:100000}];
fixture.currentMemberName='QA Owner';

async function scenario(name, run, {width=1280,height=800,signedIn=false}={}) {
  const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce'});
  const page=await context.newPage();
  const errors=[];
  page.on('pageerror', error=>errors.push(error.message));
  const calls=[];
  await context.route('**/api/**',async route=>{
    calls.push({url:route.request().url(),method:route.request().method()});
    const url=new URL(route.request().url());
    if(url.pathname==='/api/groups') return route.fulfill({json:{groups:signedIn?[fixture]:[]}});
    if(url.pathname==='/api/market-catalog') return route.fulfill({json:{markets:[]}});
    if(url.pathname==='/api/ready') return route.fulfill({status:404,json:{detail:'Not found'}});
    if(url.pathname.endsWith('/context')) return route.fulfill({json:{group:fixture,groups:[fixture]}});
    if(url.pathname.endsWith('/entry')) return route.fulfill({json:{entry:null}});
    return route.fulfill({json:{groups:signedIn?[fixture]:[],rows:[],challenges:[]}});
  });
  await context.route('https://probable-qa.supabase.co/**',route=>route.fulfill({json:{}}));
  if(signedIn) {
    const now=Math.floor(Date.now()/1000);
    const payload=Buffer.from(JSON.stringify({sub:actor,exp:now+3600,role:'authenticated'})).toString('base64url');
    await context.addInitScript(({actor,payload,now})=>{
      localStorage.setItem('sb-probable-qa-auth-token',JSON.stringify({access_token:`eyJhbGciOiJIUzI1NiJ9.${payload}.qa`,refresh_token:'qa-refresh',token_type:'bearer',expires_in:3600,expires_at:now+3600,user:{id:actor,email:'qa@example.test',user_metadata:{full_name:'QA Owner'}}}));
      localStorage.setItem('probable_groupId','qa-group');
      localStorage.setItem('probable_shell','app');
      localStorage.setItem('probable_view','dashboard');
    },{actor,payload,now});
  }
  try {
    await run(page,context,calls);
    assert.deepEqual(errors,[], 'No uncaught browser exceptions');
    checks.push({name,status:'passed'});
    console.log(`PASS ${name}`);
  } catch(error) {
    checks.push({name,status:'failed',error:error.message});
    console.error(`FAIL ${name}: ${error.message}`);
    await page.screenshot({path:`${output}/failure-${name.replaceAll(/[^a-z0-9]+/gi,'-')}.png`}).catch(()=>{});
  } finally {await context.close();}
}

async function accessible(page,name) {
  const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  await fs.writeFile(`${output}/axe-${name}.json`,JSON.stringify(result.violations,null,2));
  assert.deepEqual(result.violations.map(v=>`${v.id}: ${v.nodes.map(n=>n.target.join(' ')).join(', ')}`),[], 'Accessibility violations');
}
async function noOverflow(page) {
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), 'No horizontal page overflow');
}

try {
  let ready=false;
  for(let i=0;i<60;i++) {
    if(server.exitCode!==null)throw new Error(`Preview failed: ${serverLog}`);
    try {ready=(await fetch(base)).ok;} catch {}
    if(ready)break;
    await delay(100);
  }
  if(!ready)throw new Error('Preview did not start');
  browser=await chromium.launch({headless:true});
  for(const width of [1280,768,390,320]) {
    await scenario(`Landing at ${width}px`,async(page,context,calls)=>{
      await page.goto(base);
      await page.getByRole('heading',{name:'Put your hot takes on the line.'}).waitFor();
      await noOverflow(page);
      assert.equal(await page.getByText('Practice market',{exact:true}).count(),0);
      assert.equal(calls.filter(c=>c.url.includes('/api/ready')).length,0,'Landing is independent of readiness/deployment order');
      await accessible(page,`landing-${width}`);
      await page.screenshot({path:`${output}/landing-${width}.png`,fullPage:true});
    },{width,height:844});
  }
  await scenario('Sign-in keyboard focus and mobile layout',async page=>{
    await page.goto(base);
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Sign in to Probable'});
    await dialog.waitFor();
    assert(await dialog.evaluate(el=>el.contains(document.activeElement)));
    for(let i=0;i<12;i++) {
      await page.keyboard.press('Tab');
      assert(await dialog.evaluate(el=>el.contains(document.activeElement)),'Focus stays inside sign-in');
    }
    await accessible(page,'signin-mobile');
    await noOverflow(page);
    await page.screenshot({path:`${output}/signin-mobile.png`,fullPage:true});
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(),false);
    assert(await page.getByRole('button',{name:'Sign in',exact:true}).evaluate(el=>el===document.activeElement));
  },{width:390,height:844});
  await scenario('Production sign-in offers Google only without unnecessary fields',async page=>{
    await page.goto(base);
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Sign in to Probable'});
    assert(await dialog.getByRole('button',{name:'Continue with Google',exact:true}).isVisible());
    assert.equal(await dialog.getByLabel('Email address').count(),0);
    assert.equal(await dialog.getByLabel('Display name').isVisible(),false);
    assert.equal((await dialog.innerText()).includes('email link'),false);
  });
  await scenario('Google sign-in preserves the return URL and never sends email',async(page,context)=>{
    let emailRequests=0;
    await context.route('**/auth/v1/otp**',route=>{emailRequests++;return route.fulfill({json:{}});});
    await context.route('**/auth/v1/authorize**',route=>route.fulfill({contentType:'text/html',body:'<p>OAuth handoff</p>'}));
    const returnUrl=base+'/bracket';
    await page.goto(returnUrl);
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.getByRole('button',{name:'Continue with Google',exact:true}).click();
    await page.waitForURL('https://probable-qa.supabase.co/auth/v1/authorize**');
    const target=new URL(page.url());
    assert.equal(target.searchParams.get('provider'),'google');
    assert.equal(target.searchParams.get('redirect_to'),returnUrl);
    assert.equal(emailRequests,0);
  });
  await scenario('Practice market is explicit and can be exited',async page=>{
    await page.goto(base);
    await page.getByRole('button',{name:'Try a practice market'}).click();
    await page.getByText('Simulated trades. Nothing here affects your account.').waitFor();
    await noOverflow(page);
    await page.screenshot({path:`${output}/practice-mobile.png`,fullPage:true});
    await page.getByRole('button',{name:'Exit practice'}).click();
    await page.getByRole('heading',{name:'Put your hot takes on the line.'}).waitFor();
  },{width:390,height:844});
  await scenario('Catalog outage stops retrying and supports manual recovery',async(page,context)=>{
    let requests=0;
    await context.route('**/api/market-catalog',route=>{requests++;return route.fulfill({status:503,json:{detail:'Internal database failure'}});});
    await page.goto(`${base}/markets`);
    await page.getByText('We could not connect to Probable.',{exact:false}).waitFor();
    await delay(600);
    assert.equal(requests,1,'Failure must not start an automatic request/render loop');
    await page.getByRole('button',{name:'Try again',exact:true}).click();
    await delay(200);
    assert.equal(requests,2);
    await accessible(page,'catalog-error');
  });
  await scenario('Missing market link has a retry and home path',async(page,context)=>{
    await context.route('**/api/markets/missing/context',route=>route.fulfill({status:404,json:{detail:'This market could not be found.'}}));
    await page.goto(`${base}/market/missing`);
    await page.getByRole('heading',{name:'Could not open this market'}).waitFor();
    assert(await page.getByRole('button',{name:'Try again'}).isVisible());
    await accessible(page,'missing-market');
    await page.getByRole('button',{name:'Back to home'}).click();
    await page.getByRole('heading',{name:'Put your hot takes on the line.'}).waitFor();
  });
  await scenario('Signed-in workspace loads with a real-session-shaped token',async page=>{
    await page.goto(`${base}/app`);
    await page.getByRole('heading',{name:'QA Friends',exact:true}).waitFor();
    await noOverflow(page);
    await page.screenshot({path:`${output}/workspace-desktop.png`,fullPage:true});
    await accessible(page,'workspace');
  },{signedIn:true});
  await scenario('Signed-in server failure is recoverable without demo fallback',async(page,context)=>{
    await context.route('**/api/groups?*',route=>route.fulfill({status:503,json:{detail:'Internal connection string'}}));
    await page.goto(`${base}/app`);
    await page.getByRole('heading',{name:'Could not load your workspace'}).waitFor();
    assert.equal(await page.getByText('Practice market',{exact:true}).count(),0);
    assert.equal((await page.locator('body').innerText()).includes('Internal connection string'),false);
    await page.screenshot({path:`${output}/workspace-recovery.png`});
    await accessible(page,'workspace-error');
  },{signedIn:true});
  await scenario('Group creation preserves input on failure and submits once on retry',async(page,context)=>{
    let requests=0;
    let lastBody;
    await context.route('**/api/groups',async route=>{
      if(route.request().method()!=='POST')return route.fulfill({json:{groups:[fixture]}});
      requests++;
      lastBody=route.request().postDataJSON();
      assert.match(route.request().headers().authorization,/^Bearer /);
      await delay(150);
      if(requests===1)return route.fulfill({status:503,json:{detail:'Temporary database error'}});
      return route.fulfill({json:{groups:[{...fixture,name:lastBody.name}],groupId:fixture.id}});
    });
    await page.goto(`${base}/app`);
    await page.getByRole('button',{name:'Create group',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Create group'});
    await dialog.getByLabel('Group name').fill('QA Friday Picks');
    const submit=dialog.getByRole('button',{name:'Create',exact:true});
    await submit.click();
    assert.equal(await submit.isEnabled(),false);
    await dialog.getByRole('alert').waitFor();
    assert(await dialog.isVisible());
    assert.equal(await dialog.getByLabel('Group name').inputValue(),'QA Friday Picks');
    await submit.click();
    await page.getByRole('heading',{name:'QA Friday Picks',exact:true}).waitFor();
    assert.equal(requests,2);
    assert.equal(lastBody.name,'QA Friday Picks');
    assert.equal(await dialog.isVisible(),false);
  },{signedIn:true});
  await scenario('Predictor and bracket routes survive refresh on mobile',async page=>{
    for(const path of ['/premier-league-predictor','/bracket']) {
      await page.goto(`${base}${path}`);
      await page.getByRole('heading').first().waitFor();
      await noOverflow(page);
      await page.reload();
      await page.getByRole('heading').first().waitFor();
      await page.waitForFunction(() => document.querySelector('.pl-pick-progress, .bracket-mobile-svg'));
      await noOverflow(page);
      await accessible(page, `${path.slice(1)}-mobile`);
      await page.screenshot({path:`${output}/${path.slice(1)}-mobile.png`,fullPage:true});
    }
  },{width:390,height:844});
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await fs.writeFile(`${output}/ui-regression-results.json`,JSON.stringify({scope:'Production build with isolated API/auth fixtures',checks},null,2));
}
console.log(`${checks.filter(c=>c.status==='passed').length}/${checks.length} browser scenarios passed`);
if(checks.some(c=>c.status==='failed'))process.exitCode=1;
