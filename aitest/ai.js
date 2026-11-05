const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const out = 'aitest/out'; fs.mkdirSync(out, { recursive: true });
  const log = []; const L = (...a) => { const s = a.join(' '); console.log(s); log.push(s); };
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  p.on('console', m => { if (m.type() === 'error') L('CONSOLE ERROR', m.text()); });
  p.on('pageerror', e => L('PAGE ERROR', e.message));
  try {
    await p.goto('http://localhost:8080/#/login', { waitUntil: 'networkidle' });
    await p.waitForTimeout(1500);
    const btn = p.locator('button[data-a="demoLogin"]', { hasText: 'Courier' });
    L('demo buttons', await p.locator('button[data-a="demoLogin"]').count());
    await btn.first().click();
    await p.waitForTimeout(4000);
    await p.goto('http://localhost:8080/#/admin', { waitUntil: 'networkidle' });
    await p.waitForSelector('.console', { timeout: 20000 });
    L('admin console ok');
    await p.click('button[data-a="aTab"][data-v="ai"]');
    await p.waitForSelector('.agents', { timeout: 20000 });
    await p.waitForTimeout(2500);
    L('agent cards', await p.locator('.agent').count());
    L('kpis', (await p.locator('.kpi').allInnerTexts()).map(t => t.replace(/\s+/g, ' ')).join(' | '));
    L('feed items', await p.locator('[data-sc="aifeed"] .ev').count());
    L('forecast cols', await p.locator('.fc .col').count());
    L('approvals', (await p.locator('.card', { hasText: 'Waiting for your approval' }).innerText()).replace(/\s+/g, ' ').slice(0, 400));
    await p.screenshot({ path: out + '/ai-desktop.png', fullPage: true });
    await p.click('button[data-a="cpAsk"][data-v="How are we doing today?"]');
    await p.waitForSelector('.msg.a .src', { timeout: 30000 });
    L('copilot answer 1', (await p.locator('.msg.a').last().innerText()).replace(/\s+/g, ' '));
    await p.fill('.cp-form input[name="q"]', 'Do we have enough couriers for the next hour?');
    await p.press('.cp-form input[name="q"]', 'Enter');
    await p.waitForFunction(() => document.querySelectorAll('.msg.a .src').length >= 2, null, { timeout: 30000 });
    L('copilot answer 2', (await p.locator('.msg.a').last().innerText()).replace(/\s+/g, ' '));
    await p.screenshot({ path: out + '/ai-copilot.png' });
    // toggle Executive AI off and on again
    const sw = p.locator('button[data-a="agentToggle"][data-v="copilot"]');
    await sw.click(); await p.waitForTimeout(2500);
    L('copilot switch after off', await p.locator('button[data-a="agentToggle"][data-v="copilot"]').getAttribute('aria-checked'));
    await p.locator('button[data-a="agentToggle"][data-v="copilot"]').click(); await p.waitForTimeout(2500);
    L('copilot switch after on', await p.locator('button[data-a="agentToggle"][data-v="copilot"]').getAttribute('aria-checked'));
    await p.click('button[data-a="agentRun"]'); await p.waitForTimeout(3000);
    L('toasts', (await p.locator('#toasts').innerText()).replace(/\s+/g, ' '));
    // wait for realtime feed growth
    const n1 = await p.locator('[data-sc="aifeed"] .ev').count(); await p.waitForTimeout(20000);
    const n2 = await p.locator('[data-sc="aifeed"] .ev').count(); L('feed before/after 20s', n1, n2);
    const first = await p.locator('[data-sc="aifeed"] .ev').first().innerText(); L('latest event', first.replace(/\s+/g, ' '));
    await p.screenshot({ path: out + '/ai-desktop-2.png', fullPage: true });
    for (const t of ['overview', 'insights', 'refunds']) {
      await p.click(`button[data-a="aTab"][data-v="${t}"]`); await p.waitForTimeout(2500);
      L('tab', t, 'ok', (await p.locator('.cmain h1').first().innerText()));
    }
    await p.screenshot({ path: out + '/insights.png' });
    await p.setViewportSize({ width: 390, height: 844 });
    await p.click('button[data-a="aTab"][data-v="ai"]'); await p.waitForTimeout(3000);
    await p.screenshot({ path: out + '/ai-mobile.png', fullPage: true });
    const ov = await p.evaluate(() => document.documentElement.scrollWidth); L('mobile scrollWidth', ov);
  } catch (e) { L('FAIL', e.message); await p.screenshot({ path: out + '/fail.png', fullPage: true }).catch(() => {}); }
  fs.writeFileSync(out + '/log.txt', log.join('\n'));
  await b.close();
})();
