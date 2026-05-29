const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG = {
  baseUrl: 'https://pims.housingandurban.go.ke/home',
  loginUrl: 'https://pims.housingandurban.go.ke/home',
  credentials: { username: 'systemdev', password: 'Systemdev54!' },
  outputDir: path.join(os.homedir(), 'Desktop', 'app-screenshots'),
  storageStatePath: path.join(process.cwd(), 'storageState.json'),
  maxPages: 300,
  maxDepth: 5,
  headless: true,
  // Use pre-installed Chromium if playwright's own binary is unavailable
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
};

const visited = new Set();
const pageIndex = {};
const navigationTree = [];
let screenshotCount = 0;
let errorCount = 0;

function sanitizePath(url) {
  try {
    const u = new URL(url);
    let p = u.pathname + (u.hash ? u.hash.replace('#', '/hash/') : '');
    p = p.replace(/^\//, '').replace(/\//g, '_').replace(/[^a-zA-Z0-9_\-]/g, '_') || 'index';
    return p;
  } catch {
    return 'unknown_' + Date.now();
  }
}

function normalizeUrl(url, base) {
  try {
    const u = new URL(url, base);
    u.hash = '';
    // Remove common tracking params
    ['utm_source','utm_medium','utm_campaign','_','timestamp'].forEach(p => u.searchParams.delete(p));
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
    }`
  });
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
      }, 50);
      setTimeout(() => { clearInterval(timer); window.scrollTo(0, 0); resolve(); }, 5000);
    });
  });
}

async function takeScreenshot(page, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await page.screenshot({ path: filePath, fullPage: true });
  screenshotCount++;
  console.log(`  📸 Screenshot saved: ${filePath}`);
}

async function captureUIStates(page, baseDir, baseName, url) {
  const screenshots = ['base'];
  const baseFile = path.join(baseDir, baseName + '.png');
  await takeScreenshot(page, baseFile);

  // Try to capture modals
  const modalTriggers = await page.$$('[data-toggle="modal"], [data-bs-toggle="modal"], .btn[href*="#"], button.modal-trigger');
  for (let i = 0; i < Math.min(modalTriggers.length, 3); i++) {
    try {
      await modalTriggers[i].click();
      await page.waitForTimeout(500);
      const modal = await page.$('.modal.show, .modal[style*="display: block"], [role="dialog"]:visible');
      if (modal) {
        const modalFile = path.join(baseDir, `${baseName}_modal_${i}.png`);
        await takeScreenshot(page, modalFile);
        screenshots.push(`modal_${i}`);
        // Close modal
        const closeBtn = await page.$('.modal.show .close, .modal.show [data-dismiss="modal"], .modal.show [data-bs-dismiss="modal"]');
        if (closeBtn) await closeBtn.click();
        else await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    } catch {}
  }

  // Try to capture dropdowns
  const dropdowns = await page.$$('[data-toggle="dropdown"], [data-bs-toggle="dropdown"], .dropdown-toggle');
  for (let i = 0; i < Math.min(dropdowns.length, 3); i++) {
    try {
      await dropdowns[i].click();
      await page.waitForTimeout(400);
      const menu = await page.$('.dropdown-menu.show, .dropdown-menu[style*="display: block"]');
      if (menu) {
        const ddFile = path.join(baseDir, `${baseName}_dropdown_${i}.png`);
        await takeScreenshot(page, ddFile);
        screenshots.push(`dropdown_${i}`);
        await dropdowns[i].click();
        await page.waitForTimeout(200);
      }
    } catch {}
  }

  // Try expandable sections
  const expandables = await page.$$('[data-toggle="collapse"], [data-bs-toggle="collapse"], .accordion-button:not(.active), details summary');
  for (let i = 0; i < Math.min(expandables.length, 3); i++) {
    try {
      await expandables[i].click();
      await page.waitForTimeout(400);
      const expFile = path.join(baseDir, `${baseName}_expanded_${i}.png`);
      await takeScreenshot(page, expFile);
      screenshots.push(`expanded_${i}`);
      await expandables[i].click();
      await page.waitForTimeout(200);
    } catch {}
  }

  return screenshots;
}

async function discoverLinks(page, currentUrl) {
  const links = await page.evaluate((base) => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    return anchors.map(a => a.href).filter(h => h && !h.startsWith('javascript:') && !h.startsWith('mailto:') && !h.startsWith('tel:'));
  }, currentUrl);
  return links;
}

async function login(browser) {
  console.log('🔐 Logging in...');
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle', timeout: 30000 });

  // Save login page screenshot
  const loginDir = path.join(CONFIG.outputDir, 'auth');
  fs.mkdirSync(loginDir, { recursive: true });
  await page.screenshot({ path: path.join(loginDir, 'login.png'), fullPage: true });
  screenshotCount++;

  // Try various login field selectors
  const usernameSelectors = ['input[name="username"]', 'input[name="email"]', 'input[type="email"]', 'input[id*="user"]', 'input[id*="login"]', '#username', '#email'];
  const passwordSelectors = ['input[name="password"]', 'input[type="password"]', '#password'];

  let loggedIn = false;
  for (const uSel of usernameSelectors) {
    try {
      await page.fill(uSel, CONFIG.credentials.username, { timeout: 2000 });
      for (const pSel of passwordSelectors) {
        try {
          await page.fill(pSel, CONFIG.credentials.password, { timeout: 2000 });
          await page.screenshot({ path: path.join(loginDir, 'login_filled.png'), fullPage: true });
          screenshotCount++;
          await page.keyboard.press('Enter');
          await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(2000);

          const currentUrl = page.url();
          if (!currentUrl.includes('login') && !currentUrl.includes('signin')) {
            loggedIn = true;
            break;
          }
          // Try submit button
          const submitBtn = await page.$('button[type="submit"], input[type="submit"], .btn-login, .btn-primary');
          if (submitBtn) {
            await submitBtn.click();
            await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(2000);
            if (!page.url().includes('login')) { loggedIn = true; break; }
          }
        } catch {}
      }
      if (loggedIn) break;
    } catch {}
  }

  if (!loggedIn) {
    console.log('⚠️  Standard login failed, attempting form submission...');
    // Take screenshot to debug
    await page.screenshot({ path: path.join(loginDir, 'login_debug.png'), fullPage: true });
  }

  console.log(`✅ Post-login URL: ${page.url()}`);
  await page.screenshot({ path: path.join(loginDir, 'post_login.png'), fullPage: true });
  screenshotCount++;

  await context.storageState({ path: CONFIG.storageStatePath });
  console.log(`💾 Session saved to ${CONFIG.storageStatePath}`);
  await context.close();
}

async function crawl() {
  const browser = await chromium.launch({ headless: CONFIG.headless, executablePath: CONFIG.executablePath });

  // Login first
  await login(browser);

  // Create context with saved session
  const context = await browser.newContext({ storageState: CONFIG.storageStatePath });
  const page = await context.newPage();

  const queue = [{ url: CONFIG.baseUrl, depth: 0, source: 'start' }];
  visited.add(normalizeUrl(CONFIG.baseUrl, CONFIG.baseUrl));

  console.log('\n🚀 Starting crawl...\n');

  const guessedUrls = [
    '/users', '/settings', '/dashboard', '/reports', '/billing',
    '/admin', '/profile', '/home', '/index', '/main'
  ].map(p => {
    try { return new URL(p, CONFIG.baseUrl).toString(); } catch { return null; }
  }).filter(Boolean);

  for (const u of guessedUrls) {
    const norm = normalizeUrl(u, CONFIG.baseUrl);
    if (norm && !visited.has(norm)) {
      queue.push({ url: norm, depth: 1, source: 'guessed' });
    }
  }

  while (queue.length > 0 && visited.size <= CONFIG.maxPages) {
    const { url, depth, source } = queue.shift();
    const normUrl = normalizeUrl(url, CONFIG.baseUrl);

    if (!normUrl || visited.has(normUrl) || !isSameDomain(normUrl, CONFIG.baseUrl)) continue;
    visited.add(normUrl);

    console.log(`\n[${visited.size}/${CONFIG.maxPages}] Visiting (depth ${depth}): ${normUrl}`);
    console.log(`  Source: ${source}`);

    let success = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await page.goto(normUrl, { waitUntil: 'networkidle', timeout: 20000 });
        await injectStabilityCSS(page);
        await scrollPage(page);
        await page.waitForTimeout(500);

        const sanitized = sanitizePath(normUrl);
        const pageDir = CONFIG.outputDir;
        const baseName = sanitized;

        const screenshots = await captureUIStates(page, pageDir, baseName, normUrl);

        pageIndex[normUrl] = {
          screenshots,
          discovered_from: [source],
          depth,
          title: await page.title().catch(() => 'Unknown'),
        };

        navigationTree.push({ url: normUrl, screenshots, source, depth });

        // Discover new links
        if (depth < CONFIG.maxDepth) {
          const links = await discoverLinks(page, normUrl);
          for (const link of links) {
            const norm = normalizeUrl(link, normUrl);
            if (norm && !visited.has(norm) && isSameDomain(norm, CONFIG.baseUrl)) {
              queue.push({ url: norm, depth: depth + 1, source: 'crawl' });
            }
          }

          // Also check sidebar/nav specific elements
          const navLinks = await page.evaluate(() => {
            const els = document.querySelectorAll('.sidebar a, .nav a, .navbar a, .menu a, [class*="sidebar"] a, [class*="nav"] a');
            return Array.from(els).map(a => a.href).filter(h => h && !h.startsWith('javascript:'));
          });
          for (const link of navLinks) {
            const norm = normalizeUrl(link, normUrl);
            if (norm && !visited.has(norm) && isSameDomain(norm, CONFIG.baseUrl)) {
              queue.push({ url: norm, depth: depth + 1, source: 'sidebar' });
            }
          }
        }

        success = true;
        break;
      } catch (err) {
        console.log(`  ⚠️  Attempt ${attempt + 1} failed: ${err.message}`);
        if (attempt === 0) await page.waitForTimeout(1000);
      }
    }

    if (!success) {
      errorCount++;
      console.log(`  ❌ Skipping ${normUrl} after 2 failures`);
    }
  }

  await context.close();
  await browser.close();

  // Generate output files
  generateNavigationMap();
  generateIndexJson();

  console.log('\n✅ Crawl complete!');
  console.log(`  Total pages discovered: ${visited.size}`);
  console.log(`  Total screenshots captured: ${screenshotCount}`);
  console.log(`  Errors encountered: ${errorCount}`);
}

function generateNavigationMap() {
  const lines = ['# Navigation Map\n', `Generated: ${new Date().toISOString()}\n`];

  // Group by depth
  const byDepth = {};
  for (const item of navigationTree) {
    if (!byDepth[item.depth]) byDepth[item.depth] = [];
    byDepth[item.depth].push(item);
  }

  for (const depth of Object.keys(byDepth).sort()) {
    lines.push(`\n## Depth ${depth}\n`);
    for (const item of byDepth[depth]) {
      lines.push(`### ${item.url}`);
      lines.push(`- **Source**: ${item.source}`);
      lines.push(`- **Screenshots**:`);
      for (const s of item.screenshots) {
        lines.push(`  - ${s}`);
      }
      lines.push('');
    }
  }

  const mapPath = path.join(CONFIG.outputDir, 'navigation-map.md');
  fs.writeFileSync(mapPath, lines.join('\n'));
  console.log(`\n📄 Navigation map saved: ${mapPath}`);
}

function generateIndexJson() {
  const indexPath = path.join(CONFIG.outputDir, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(pageIndex, null, 2));
  console.log(`📄 Index JSON saved: ${indexPath}`);
}

// Create output directory
fs.mkdirSync(CONFIG.outputDir, { recursive: true });

// Run
crawl().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
