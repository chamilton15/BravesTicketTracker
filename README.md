# Braves Ticket Tracker

A web dashboard that scrapes StubHub for ticket listings in Sections 13, 14, and 15 at Truist Park, built for a season ticket holder who wants to know what comparable seats are listing for.

## What It Does

- Scrapes all 81 Braves home games from StubHub nightly at midnight
- Filters to listings with **2 tickets together** in Sections 13, 14, and 15
- Displays listings sorted highest to lowest price with section/row breakdown
- Shows lowest, average, and highest price stats per game
- Auto-deploys to Vercel on every update

## Live Dashboard

[braves-ticket-tracker.vercel.app](https://braves-ticket-tracker.vercel.app)

## Project Structure

```
BravesTicketTracker/
├── scraper.js          # Playwright scraper — fetches listings from StubHub
├── index.html          # Dashboard — reads from data.json or injected data
├── data.json           # Output of scraper (auto-generated)
├── package.json        # Node dependencies
└── .github/
    └── workflows/
        └── scrape.yml  # GitHub Action — runs scraper nightly at midnight ET
```

## Running Locally

**First time setup:**
```bash
npm install
npx playwright install chromium
```

**Run the scraper:**
```bash
node scraper.js
```

This scrapes all upcoming games, saves `data.json`, and injects data directly into `index.html`. Open `index.html` in your browser when done, or serve it locally:

```bash
npx serve .
# Open http://localhost:3000
```

## How the Scraper Works

1. Loads the [Braves Atlanta city page](https://www.stubhub.com/atlanta-braves-tickets/category/138303219/atlanta-city/392) and clicks through numbered pagination to collect all 81 home game URLs
2. For each upcoming game, loads the StubHub listing page filtered to Sections 13/14/15 with quantity=2
3. Parses the `listings-container` DOM element to extract section, row, and price
4. Handles StubHub's sale price format (`$324 → Now → $254`) by skipping the strikethrough price
5. Saves results to `data.json` and injects them into `index.html`
