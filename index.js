import express from "express";
import { chromium } from "playwright";

const app = express();
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";

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
  return /Τεύχος\s*Β\b|ΦΕΚ\s*Β\b|Issue\s*:?\s*B\b/i.test(text || "") || /\bΒ[’']?\b/.test(text || "");
}

async function grabFekLinks(page) {
  // περίμενε να σταθεροποιηθεί το network και κάνε auto-scroll (lazy load)
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(()=>{});
  await page.evaluate(() => new Promise(resolve => {
    let h = 0, tries = 0;
    const t = setInterval(()=>{
      window.scrollBy(0, 1200);
      if (document.scrollingElement) {
        const nh = document.scrollingElement.scrollHeight;
        if (nh === h) tries++; else { h = nh; tries = 0; }
      }
      if (tries >= 3) { clearInterval(t); resolve(); }
    }, 400);
  }));

  // χαλαρός selector για αποτελέσματα
  const anchors = await page.$$('a[href*="fekId="]');
  const uniq = new Set();
  const out = [];
  for (const a of anchors) {
    const hrefRel = await a.getAttribute("href");
    if (!hrefRel) continue;
    const href = new URL(hrefRel, page.url()).toString();
    if (uniq.has(href)) continue;
    uniq.add(href);
    const title = (await a.textContent() || "").trim();
    const containerHandle = await a.evaluateHandle(el => el.closest(".search-result") || el.parentElement || el);
    const context = await containerHandle.evaluate(el => (el.innerText || "").replace(/\s+/g," ").trim()).catch(()=> "");
    out.push({ href, title, context });
  }
  return out;
}

async function fetchListForDate(date) {
  const browser = await getBrowser();
  const page = await (await browser).newPage({ userAgent: "Mozilla/5.0", locale: "el-GR" });

  // ---- (A) Daily Publications ----
  const dailyUrl = `https://search.et.gr/el/daily-publications/`;
  await page.goto(dailyUrl, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(()=>{});

  // Συμπλήρωσε ημερομηνία και πάτα "Αναζήτηση"
  try {
    const dateInput = await page.$('input[name="datePublished"], #datePublished').catch(()=>null);
    if (dateInput) {
      await dateInput.fill(date);
    } else {
      await page.evaluate((d) => {
        const el = document.querySelector('input[name="datePublished"], #datePublished');
        if (el) { el.value = d; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); }
      }, date);
    }

    const searchBtn = await page.$('button:has-text("Αναζήτηση"), input[type="submit"], button[type="submit"]').catch(()=>null);
    if (searchBtn) {
      await Promise.all([
        searchBtn.click(),
        page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(()=>{})
      ]);
    } else {
      await page.evaluate(() => { const f = document.querySelector("form"); if (f) f.submit(); });
      await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(()=>{});
    }

    let list = await grabFekLinks(page);
    if (list.length) { await page.close(); return list; }
  } catch (_) { /* fallback */ }

  // ---- (B) Fallback: Simple Search (issue=B & release_from/to) ----
  await page.goto("https://search.et.gr/el/simple-search/", { waitUntil: "domcontentloaded", timeout: 90000 }).catch(()=>{});
  try {
    // issue = B
    await page.selectOption('select[name="issue"]', 'B').catch(async () => {
      await page.evaluate(() => { const s = document.querySelector('select[name="issue"]'); if (s) s.value = 'B'; });
    });
    // release_from / release_to
    const selFrom = await page.$('input[name="release_from"], #release_from').catch(()=>null);
    const selTo   = await page.$('input[name="release_to"], #release_to').catch(()=>null);
    if (selFrom) await selFrom.fill(date); else {
      await page.evaluate((d) => {
        const el = document.querySelector('input[name="release_from"], #release_from'); if (el) { el.value = d; el.dispatchEvent(new Event('change', {bubbles:true})); }
      }, date);
    }
    if (selTo) await selTo.fill(date); else {
      await page.evaluate((d) => {
        const el = document.querySelector('input[name="release_to"], #release_to'); if (el) { el.value = d; el.dispatchEvent(new Event('change', {bubbles:true})); }
      }, date);
    }

    const searchBtn2 = await page.$('button:has-text("Αναζήτηση"), input[type="submit"], button[type="submit"]').catch(()=>null);
    if (searchBtn2) {
      await Promise.all([
        searchBtn2.click(),
        page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(()=>{})
      ]);
    } else {
      await page.evaluate(() => { const f = document.querySelector("form"); if (f) f.submit(); });
      await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(()=>{});
    }

    const list2 = await grabFekLinks(page);
    await page.close();
    return list2;
  } catch (e) {
    await page.close();
    return [];
  }
}

// ---------- health & warmup ----------
app.get("/", (req, res) => res.send("OK"));

app.get("/warmup", async (req, res) => {
  try {
    const browser = await getBrowser();
    const p = await (await browser).newPage();
    await p.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 30000 });
    await p.close();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---------- main endpoint ----------
app.get("/fekB", async (req, res) => {
  const date = (req.query.date || new Date(Date.now()-24*3600*1000).toISOString().slice(0,10)).trim();

  try {
    const list = await fetchListForDate(date);
    if (!list.length) return res.json({ date, count: 0, items: [] });

    const pre = list.filter(x => isIssueB(x.context) || isIssueB(x.title));

    const browser = await getBrowser();
    const results = [];
    for (const it of pre) {
      try {
        const p = await (await browser).newPage({ userAgent: "Mozilla/5.0" });
        await p.goto(it.href, { waitUntil: "domcontentloaded", timeout: 90000 });
        await p.waitForLoadState("networkidle", { timeout: 30000 }).catch(()=>{});

        const pageTitle = await p.title().catch(()=> "");
        let firstP = "";
        try { firstP = await p.$eval("p", el => el.innerText); } catch(_) {}
        const bodyText = (await p.textContent("body").catch(()=> "")) || "";

        const issue = (bodyText.match(/Τεύχος\s*:?\s*([Α-ΩA-Z])/i)||[])[1] || "Β";
        if (issue !== "Β") { await p.close(); continue; }

        const fekNumA = (bodyText.match(/Αρ\.\s*Φύλλου\s*:?\s*(\d{1,5})/i)||[])[1] || "";
        const fekNumB = (bodyText.match(/ΦΕΚ[^0-9]{0,10}(\d{1,5})\s*\/\s*(\d{4})/i)||[]);
        const fekNumber = fekNumA ? fekNumA : (fekNumB.length ? (fekNumB[1] + "/" + fekNumB[2]) : "");

        const body = ((bodyText.match(/(Υπουργείο|Φορέας)\s*:?\s*([^\n\r]{3,120})/i)||[])[2]||"").trim();
        const shortTitle = (pageTitle || it.title || "").replace(/\s*\|\s*Εθνικό Τυπογραφείο.*$/,"").trim();
        const summary = (firstP || it.context || "").replace(/\s+/g," ").slice(0,300);

        results.push({ href: it.href, fekNumber, issue, body, shortTitle, summary });
        await p.close();
      } catch(_) {}
    }

    res.json({ date, count: results.length, items: results });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, ()=> console.log("Listening on "+port));
