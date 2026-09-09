import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { buildDemoGroup } from '../src/demo.js';

const base = process.env.SWEEP_BASE_URL || 'http://127.0.0.1:5190';
const output = 'output/playwright';
await mkdir(output, { recursive: true });
let server;
let browser;
const env = { ...process.env, VITE_API_BASE_URL: '', VITE_SUPABASE_URL: 'https://probable-qa.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'qa-public-key', VITE_ENABLE_DEV_AUTH_BYPASS: 'false',
  VITE_PUBLIC_APP_BASE_URL: base, VITE_PUBLIC_SHARE_BASE_URL: base };
const results = [];
const actor = '00000000-0000-4000-8000-000000000001';
function fixture() {
  return Object.assign(buildDemoGroup('QA Owner'), {
    id: 'qa-group', name: 'QA Friends', createdByUserId: actor,
    memberRecords: [{ userId: actor, name: 'QA Owner', balance: 100000 }],
    currentMemberName: 'QA Owner',
  });
}
async function scenario(name, run, { width = 390, signedIn = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const group = fixture();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const authenticated = Boolean(route.request().headers().authorization?.startsWith('Bearer '));
    return route.fulfill({ json: path.includes('market-catalog') ? { markets: [] }
      : path.endsWith('/entry') ? { entry: null }
      : { ...(authenticated ? { group } : {}), groups: authenticated ? [group] : [], rows: [], challenges: [] } });
  });
  await page.route('https://probable-qa.supabase.co/**', route => route.fulfill({ json: {} }));
  if (signedIn) await page.addInitScript(({ actor }) => {
    if (sessionStorage.getItem('qa-session-seeded')) return;
    sessionStorage.setItem('qa-session-seeded', 'true');
    const user = { id: actor, email: 'qa@example.test', user_metadata: { full_name: 'QA Owner' } };
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) + '.' + btoa(JSON.stringify({ sub: actor, exp })) + '.test';
    localStorage.setItem('sb-probable-qa-auth-token', JSON.stringify({ access_token: token, refresh_token: 'qa-refresh', expires_at: exp, expires_in: 3600, token_type: 'bearer', user }));
    for (const [key, value] of Object.entries({ probable_groupId: 'qa-group', probable_shell: 'app', probable_view: 'dashboard' })) localStorage.setItem(key, value);
  }, { actor });
  try {
    await run(page, group);
    assert.deepEqual(errors, [], 'No uncaught browser errors');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
    await page.screenshot({ path: `${output}/sweep-${name}.png`, fullPage: true });
    results.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: error.message, browserErrors: errors });
    console.error(`FAIL ${name}: ${error.message}`);
    console.log((await page.locator('body').innerText()).slice(0,7000));
    await page.screenshot({ path: `${output}/sweep-${name}-failure.png`, fullPage: true });
  } finally { await context.close(); }
}
async function audit(page) {
  await page.evaluate(() => document.fonts.ready);
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  assert.deepEqual(violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), [], 'Accessibility audit');
}
try {
  if (!process.env.SWEEP_BASE_URL) {
    execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', `${output}/sweep-dist`], { env, stdio: 'pipe' });
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '5190', '--strictPort', '--outDir', `${output}/sweep-dist`], { env, stdio: 'ignore' });
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (server.exitCode !== null) throw new Error('Usability preview failed to start');
      try { ready = (await fetch(base)).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('Usability preview did not become ready');
  }
  browser = await chromium.launch({ headless: true });
  await scenario('join-group-failure-and-retry', async page => {
    let requests = 0;
    await page.route('**/api/groups/new-qa-group/join', async route => {
      requests++;
      assert.ok(route.request().headers().authorization?.startsWith('Bearer '));
      await new Promise(resolve => setTimeout(resolve, 200));
      await route.fulfill(requests === 1 ? { status: 503, json: { detail: 'Unavailable' } }
        : { json: { groups: [{ ...fixture(), id: 'new-qa-group', name: 'Joined QA Group' }], memberName: 'QA Owner' } });
    });
    await page.goto(`${base}/app`);
    await page.getByRole('heading', { name: 'QA Friends', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Join group', exact: true }).click();
    const form = page.locator('#joinForm');
    await form.getByRole('textbox').fill('new-qa-group');
    await form.getByRole('button', { name: 'Join', exact: true }).click();
    assert.equal(await form.getByRole('button', { name: /Joining/ }).isDisabled(), true);
    await form.getByRole('alert').waitFor();
    assert.equal(await form.getByRole('textbox').inputValue(), 'new-qa-group');
    assert.equal(await form.isVisible(), true);
    await audit(page);
    await form.getByRole('button', { name: 'Join', exact: true }).click();
    await page.getByRole('heading', { name: 'Joined QA Group', exact: true }).waitFor();
    assert.equal(requests, 2);
  }, { width: 1280 });

  await scenario('market-creation-wizard', async (page, group) => {
    let creates = 0;
    await page.route('**/api/groups/qa-group/markets', async route => {
      creates++;
      const payload = route.request().postDataJSON();
      assert.equal(payload.question, 'Will the QA release ship on time?');
      assert.ok(payload.description.includes('release'));
      await route.fulfill({ json: { groups: [group] } });
    });
    await page.goto(`${base}/app`);
    await page.getByRole('button', { name: 'New market', exact: true }).click();
    const form = page.locator('#marketForm');
    await form.locator('[name="question"]').fill('Will the QA release ship on time?');
    await form.locator('[name="closesAt"]').fill('2027-01-01T18:00');
    await form.getByRole('button', { name: 'Continue', exact: true }).click();
    await form.locator('[name="description"]').fill('Resolves Yes if the release is published before the deadline. The release log is the source of truth.');
    await form.getByRole('button', { name: 'Continue', exact: true }).click();
    await form.getByRole('button', { name: 'Continue', exact: true }).click();
    await audit(page);
    await form.getByRole('button', { name: 'Create market', exact: true }).click();
    await form.waitFor({ state: 'hidden' });
    assert.equal(creates, 1);
  });

  await scenario('trade-ticket-validation-and-recovery', async (page, group) => {
    let trades = 0;
    await page.route('**/api/markets/*/quote', route => route.fulfill({ json: { quote: { shares: 8, price: 0.62, maxCash: 100000 } } }));
    await page.route('**/api/markets/*/trade', async route => {
      trades++;
      await route.fulfill({ status: 503, json: { detail: 'Unavailable' } });
    });
    await page.goto(`${base}/app`);
    await page.getByRole('button', { name: 'Yes', exact: true }).first().click();
    await page.getByRole('button', { name: 'Trade', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Amount to spend', exact: true });
    await input.waitFor();
    await input.fill('1000000');
    await input.dispatchEvent('input');
    assert.equal(await page.locator('.trade-form-el:visible [type="submit"]').isDisabled(), true);
    await input.fill('5');
    await input.dispatchEvent('input');
    await audit(page);
    const dialog = page.getByRole('dialog', { name: 'Trade market' });
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press('Tab');
      assert.ok(await dialog.evaluate(el => el.contains(document.activeElement)), 'Focus stays inside the mobile trade ticket');
    }
    await page.getByRole('button', { name: 'Buy YES', exact: true }).click();
    await page.getByRole('status').filter({ hasText: /temporarily|try again|unavailable/i }).waitFor();
    assert.equal(trades, 1);
    assert.equal(await input.inputValue(), '5');
    assert.equal(await page.getByRole('button', { name: 'Buy YES', exact: true }).isEnabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), false);
    assert.ok(await page.getByRole('button', { name: 'Trade', exact: true }).evaluate(el => el === document.activeElement));
  });

  await scenario('sign-out-clears-workspace', async page => {
    await page.goto(`${base}/app`);
    await page.getByRole('heading', { name: 'QA Friends', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByRole('heading', { name: /Put your hot takes/ }).waitFor();
    assert.equal(await page.getByText('QA Friends', { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('sb-probable-qa-auth-token')), null);
    assert.equal(await page.evaluate(() => localStorage.getItem('probable_boot_cache_v1')), null);
    await page.reload();
    await page.getByRole('heading', { name: /Put your hot takes/ }).waitFor();
    assert.equal(await page.getByRole('button', { name: /Open QA Friends/ }).count(), 0);
    assert.equal(await page.getByText('QA Friends', { exact: true }).count(), 0);
    await audit(page);
  });

  await scenario('anonymous-does-not-restore-private-cache', async (page, group) => {
    await page.addInitScript(group => {
      localStorage.setItem('probable_boot_cache_v1', JSON.stringify({ groups: [group], currentGroupId: group.id, activeMember: 'QA Owner', savedAt: Date.now() }));
    }, group);
    await page.goto(base);
    await page.getByRole('heading', { name: /Put your hot takes/ }).waitFor();
    assert.equal(await page.getByRole('button', { name: /Open QA Friends/ }).count(), 0);
    await audit(page);
  }, { signedIn: false });

  await scenario('practice-trade-and-sell', async page => {
    await page.goto(base);
    await page.getByRole('button', { name: 'Try a practice market', exact: true }).click();
    await page.getByRole('button', { name: 'Trade', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Amount to spend', exact: true });
    await input.fill('5');
    await input.dispatchEvent('input');
    await page.getByRole('button', { name: 'Buy YES', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'You bought YES.' }).waitFor();
    await page.getByRole('button', { name: 'Trade', exact: true }).click();
    await page.getByRole('button', { name: 'Sell', exact: true }).click();
    const shares = page.getByRole('textbox', { name: 'Shares to sell', exact: true });
    await shares.fill('1');
    await shares.dispatchEvent('input');
    await page.getByRole('button', { name: 'Sell YES', exact: true }).click();
    await page.getByRole('status').filter({ hasText: /sold YES/i }).waitFor();
    await audit(page);
  }, { signedIn: false });
} finally {
  await browser?.close();
  server?.kill('SIGTERM');
  await writeFile(`${output}/usability-sweep-results.json`, JSON.stringify(results, null, 2));
}
console.log(`${results.filter(r => r.passed).length}/${results.length} additional usability scenarios passed`);
if (results.some(r => !r.passed)) process.exitCode = 1;
