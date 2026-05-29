const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIAGNOSE = process.argv.includes('--diagnose');
const HEADLESS = !process.argv.includes('--headed');

const CONFIG = {
  baseUrl: 'https://pims.housingandurban.go.ke/home',
  loginUrl: 'https://pims.housingandurban.go.ke/home',
  credentials: { username: 'systemdev', password: 'Systemdev54!' },
  outputDir: path.join(os.homedir(), 'Desktop', 'app-screenshots'),
  storageStatePath: path.join(process.cwd(), 'storageState.json'),
  maxPages: 300,
  maxDepth: 5,
  headless: HEADLESS,
  executablePath: process.env.CHROME_PATH || undefined,
};

const visited = new Set();
const pageIndex = {};
const navigationTree = [];
let screenshotCount = 0;
let errorCount = 0;

function sanitizePath(url) {
  try {
    const u = new URL(url);
    let p = u.pathname + (u.hash ? u.hash.replace('#', '_hash_') : '');
    p = p.replace(/^\//, '').replace(/\//g, '_').replace(/[^a-zA-Z0-9_\-]/g, '_') || 'index';
    return p || 'index';
  } catch {
    return 'unknown_' + Date.now();
  }
}

function normalizeUrl(url, base) {
  try {
    const u = new URL(url, base);
    u.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', '_', 'timestamp'].forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch {
    return null;
  }
}

function isSameDomain(url, base) {
  try {
    return new URL(url).hostname === new URL(base).hostname;
  } catch {
    return false;
  }
}

async function injectStabilityCSS(page) {
  await page.addStyleTag({
    content: `*, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
    }`,
  }).catch(() => {});
}

async function scrollPage(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let totalHeight = 0;
      const distance = 300;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 80);
      setTimeout(() => { clearInterval(timer); window.scrollTo(0, 0); resolve(); }, 8000);
    });
  }).catch(() => {});
}

async function takeScreenshot(page, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await page.screenshot({ path: filePath, fullPage: true });
  screenshotCount++;
  console.log(`  📸 ${filePath}`);
}

async function captureUIStates(page, baseDir, baseName) {
  const screenshots = ['base'];
  await takeScreenshot(page, path.join(baseDir, baseName + '.png'));

  // Modals
  const modalTriggers = await page.$$('[data-toggle="modal"], [data-bs-toggle="modal"], button.modal-trigger').catch(() => []);
  for (let i = 0; i < Math.min(modalTriggers.length, 3); i++) {
    try {
      await modalTriggers[i].click();
      await page.waitForTimeout(600);
      const modal = await page.$('.modal.show, [role="dialog"]').catch(() => null);
      if (modal) {
        const f = path.join(baseDir, `${baseName}_modal_${i}.png`);
        await takeScreenshot(page, f);
        screenshots.push(`modal_${i}`);
        const closeBtn = await page.$('.modal.show .btn-close, .modal.show [data-dismiss="modal"], .modal.show [data-bs-dismiss="modal"], .modal.show .close').catch(() => null);
        if (closeBtn) await closeBtn.click().catch(() => {});
        else await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
      }
    } catch {}
  }

  // Dropdowns
  const dropdowns = await page.$$('[data-toggle="dropdown"], [data-bs-toggle="dropdown"], .dropdown-toggle').catch(() => []);
  for (let i = 0; i < Math.min(dropdowns.length, 3); i++) {
    try {
      await dropdowns[i].click();
      await page.waitForTimeout(400);
      const menu = await page.$('.dropdown-menu.show').catch(() => null);
      if (menu) {
        const f = path.join(baseDir, `${baseName}_dropdown_${i}.png`);
        await takeScreenshot(page, f);
        screenshots.push(`dropdown_${i}`);
        await dropdowns[i].click().catch(() => {});
        await page.waitForTimeout(300);
      }
    } catch {}
  }

  // Expandable / accordion
  const expandables = await page.$$('[data-toggle="collapse"], [data-bs-toggle="collapse"], .accordion-button, details summary').catch(() => []);
  for (let i = 0; i < Math.min(expandables.length, 3); i++) {
    try {
      await expandables[i].click();
      await page.waitForTimeout(400);
      const f = path.join(baseDir, `${baseName}_expanded_${i}.png`);
      await takeScreenshot(page, f);
      screenshots.push(`expanded_${i}`);
      await expandables[i].click().catch(() => {});
      await page.waitForTimeout(300);
    } catch {}
  }

  return screenshots;
}

