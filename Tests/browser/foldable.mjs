// Layout on folding phones, simulated in the browser: the cover screen (phone layout), the
// unfolded inner screen of a Honor Magic V (≈ 820×890 CSS px), book posture (sidebar left of the
// hinge, page right of it), a flat vertical fold (task panel fills the right pane) and tabletop
// posture (work above the fold, panel below). The Android app sends the same hinge data through
// window.mkSetFold(); see web/src/fold.ts. Needs Playwright and the Worker on :8797 (fresh DB).
import { chromium } from 'playwright';
const BASE = `http://127.0.0.1:${process.env.PORT ?? 8797}`;
const SHOTS = process.env.SHOTS;   // optional folder for screenshots
let failures = 0;
const check = (n, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n} ${extra}`); if (!ok) failures++; };
const browser = await chromium.launch();
const errors = [];
const email = `fold-${Date.now()}@example.test`, pw = 'foldable-pass-123';

// Sign up once at desktop size and create a workspace with a task.
let ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
let page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(BASE + '/');
await page.click('.seg button:nth-child(2)');
await page.fill('input[autocomplete="name"]', 'Mohamad');
await page.fill('input[type="email"]', email);
await page.fill('input[type="password"]', pw);
await page.click('button.btn.primary');
await page.waitForSelector('text=Save your recovery code', { timeout: 30000 });
await page.click('input[type="checkbox"]');
await page.click('button.btn.primary');
await page.waitForSelector('text=Choose a workspace');
await page.fill('input[placeholder="New workspace name"]', 'Procurement');
await page.click('button.btn.primary:has-text("Create")');
await page.waitForSelector('.side'); await page.waitForTimeout(2500);
await page.goto(BASE + '/#/everything'); await page.waitForTimeout(600);
await page.fill('.quick-add input', 'Review cleaning tender');
await page.keyboard.press('Enter');
await page.waitForTimeout(3500);   // synced
await ctx.close();

async function open(width, height, mobile) {
  const c = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2 });
  const p = await c.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/');
  await p.fill('input[type="email"]', email);
  await p.fill('input[type="password"]', pw);
  await p.click('button.btn.primary');
  await p.waitForSelector('.app', { timeout: 30000 });
  await p.waitForTimeout(1500);
  return { c, p };
}
const box = async (p, sel) => p.locator(sel).first().boundingBox();
const fold = (p, f) => p.evaluate((f) => window.mkSetFold(f), f);
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png` }); };
const openTaskDrawer = async (p) => {
  await p.goto(BASE + '/#/everything'); await p.waitForTimeout(700);
  await p.locator('.trow').first().click(); await p.waitForSelector('.drawer'); await p.waitForTimeout(300);
};

// 1. Cover screen: a normal phone.
let { c, p } = await open(390, 844, true);
check('cover screen: phone layout (menu button, sidebar hidden)', await p.locator('.menu-btn').isVisible() && (await box(p, '.side')).x < 0);
await shot(p, 'fold-1-cover');
await c.close();

// 2. Unfolded, flat, no hinge info (or a fold the device reports as not separating).
({ c, p } = await open(820, 890, true));
const side = await box(p, '.side');
check('unfolded: sidebar stays visible next to the page', side.x === 0 && side.width >= 200 && side.width <= 230 && !(await p.locator('.menu-btn').isVisible()), JSON.stringify(side));
check('unfolded: no horizontal scrolling', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
await shot(p, 'fold-2-unfolded');

// 3. Flat with a vertical fold reported: the task panel fills the right pane exactly.
await fold(p, { orientation: 'vertical', state: 'flat', separating: false, x: 404, y: 0, width: 12, height: 890 });
await openTaskDrawer(p);
let d = await box(p, '.drawer');
check('flat fold: task panel starts at the hinge and fills the right pane', Math.round(d.x) === 416 && Math.round(d.x + d.width) === 820, JSON.stringify(d));
await shot(p, 'fold-3-flat-drawer');
await p.keyboard.press('Escape');

// 4. Book posture: sidebar = left pane, page = right pane.
await fold(p, { orientation: 'vertical', state: 'half', separating: true, x: 404, y: 0, width: 12, height: 890 });
await p.goto(BASE + '/#/home'); await p.waitForTimeout(500);
const s4 = await box(p, '.side'), m4 = await box(p, '.main');
check('book posture: sidebar fills the left pane', s4.x === 0 && Math.round(s4.width) === 404, JSON.stringify(s4));
check('book posture: page starts right of the hinge', Math.round(m4.x) === 416 && Math.round(m4.x + m4.width) === 820, JSON.stringify(m4));
await shot(p, 'fold-4-book');

// 5. Tabletop posture: horizontal fold half-open: app above, task panel below.
await fold(p, { orientation: 'horizontal', state: 'half', separating: true, x: 0, y: 430, width: 820, height: 14 });
await openTaskDrawer(p);
const a5 = await box(p, '.app'); d = await box(p, '.drawer');
check('tabletop: app above the fold', Math.round(a5.height) === 430, JSON.stringify(a5));
check('tabletop: task panel below the fold', Math.round(d.y) === 444 && Math.round(d.width) === 820, JSON.stringify(d));
await shot(p, 'fold-5-tabletop');
await p.keyboard.press('Escape');

// 6. Unfolding back to flat with no fold: everything returns to the normal layout.
await fold(p, null);
await p.waitForTimeout(200);
check('fold removed: normal layout again', !(await p.evaluate(() => document.documentElement.className.includes('fold'))) && Math.round((await box(p, '.side')).width) <= 230);
await c.close();

// 7. Small split-screen half (e.g. 2 apps side by side on the inner screen): phone layout.
({ c, p } = await open(410, 890, true));
check('split-screen half: phone layout', await p.locator('.menu-btn').isVisible());
await c.close();

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(failures ? `\n${failures} FAILED` : '\nall foldable checks passed');
process.exit(failures ? 1 : 0);
