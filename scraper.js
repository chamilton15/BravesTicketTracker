// Braves Ticket Scraper
// Run: node scraper.js
// Schedule (Mac/Linux): 0 */2 * * * cd /path/to/folder && node scraper.js

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TARGET_SECTIONS = ['13', '14', '15'];
const OUTPUT_FILE = path.join(process.cwd(), 'data.json');
const HTML_FILE = path.join(process.cwd(), 'index.html');
const BRAVES_BASE_URL = 'https://www.stubhub.com/atlanta-braves-tickets/category/138303219';
const SECTION_PARAMS = 'quantity=1&sections=1711036%2C1711037%2C1711035&ticketClasses=3824';
const TOTAL_PAGES = 14;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function labelFromUrl(url) {
  try {
    const slug = url.split('/').find(s => s.includes('-tickets-'));
    if (!slug) return url;
    const dateMatch = slug.match(/(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (!dateMatch) return slug;
    const [, month, day, year] = dateMatch;
    const d = new Date(year, month - 1, day);
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return url; }
}

// Hit each paginated page directly via URL
async function getHomeGameUrls(page) {
  console.log('Fetching upcoming Braves home games across ' + TOTAL_PAGES + ' pages...');
  const allUrls = new Set();

  for (let p = 1; p <= TOTAL_PAGES; p++) {
    const pageUrl = BRAVES_BASE_URL + '?primaryPage=' + p;
    try {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(3000);

      const urls = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href*="-atlanta-tickets-"]'))
          .map(a => a.href.split('?')[0])
          .filter(h => h.includes('stubhub.com') && /\/event\/\d+\/?$/.test(h))
      );

      urls.forEach(u => allUrls.add(u));
      console.log('  Page ' + p + ': ' + urls.length + ' games (total so far: ' + allUrls.size + ')');
    } catch (err) {
      console.log('  Page ' + p + ' failed: ' + err.message);
    }
    await sleep(1000);
  }

  const unique = [...allUrls];
  console.log('  Total unique Atlanta home games: ' + unique.length);
  return unique;
}

// Scrape listings for one game
async function scrapeGameListings(page, gameUrl) {
  const label = labelFromUrl(gameUrl);
  console.log('\nScraping: ' + label);

  const filteredUrl = gameUrl + '?' + SECTION_PARAMS;

  try {
    await page.goto(filteredUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);

    let clicks = 0;
    while (clicks < 50) {
      const clicked = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button'))
          .find(b => /show more/i.test(b.innerText));
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!clicked) break;
      clicks++;
      await sleep(1000);
    }

    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 600));
      await sleep(300);
    }
    await sleep(800);

    const listings = await page.evaluate((targetSections) => {
      const results = [];
      const lines = document.body.innerText
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);

      for (let i = 0; i < lines.length; i++) {
        const secMatch = lines[i].match(/^Section\s+(\d+)$/);
        if (!secMatch) continue;
        const section = secMatch[1];
        if (!targetSections.includes(section)) continue;

        // Row: match "Row 9" or "Row 8 | Seats 9 - 12" or "Row A"
        const rowLine = lines[i + 1] || '';
        const rowMatch = rowLine.match(/^Row\s+([A-Z0-9]+)/i);
        const row = rowMatch ? rowMatch[1].toUpperCase() : '?';

        // Collect ALL prices in next 10 lines, take the LAST one.
        // StubHub shows strikethrough (original) price first, sale price last.
        let price = null;
        for (let j = i + 1; j < Math.min(i + 11, lines.length); j++) {
          if (j > i + 1 && lines[j].match(/^Section\s+\d+$/)) break;
          const priceMatch = lines[j].match(/^\$(\d+(?:\.\d{2})?)$/);
          if (priceMatch) { price = parseFloat(priceMatch[1]); }
        }

        if (!price) continue;
        results.push({ section, row, price });
      }
      return results;
    }, TARGET_SECTIONS);

    // Deduplicate
    const seen = new Set();
    const unique = listings.filter(l => {
      const key = l.section + '-' + l.row + '-' + l.price;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log('  ' + unique.length + ' listings found');
    return unique;

  } catch (err) {
    console.error('  Error: ' + err.message);
    return [];
  }
}

async function getGameTime(page) {
  try {
    return await page.evaluate(() => {
      const m = document.body.innerText.match(/\d{1,2}:\d{2}\s*[AP]M/i);
      return m ? m[0] : '';
    });
  } catch { return ''; }
}

// Inject data directly into the HTML file so it works when opened as a local file
function injectDataIntoHtml(data) {
  if (!fs.existsSync(HTML_FILE)) {
    console.log('  HTML file not found, skipping injection');
    return;
  }
  let html = fs.readFileSync(HTML_FILE, 'utf8');
  const tag = '<!-- INJECTED_DATA -->';
  const script = '<script id="injected-data">window.INJECTED_DATA = ' + JSON.stringify(data) + ';</script>';

  if (html.includes(tag)) {
    // Replace existing injected data
    html = html.replace(/<script id="injected-data">[\s\S]*?<\/script>/, script);
  } else {
    // Insert before closing </head>
    html = html.replace('</head>', tag + '\n' + script + '\n</head>');
  }
  fs.writeFileSync(HTML_FILE, html);
  console.log('  Data injected into braves-ticket-tracker.html');
}

async function main() {
  console.log('Braves Ticket Scraper Starting...\n');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  try {
    const gameUrls = await getHomeGameUrls(page);

    if (gameUrls.length === 0) {
      console.error('No home games found.');
      await browser.close();
      return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const upcomingUrls = gameUrls.filter(url => {
      const m = url.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
      if (!m) return true;
      const d = new Date(m[3], m[1] - 1, m[2]);
      return d >= today;
    });

    console.log('\nScraping ' + upcomingUrls.length + ' upcoming home games...\n');

    const output = {
      lastUpdated: new Date().toISOString(),
      sections: TARGET_SECTIONS,
      games: {},
    };

    let gameId = 1;
    for (const url of upcomingUrls) {
      const listings = await scrapeGameListings(page, url);
      const time = await getGameTime(page);
      const baseLabel = labelFromUrl(url);
      const label = time ? baseLabel + ' · ' + time : baseLabel;
      output.games[gameId] = { id: gameId, label, url, listings };
      gameId++;
      await sleep(1500);
    }

    // Save data.json
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

    // Also inject directly into HTML so it works as a local file
    injectDataIntoHtml(output);

    const total = Object.values(output.games).reduce((s, g) => s + g.listings.length, 0);
    console.log('\nDone - ' + Object.keys(output.games).length + ' games, ' + total + ' total listings');
    console.log('Saved to: ' + OUTPUT_FILE);

  } catch (err) {
    console.error('Fatal error:', err);
  } finally {
    await browser.close();
  }
}

main();
