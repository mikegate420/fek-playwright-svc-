import express from "express";
import { chromium } from "playwright";

const app = express();
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";

// -------- settings (προσαρμόζονται μέσω ENV αν θέλεις) --------
const MAX_LIST = Number(process.env.MAX_LIST || 120);       // αν σελίδα έχει πάρα πολλά, βάλ’ το 80–150
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 25);    // πόσα ΦΕΚ επεξεργάζεται πριν “ανασάνει”
const NAV_TIMEOUT = 90000;

// ---------- auth ----------
app.use((req, res, next) => {
  const ok = AUTH_TOKEN ? (req.query.token === AUTH_TOKEN) : true;
  if (!ok) return res.status(401).json({ error: "unauthorized" });
  next();
});

// ---------- re-usable browser ----------
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });
  }
  return browserPromise;
}

// ---------- helpers ----------
function isIssueB(text) {
  text = text || "";
  return /Τεύχος\s*Β\b|ΦΕΚ\s*Β\b|Issue\s*:?\s*B\b/i.test(text) || /\bΒ[’']?\b/.test(text);
}

async function blockHeavyResources(page){
  await page.route("**/*", (route) => {
    const req = route.request();
    const type = req.resourceType();
    if (type === "image" || type === "media" || type === "font" || type === "stylesheet") {
      return route.abort();
    }
    return route.continue();
  });
}

async function autoScroll(page){
  await page.evaluate(() => new Promise(resolve => {
    let prev = 0, same = 0;
    const t = setInterval(()=>{
      window.scrollBy(0, 1200);
      const cur = document.scrollingElement ? document.scrollingElement.scrollHeight : 0;
      if (cur === prev) same++; else { prev = cur; same = 0; }
      if (same >= 3) { clearInterval(t); resolve(); }
    }, 350);
  }));
}

async function clickLoadMoreIfAny(page){
  // διαφόρων ειδών “Περισσότερα/Load more/Εμφάνιση περισσότερων”
  const selectors = [
    'button:has-text("Περισσότερα")',
    'button:has-text("Εμφάνιση περισσότερων")',
    'a:has-text("Περισσότερα")',
    'a:has-text("Εμφάνιση περισσότερων")'
  ];
  for (let i=0; i<10; i++){
    let clicked = false;
    for (const sel of selectors){
      const b = await page.$(sel).catch(()=>null);
      if (b){
        await Promise.all([
          b.click().catch(()=>{}),
          page.waitForLoadState("networkidle", { timeout: 30000 }).catch(()=>{})
        ]);
        await autoScroll(page);
        clicked = true;
        break;
      }
    }
    if (!clicked) break;
  }
}

async function grabFekLinks(page) {
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(()=>{});
  await autoScroll(page);
  await clickLoadMoreIfAny(page);
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(()=>{});

  const anchors = await page.$$(`a[href*="fekId="]`);
  const uniq = new Set();
  const out = [];
  for (const a of anchors) {
    const hrefRel = await a.getAttribute("href").catch(()=>null);
    if (!hrefRel) continue;
    const href = new URL(hrefRel, page.url()).toString();
    if (uniq.has(href)) continue;
    uniq.add(href);
    const title = (await a.textContent().catch(()=>null) || "").trim();
    // προσπάθησε να πάρεις context
    let context = "";
    try {
      const containerHandle = await a.evaluateHandle(el => el.closest(".search-result") || el.parentElement || el);
      context = await containerHandle.evaluate(el => (el.innerText || "").replace(/\s+/g," ").trim()).catch(()=> "");
      await containerHandle.dispose().catch(()=>{});
    } catch {}
    out.push({ href, title, context });
  }
  return out;
}

async function fillAndSearch_Daily(page, date){
  // Daily Publications
  const dailyUrl = `https://search.et.gr/el/daily-publications/`;
  await page.goto(dailyUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(()=>{});

  const dateInput = await page.$('input[name="datePublished"], #datePublished').catch(()=>null);
  if (dateInput) {
    await dateInput.fill(date).catch(()=>{});
  } else {
    await page.evaluate((d) => {
      const el = document.querySelector('input[name="datePublished"], #datePublished');
      if (el) { el.value = d; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); }
    }, date).catch(()=>{});
  }

  const searchBtn = await page.$('button:has-text("Αναζήτηση"), input[type="submit"], button[type="submit"]').catch(()=>null);
  if (searchBtn) {
    await Promise.all([
      searchBtn.click().catch(()=>{}),
      page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(()=>{})
    ]);
  } else {
    await page.evaluate(() => { const f = document.querySelector("form"); if (f) f.submit(); }).catch(()=>{});
    await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(()=>{});
  }
}

async function fillAndSearch_Simple(page, date){
  // Simple Search: issue=B & release date = date..date
  const simpleUrl = `https://search.et.gr/el/simple-search/`;
  await page.goto(simpleUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(()=>{});

  await page.selectOption('select[name="issue"]', 'B').catch(async () => {
    await page.evaluate(() => {
      const s = document.querySelector('select[name="issue"]'); if (s) s.value = 'B';
    }).catch(()=>{});
  });

  const selFrom = await page.$('input[name="release_from"], #release_from').catch(()=>null);
  const selTo   = await page.$('input[name="release_to"], #release_to').catch(()=>null);
  if (selFrom) await selFrom.fill(date).catch(()=>{}); else {
    await page.evaluate((d) => {
      const el = document.querySelector('input[name="release_from"], #release_from'); if (el) { el.value = d; el.dispatchEvent(new Event('change', {bubbles:true})); }
    }, date).catch(()=>{});
  }
  if (selTo) await selTo.fill(date).catch(()=>{}); else {
    await page.evaluate((d) => {
      const el = document.querySelector('input[name="release_to"], #release_to'); if (el) { el.value = d; el.dispatchEvent(new Event('change', {bubbles:true})); }
    }, date).catch(()=>{});
  }

  const searchBtn2 = await page.$('button:has-text("Αναζήτηση"), input[type="submit"], button[type="submit"]').catch(()=>null);
  if (searchBtn2) {
    await Promise.all([
      searchBtn2.click().catch(()=>{}),
      page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(()=>{})
    ]);
  } else {
    await page.evaluate(() => { const f = document.querySelector("form"); if (f) f.submit(); }).catch(()=>{});
    await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(()=>{});
  }
}

async function fetchListForDate(date) {
  const browser = await getBrowser();
  const context = await (await browser).newContext({ locale: "el-GR", userAgent: "Mozilla/5.0" });
  const page = await context.newPage();
  await blockHeavyResources(page);

  // (A) Daily Publications
  await fillAndSearch_Daily(page, date);
  let list = await grabFekLinks(page);

  // (B) Fallback: Simple Search
  if (list.length === 0) {
    await fillAndSearch_Simple(page, date);
    list = await grabFekLinks(page);
  }

  await page.close();
  await context.close();
  return list;
}

async function enrichItems(items){
  const browser = await getBrowser();
  const context = await (await browser).newContext({ locale: "el-GR", userAgent: "Mozilla/5.0" });
  const page = await context.newPage();
  await blockHeavyResources(page);

  const results = [];
  for (let i=0; i<items.length; i++){
    const it = items[i];
    try {
      await page.goto(it.href, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(()=>{});

      const pageTitle = await page.title().catch(()=> "");
      let firstP = "";
      try { firstP = await page.$eval("p", el => el.innerText); } catch(_) {}
      const bodyText = (await page.textContent("body").catch(()=> "")) || "";

      const issue = (bodyText.match(/Τεύχος\s*:?\s*([Α-ΩA-Z])/i)||[])[1] || "Β";
      if (issue !== "Β") continue;

      const fekNumA = (bodyText.match(/Αρ\.\s*Φύλλου\s*:?\s*(\d{1,5})/i)||[])[1] || "";
      const fekNumB = (bodyText.match(/ΦΕΚ[^0-9]{0,10}(\d{1,5})\s*\/\s*(\d{4})/i)||[]);
      const fekNumber = fekNumA ? fekNumA : (fekNumB.length ? (fekNumB[1] + "/" + fekNumB[2]) : "");

      const body = ((bodyText.match(/(Υπουργείο|Φορέας)\s*:?\s*([^\n\r]{3,120})/i)||[])[2]||"").trim();
      const shortTitle = (pageTitle || it.title || "").replace(/\s*\|\s*Εθνικό Τυπογραφείο.*$/,"").trim();
      const summary = (firstP || it.context || "").replace(/\s+/g," ").slice(0,300);

      results.push({ href: it.href, fekNumber, issue, body, shortTitle, summary });
    } catch(_) {}
    // “αναπνοή” κάθε BATCH_SIZE για να πέσουν οι αιχμές μνήμης
    if ((i+1) % BATCH_SIZE === 0) await new Promise(r=>setTimeout(r, 300));
  }

  await page.close();
  await context.close();
  return results;
}

// ---------- health & warmup ----------
app.get("/", (req, res) => res.send("OK"));
app.get("/warmup", async (req, res) => {
  try {
    const browser = await getBrowser();
    const ctx = await (await browser).newContext();
    const p = await ctx.newPage();
    await p.goto("https://example.com", { waitUntil: "domcontentloade
