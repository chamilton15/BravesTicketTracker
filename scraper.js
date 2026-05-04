// Braves Ticket Scraper
// Run: node scraper.js
// Schedule (Mac/Linux): 0 */2 * * * cd /path/to/folder && node scraper.js

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TARGET_SECTIONS = ['13', '14', '15'];
const OUTPUT_FILE = path.join(process.cwd(), 'data.json');
const HTML_FILE = path.join(process.cwd(), 'index.html');
const BRAVES_BASE_URL = 'https://www.stubhub.com/atlanta-braves-tickets/category/138303219/atlanta-city/392';
const SECTION_PARAMS = 'quantity=2&sections=1711036%2C1711037%2C1711035&ticketClasses=3824';
const PARKING_BASE_URL = 'https://www.stubhub.com/atlanta-braves-tickets/category/138303219/atlanta-city/392?gridFilterType=1';
const PARKING_PARAMS = 'sections=1550151&ticketClasses=6882';

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

// Collect all parking game URLs from the parking index page
async function getParkingUrls(page) {
  console.log('Fetching parking game URLs...');
  const parkingUrls = new Map(); // date string -> url

  await page.goto(PARKING_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);

  // Click through pages same as game URLs
  const totalPages = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const pageNums = btns.map(b => parseInt(b.innerText.trim())).filter(n => !isNaN(n) && n > 0);
    return pageNums.length > 0 ? Math.max(...pageNums) : 1;
  });

  for (let p = 1; p <= totalPages; p++) {
    const urls = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href*="parking-passes-only-atlanta-braves-atlanta-tickets"]'))
        .map(a => a.href.split('?')[0])
        .filter(h => /\/event\/\d+\/?$/.test(h))
    );
    urls.forEach(u => {
      const m = u.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
      if (m) parkingUrls.set(m[0], u);
    });

    if (p < totalPages) {
      const next = p + 1;
      const clicked = await page.evaluate((nextPage) => {
        const btn = Array.from(document.querySelectorAll('button'))
          .find(b => b.innerText.trim() === String(nextPage));
        if (btn) { btn.click(); return true; }
        return false;
      }, next);
      if (!clicked) break;
      await sleep(3000);
    }
  }

  console.log('  Found parking URLs for ' + parkingUrls.size + ' games');
  return parkingUrls;
}

// Scrape lowest Section 29 parking price for a game
async function scrapeParking(page, parkingUrl) {
  if (!parkingUrl) return null;
  try {
    await page.goto(parkingUrl + '?' + PARKING_PARAMS, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);

    const price = await page.evaluate(() => {
      const container = document.querySelector('[data-testid="listings-container"]');
      if (!container) return null;
      const lines = container.innerText.split('\n').map(l => l.trim()).filter(Boolean);
      // Find all prices, take the lowest
      const prices = lines
        .filter(l => /^\$\d+$/.test(l))
        .map(l => parseFloat(l.replace('$', '')));
      return prices.length > 0 ? Math.min(...prices) : null;
    });

    return price;
  } catch { return null; }
}

// Load all Atlanta home games by clicking through numbered pagination
async function getHomeGameUrls(page) {
  console.log('Fetching all Braves Atlanta home games...');
  const allUrls = new Set();

  await page.goto(BRAVES_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);

  let pageNum = 1;
  while (true) {
    const urls = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href*="atlanta-braves-atlanta-tickets"]'))
        .map(a => a.href.split('?')[0])
        .filter(h => /\/event\/\d+\/?$/.test(h))
    );
    urls.forEach(u => allUrls.add(u));
    console.log('  Page ' + pageNum + ': ' + urls.length + ' games (total so far: ' + allUrls.size + ')');

    // Try clicking next page button
    const next = pageNum + 1;
    const clicked = await page.evaluate((nextPage) => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(b => b.innerText.trim() === String(nextPage));
      if (btn) { btn.click(); return true; }
      return false;
    }, next);
    if (!clicked) break;
    pageNum++;
    await sleep(3000);
  }

  console.log('  Total unique Braves home games: ' + allUrls.size);
  return [...allUrls];
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
      const container = document.querySelector('[data-testid="listings-container"]');
      if (!container) return results;
      const lines = container.innerText
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

        // Parse price - handle "Now" sale pattern: $324 / Now / $254
        // Skip the strikethrough price if followed by "Now", take the next price
        let price = null;
        for (let j = i + 1; j < Math.min(i + 11, lines.length); j++) {
          if (j > i + 1 && lines[j].match(/^Section\s+\d+$/)) break;
          const priceMatch = lines[j].match(/^\$(\d+(?:\.\d{2})?)$/);
          if (priceMatch) {
            const nextLine = lines[j + 1] || '';
            if (nextLine === 'Now') {
              // This is the strikethrough price, skip it and take the one after Now
              continue;
            }
            price = parseFloat(priceMatch[1]);
            break;
          }
        }

        if (!price) continue;
        if (row === '?') continue;
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

async function getGameInfo(page) {
  try {
    return await page.evaluate(() => {
      const timeMatch = document.body.innerText.match(/\d{1,2}:\d{2}\s*[AP]M/i);
      const time = timeMatch ? timeMatch[0] : '';

      const header = document.querySelector('[data-testid="event-detail-header"]');
      let opponent = '';
      if (header) {
        const lines = header.innerText.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length >= 3 && lines[1] === '@') {
          opponent = lines[0];
        }
      }

      return { time, opponent };
    });
  } catch { return { time: '', opponent: '' }; }
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

    // Collect parking URLs keyed by date string
    const parkingUrls = await getParkingUrls(page);

    let gameId = 1;
    for (const url of upcomingUrls) {
      const listings = await scrapeGameListings(page, url);
      const { time, opponent } = await getGameInfo(page);
      const baseLabel = labelFromUrl(url);
      const dateTime = time ? baseLabel + ' · ' + time : baseLabel;
      const label = opponent ? dateTime + ' · vs ' + opponent : dateTime;

      // Match parking URL by date
      const dateMatch = url.match(/(\d{1,2}-\d{1,2}-\d{4})/);
      const parkingUrl = dateMatch ? parkingUrls.get(dateMatch[1]) : null;
      const parkingPrice = await scrapeParking(page, parkingUrl);

      output.games[gameId] = { id: gameId, label, url, listings, parkingPrice };
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