async function discoverLinks(page) {
  return page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    return anchors
      .map(a => a.href)
      .filter(h => h && !h.startsWith('javascript:') && !h.startsWith('mailto:') && !h.startsWith('tel:'));
  }).catch(() => []);
}

async function discoverNavLinks(page) {
  return page.evaluate(() => {
    const sel = '.sidebar a, nav a, .navbar a, .menu a, [class*="sidebar"] a, [class*="nav-"] a, [id*="sidebar"] a, [id*="menu"] a';
    return Array.from(document.querySelectorAll(sel))
      .map(a => a.href)
      .filter(h => h && !h.startsWith('javascript:') && !h.startsWith('mailto:'));
  }).catch(() => []);
}

// ─── Diagnose mode ───────────────────────────────────────────────────────────
async function diagnose() {
  console.log('\n🔬 DIAGNOSE MODE — inspecting login page\n');
  const browser = await chromium.launch({ headless: false, executablePath: CONFIG.executablePath });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  await page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle', timeout: 30000 });
  console.log('URL after load:', page.url());

  const inputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input')).map(i => ({
      tag: 'input', type: i.type, name: i.name, id: i.id, placeholder: i.placeholder, className: i.className,
    }))
  );
  const buttons = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button, input[type=submit]')).map(b => ({
      tag: b.tagName, type: b.type, text: b.innerText?.trim(), id: b.id, className: b.className,
    }))
  );
  const forms = await page.evaluate(() =>
    Array.from(document.querySelectorAll('form')).map(f => ({
      id: f.id, action: f.action, method: f.method, className: f.className,
    }))
  );

  console.log('\n📋 Forms found:');
  console.log(JSON.stringify(forms, null, 2));
  console.log('\n📋 Inputs found:');
  console.log(JSON.stringify(inputs, null, 2));
  console.log('\n📋 Buttons found:');
  console.log(JSON.stringify(buttons, null, 2));

  const diagDir = path.join(CONFIG.outputDir, 'diagnose');
  fs.mkdirSync(diagDir, { recursive: true });
  const diagFile = path.join(diagDir, 'login_page.png');
  await page.screenshot({ path: diagFile, fullPage: true });
  console.log(`\n📸 Login page screenshot: ${diagFile}`);

  // Save full HTML for inspection
  const html = await page.content();
  fs.writeFileSync(path.join(diagDir, 'login_page.html'), html);
  console.log(`📄 Login page HTML: ${path.join(diagDir, 'login_page.html')}`);

  await browser.close();
  console.log('\n✅ Diagnose complete. Check the output above and fix selectors in crawler.js if needed.');
}

