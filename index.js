import express from "express";
import { chromium } from "playwright";

const app = express();
const AUTH_TOKEN = process.env.AUTH_TOKEN || ""; // βάλε στο Render

// απλή auth
app.use((req, res, next) => {
  const ok = AUTH_TOKEN ? (req.query.token === AUTH_TOKEN) : true;
  if (!ok) return res.status(401).json({error:"unauthorized"});
  next();
});

// health
app.get("/", (req, res) => res.send("OK"));

// βασικό endpoint: /fekB?date=YYYY-MM-DD
app.get("/fekB", async (req, res) => {
  const date = (req.query.date || new Date(Date.now()-24*3600*1000).toISOString().slice(0,10)).trim(); // χθεσινή by default
  const url = `https://search.et.gr/el/daily-publications/?datePublished=${date}`;

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox","--disable-dev-shm-usage"]
  });
  const page = await browser.newPage({ userAgent: "Mozilla/5.0" });

  // 1) Daily Publications
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  // περίμενε να εμφανιστούν links προς /fek/?fekId=
  await page.waitForSelector('a[href*="/fek/?fekId="]', { timeout: 90000 }).catch(()=>{});

  // Πάρε όλα τα αποτελέσματα της λίστας
  const list = await page.$$eval('a[href*="/fek/?fekId="]', nodes => {
    const uniq = new Set();
    const out = [];
    for (const a of nodes) {
      const href = a.href;
      if (uniq.has(href)) continue; uniq.add(href);
      const title = (a.textContent||"").trim();
      const container = a.closest(".search-result") || a.parentElement || a;
      const context = (container.innerText||"").replace(/\s+/g," ").trim();
      out.push({ href, title, context });
    }
    return out;
  });

  // Κράτα ΜΟΝΟ Τεύχος Β
  const onlyB = list.filter(x =>
    /Τεύχος\s*Β\b|ΦΕΚ\s*Β\b|Issue\s*:?\s*B\b/.test(x.context) ||
    /\bΒ[’']?\b/.test(x.title)
  );

  // 2) Εμπλουτισμός από την σελίδα του ΦΕΚ
  const results = [];
  for (const it of onlyB) {
    try {
      const p = await browser.newPage({ userAgent: "Mozilla/5.0" });
      await p.goto(it.href, { waitUntil: "domcontentloaded", timeout: 90000 });

      // τίτλος σελίδας
      const pageTitle = await p.title().catch(()=> "");
      // πρώτη παράγραφος (ως περίληψη)
      let firstP = "";
      try { firstP = await p.$eval("p", el=>el.innerText); } catch(e){ firstP=""; }

      // κείμενο για regex
      const bodyText = (await p.textContent("body").catch(()=> "")) || "";

      const issue = (bodyText.match(/Τεύχος\s*:?\s*([Α-ΩA-Z])/i)||[])[1] || "Β";
      const fekNumA = (bodyText.match(/Αρ\.\s*Φύλλου\s*:?\s*(\d{1,5})/i)||[])[1] || "";
      const fekNumB = (bodyText.match(/ΦΕΚ[^0-9]{0,10}(\d{1,5})\s*\/\s*(\d{4})/i)||[]);
      const fekNumber = fekNumA ? fekNumA : (fekNumB.length ? (fekNumB[1] + "/" + fekNumB[2]) : "");

      const body = ((bodyText.match(/(Υπουργείο|Φορέας)\s*:?\s*([^\n\r]{3,120})/i)||[])[2]||"").trim();

      const shortTitle = (pageTitle||it.title||"").replace(/\s*\|\s*Εθνικό Τυπογραφείο.*$/,"").trim();
      const summary = (firstP||it.context||"").replace(/\s+/g," ").slice(0,300);

      results.push({
        href: it.href,
        fekNumber,
        issue,
        body,
        shortTitle,
        summary
      });

      await p.close();
    } catch(e) {
      // skip individual failures
    }
  }

  await browser.close();
  res.json({ date, count: results.length, items: results });
});

const port = process.env.PORT || 8080;
app.listen(port, ()=> console.log("Listening on "+port));