// ─── Login ───────────────────────────────────────────────────────────────────
async function login(browser) {
  console.log('🔐 Logging in...');
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const loginDir = path.join(CONFIG.outputDir, 'auth');
  fs.mkdirSync(loginDir, { recursive: true });

  await page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle', timeout: 30000 });
  console.log('  Initial URL:', page.url());
  await page.screenshot({ path: path.join(loginDir, '01_login_page.png'), fullPage: true });
  screenshotCount++;

  // Collect all inputs visible on the page
  const allInputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input:not([type=hidden])'))
      .map(i => ({ type: i.type, name: i.name, id: i.id, placeholder: i.placeholder }))
  );
  console.log('  Inputs on page:', JSON.stringify(allInputs));

  // Build selectors from actual page inputs
  const textInputSels = [
    'input[name="username"]', 'input[name="user"]', 'input[name="login"]',
    'input[name="email"]', 'input[type="email"]', 'input[type="text"]',
    'input[id*="user" i]', 'input[id*="login" i]', 'input[id*="email" i]',
    'input[placeholder*="user" i]', 'input[placeholder*="email" i]', 'input[placeholder*="login" i]',
  ];
  const passSels = [
    'input[name="password"]', 'input[type="password"]',
    'input[id*="pass" i]', 'input[placeholder*="pass" i]',
  ];
  const submitSels = [
    'button[type="submit"]', 'input[type="submit"]',
    'button:has-text("Login")', 'button:has-text("Sign in")', 'button:has-text("Log in")',
    'button:has-text("Submit")', '.btn-primary', '.login-btn', '[class*="login" i] button',
  ];

  let userFilled = false;
  let passFilled = false;

  for (const sel of textInputSels) {
    try {
      await page.fill(sel, CONFIG.credentials.username, { timeout: 1500 });
      console.log(`  ✅ Username filled using: ${sel}`);
      userFilled = true;
      break;
    } catch {}
  }

  for (const sel of passSels) {
    try {
      await page.fill(sel, CONFIG.credentials.password, { timeout: 1500 });
      console.log(`  ✅ Password filled using: ${sel}`);
      passFilled = true;
      break;
    } catch {}
  }

  if (!userFilled || !passFilled) {
    console.log('  ⚠️  Could not fill credentials. Run with --diagnose to inspect the login page.');
    await page.screenshot({ path: path.join(loginDir, '02_fill_failed.png'), fullPage: true });
    screenshotCount++;
    await ctx.close();
    return false;
  }

  await page.screenshot({ path: path.join(loginDir, '02_credentials_filled.png'), fullPage: true });
  screenshotCount++;

  // Try submit button first, fall back to Enter
  let submitted = false;
  for (const sel of submitSels) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        submitted = true;
        console.log(`  ✅ Submitted via: ${sel}`);
        break;
      }
    } catch {}
  }
  if (!submitted) {
    await page.keyboard.press('Enter');
    console.log('  ✅ Submitted via Enter key');
  }

  // Wait for navigation / SPA route change
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }),
    page.waitForTimeout(8000),
  ]).catch(() => {});
  await page.waitForTimeout(2000);

  const postUrl = page.url();
  console.log('  Post-login URL:', postUrl);
  await page.screenshot({ path: path.join(loginDir, '03_post_login.png'), fullPage: true });
  screenshotCount++;

  // Detect success: URL changed OR login form is gone OR dashboard element present
  const loginFormGone = await page.$('input[type="password"]').then(el => !el).catch(() => true);
  const urlChanged = postUrl !== CONFIG.loginUrl;
  const hasDashboard = await page.$('[class*="dashboard"], [class*="sidebar"], [id*="sidebar"], nav.main-nav, .main-content').then(Boolean).catch(() => false);

  const success = urlChanged || loginFormGone || hasDashboard;
  console.log(`  Login detection → urlChanged:${urlChanged} loginFormGone:${loginFormGone} hasDashboard:${hasDashboard}`);
  console.log(success ? '  ✅ Login successful' : '  ❌ Login appears to have failed');

  await ctx.storageState({ path: CONFIG.storageStatePath });
  console.log(`  💾 Session saved to ${CONFIG.storageStatePath}`);
  await ctx.close();
  return success;
}

// ─── Crawl ───────────────────────────────────────────────────────────────────
async function crawl() {
  const browser = await chromium.launch({ headless: CONFIG.headless, executablePath: CONFIG.executablePath });

  const loginOk = await login(browser);
  if (!loginOk) {
    console.log('\n❌ Aborting crawl — login failed. Run with --diagnose to inspect the login page.');
    await browser.close();
    process.exit(1);
  }

  const ctx = await browser.newContext({ storageState: CONFIG.storageStatePath, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  // Verify session is still authenticated after context restore
  await page.goto(CONFIG.baseUrl, { waitUntil: 'networkidle', timeout: 20000 });
  const sessionCheck = await page.$('input[type="password"]').then(el => !el).catch(() => true);
  if (!sessionCheck) {
    console.log('⚠️  Session check failed — may not be authenticated, continuing anyway...');
  }

  const startUrl = normalizeUrl(page.url(), CONFIG.baseUrl) || normalizeUrl(CONFIG.baseUrl, CONFIG.baseUrl);
  const queue = [{ url: startUrl, depth: 0, source: 'start' }];
  visited.add(startUrl);

  // Seed with common URL patterns
  const guessed = [
    '/dashboard', '/home', '/index', '/main', '/users', '/user',
    '/settings', '/reports', '/report', '/billing', '/admin',
    '/profile', '/projects', '/project', '/tasks', '/task',
    '/documents', '/notifications', '/search',
  ];
  for (const p of guessed) {
    try {
      const u = normalizeUrl(new URL(p, CONFIG.baseUrl).toString(), CONFIG.baseUrl);
      if (u && !visited.has(u)) queue.push({ url: u, depth: 1, source: 'guessed' });
    } catch {}
  }

  console.log(`\n🚀 Starting crawl from ${startUrl}\n`);

  while (queue.length > 0 && visited.size <= CONFIG.maxPages) {
    const { url, depth, source } = queue.shift();
    const normUrl = normalizeUrl(url, CONFIG.baseUrl);
    if (!normUrl || visited.has(normUrl) || !isSameDomain(normUrl, CONFIG.baseUrl)) continue;
    visited.add(normUrl);

    console.log(`\n[${visited.size}/${CONFIG.maxPages}] depth:${depth} src:${source}`);
    console.log(`  URL: ${normUrl}`);

    let success = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await page.goto(normUrl, { waitUntil: 'networkidle', timeout: 25000 });

        // Skip if redirected back to login
        const redirectedToLogin = await page.$('input[type="password"]').then(Boolean).catch(() => false);
        if (redirectedToLogin) {
          console.log('  ⚠️  Redirected to login — skipping');
          success = true; // don't retry, just skip
          break;
        }

        await injectStabilityCSS(page);
        await scrollPage(page);
        await page.waitForTimeout(500);

        const title = await page.title().catch(() => 'Unknown');
        const baseName = sanitizePath(normUrl);
        const screenshots = await captureUIStates(page, CONFIG.outputDir, baseName);

        pageIndex[normUrl] = { screenshots, discovered_from: [source], depth, title };
        navigationTree.push({ url: normUrl, title, screenshots, source, depth });

        if (depth < CONFIG.maxDepth) {
          const links = await discoverLinks(page);
          const navLinks = await discoverNavLinks(page);
          for (const link of [...links, ...navLinks]) {
            const n = normalizeUrl(link, normUrl);
            if (n && !visited.has(n) && isSameDomain(n, CONFIG.baseUrl)) {
              const src = navLinks.includes(link) ? 'sidebar' : 'crawl';
              queue.push({ url: n, depth: depth + 1, source: src });
            }
          }
        }

        success = true;
        break;
      } catch (err) {
        console.log(`  ⚠️  Attempt ${attempt + 1}: ${err.message.split('\n')[0]}`);
        if (attempt === 0) await page.waitForTimeout(1500);
      }
    }

    if (!success) {
      errorCount++;
      console.log(`  ❌ Skipped after retries`);
    }
  }

  await ctx.close();
  await browser.close();

  generateNavigationMap();
  generateIndexJson();

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ Crawl complete!');
  console.log(`   Pages discovered : ${visited.size}`);
  console.log(`   Screenshots saved: ${screenshotCount}`);
  console.log(`   Errors           : ${errorCount}`);
  console.log(`   Output directory : ${CONFIG.outputDir}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

// ─── Output generators ───────────────────────────────────────────────────────
function generateNavigationMap() {
  const lines = [
    '# PIMS Navigation Map',
    '',
    `> Generated: ${new Date().toISOString()}`,
    `> Total pages: ${navigationTree.length}`,
    '',
  ];

  const byDepth = {};
  for (const item of navigationTree) {
    (byDepth[item.depth] = byDepth[item.depth] || []).push(item);
  }

  for (const depth of Object.keys(byDepth).sort((a, b) => a - b)) {
    lines.push(`## Depth ${depth}`);
    lines.push('');
    for (const item of byDepth[depth]) {
      lines.push(`### ${item.title || item.url}`);
      lines.push(`- **URL**: \`${item.url}\``);
      lines.push(`- **Source**: ${item.source}`);
      lines.push(`- **Screenshots**:`);
      for (const s of item.screenshots) {
        const file = `${sanitizePath(item.url)}${s === 'base' ? '' : '_' + s}.png`;
        lines.push(`  - [\`${file}\`](./${file})`);
      }
      lines.push('');
    }
  }

  const out = path.join(CONFIG.outputDir, 'navigation-map.md');
  fs.writeFileSync(out, lines.join('\n'));
  console.log(`\n📄 Navigation map: ${out}`);
}

function generateIndexJson() {
  const out = path.join(CONFIG.outputDir, 'index.json');
  fs.writeFileSync(out, JSON.stringify(pageIndex, null, 2));
  console.log(`📄 Index JSON     : ${out}`);
}

// ─── Entry point ─────────────────────────────────────────────────────────────
fs.mkdirSync(CONFIG.outputDir, { recursive: true });

if (DIAGNOSE) {
  diagnose().catch(err => { console.error('Fatal:', err); process.exit(1); });
} else {
  crawl().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
