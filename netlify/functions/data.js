// netlify/functions/data.js
// Secure API proxy — keeps keys server-side, never exposed to browser

import crypto from 'node:crypto';

export async function handler(event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
    // Never cache — always fetch fresh data
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const { channel, from, to } = event.queryStringParameters || {};

  try {
    // Amazon channel only needs TW data — skip Shopify to avoid timeout
    // (Shopify paginates 250/page; with 2000+ orders that's 8-10 sequential calls)
    if (channel === "amazon") {
      const twData = await fetchTripleWhale("amazon", from, to);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ triplewhale: twData, fetchedAt: new Date().toISOString() })
      };
    }

    // DTC channel: fetch Shopify + TW blended + Target in parallel
    const [shopifyData, twData, targetData] = await Promise.all([
      fetchShopify(from, to),
      fetchTripleWhale(null, from, to),
      fetchTargetFromDrive()
    ]);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        shopify: shopifyData,
        triplewhale: twData,
        target: targetData,
        fetchedAt: new Date().toISOString()
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
}

// ── Google Drive: auto-read Target PO CSVs from the invoices folder ─────────
const TARGET_FOLDER_ID = "1lZ7bHdYDNqB3JRz05LBr5RjCpGplFthH";

// Unit prices by UPC — used for older CSVs that lack a Total column
const UPC_PRICES = {
  "850070864084": 8.69,   // babywashshampoo
  "850070864121": 8.11,   // detangler
  "850070864152": 7.53,   // bubble bath
  "850070864060": 8.69,   // babylotion
  "850070864138": 8.47,   // NippleLip
  "850070864176": 16.95,  // Mamaduomini
  "850070864022": 20.14,  // Stretch
  "850070864145": 18.02,  // Scar
  "850070864008": 23.32,  // BellyOil
};

async function fetchTargetFromDrive() {
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson) return null;  // env var not set — skip gracefully

  try {
    const token = await getGoogleAccessToken(saJson);

    // List all CSV files in the folder (up to 100)
    const listUrl = `https://www.googleapis.com/drive/v3/files?q='${TARGET_FOLDER_ID}'+in+parents+and+mimeType='text/csv'&fields=files(id,name,createdTime)&pageSize=100&orderBy=createdTime`;
    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!listRes.ok) return null;
    const { files } = await listRes.json();
    if (!files || !files.length) return null;

    // Group by week-date-key (M/D from filename) and aggregate by month
    const weekMap = {};   // "M/D" → { actual, monthKey, dateISO }
    const monthMap = {};  // "YYYY-MM" → total

    for (const file of files) {
      // Filename pattern: TGT-SO-M-D-YY.csv  or  TGT-SO-M-D-YY-N.csv
      const m = file.name.match(/TGT-SO-(\d+)-(\d+)-(\d+)/i);
      if (!m) continue;

      const month = parseInt(m[1], 10);
      const day   = parseInt(m[2], 10);
      const year  = 2000 + parseInt(m[3], 10);
      const monthKey = `${year}-${String(month).padStart(2, "0")}`;
      const label    = `${m[1]}/${m[2]}`;

      // Download CSV
      const dlRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!dlRes.ok) continue;
      const csvText = await dlRes.text();

      const fileTotal = parseCsvTotal(csvText);
      if (!fileTotal) continue;

      // Accumulate into month totals
      monthMap[monthKey] = (monthMap[monthKey] || 0) + fileTotal;

      // Accumulate into week totals (multiple CSVs can share the same week label)
      if (!weekMap[label]) {
        weekMap[label] = { actual: 0, monthKey, sortKey: year * 10000 + month * 100 + day };
      }
      weekMap[label].actual += fileTotal;
    }

    // Sort weeks chronologically
    const weekly = Object.entries(weekMap)
      .sort((a, b) => a[1].sortKey - b[1].sortKey)
      .map(([label, v]) => ({ label, actual: Math.round(v.actual), monthKey: v.monthKey }));

    // Round monthly totals
    const monthly = Object.fromEntries(
      Object.entries(monthMap).map(([k, v]) => [k, Math.round(v)])
    );

    return { monthly, weekly, source: "google_drive" };

  } catch (e) {
    console.error("Drive fetch error:", e.message);
    return null;
  }
}

// ── Google Service Account JWT auth ─────────────────────────────────────────
async function getGoogleAccessToken(serviceAccountJson) {
  const sa = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);

  const header  = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss:   sa.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud:   "https://oauth2.googleapis.com/token",
    exp:   now + 3600,
    iat:   now
  })).toString("base64url");

  const signingInput = `${header}.${payload}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signingInput);
  const sig = sign.sign(sa.private_key).toString("base64url");
  const jwt = `${signingInput}.${sig}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Google auth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

// ── CSV parsing ──────────────────────────────────────────────────────────────
function parseCsvLine(line) {
  const cols = [];
  let inQuotes = false, cur = "";
  for (const ch of line) {
    if (ch === '"')              { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { cols.push(cur.trim()); cur = ""; }
    else                          { cur += ch; }
  }
  cols.push(cur.trim());
  return cols;
}

function parseCsvTotal(csvText) {
  const lines = csvText.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return 0;

  const header = parseCsvLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z]/g, ""));
  const totalIdx = header.findIndex(h => h === "total");
  const qtyIdx   = header.findIndex(h => h === "qtyorder" || h === "qty" || h === "qtyordered");
  const upcIdx   = header.findIndex(h => h === "upc");

  let sum = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (!cols.length) continue;

    // Skip summary rows (TOTAL label, or blank first columns)
    const first = (cols[0] || "").replace(/[^a-z]/gi, "").toLowerCase();
    if (!first || first === "total") continue;

    if (totalIdx >= 0 && cols[totalIdx]) {
      const val = parseFloat((cols[totalIdx] || "").replace(/[$,\s]/g, ""));
      if (!isNaN(val) && val > 0 && val < 500000) sum += val;
    } else if (upcIdx >= 0 && qtyIdx >= 0) {
      // Older file without Total column — calculate from Qty × UPC price
      const upc   = (cols[upcIdx] || "").trim();
      const qty   = parseInt((cols[qtyIdx] || "0").replace(/[^0-9]/g, ""), 10);
      const price = UPC_PRICES[upc];
      if (price && qty > 0) sum += qty * price;
    }
  }

  return sum;
}

// ── Shopify: paginated fetch (handles >250 orders) ─────────────────────────
async function fetchShopify(from, to) {
  const SHOPIFY_STORE = process.env.SHOPIFY_STORE || "nemah-company.myshopify.com";
  const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!SHOPIFY_TOKEN) return getMockShopifyData();

  const sinceDate = from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const untilDate = to ? new Date(to + "T23:59:59").toISOString() : new Date().toISOString();

  const fields = "id,created_at,total_price,financial_status";
  const baseUrl = `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json`;

  const allOrders = [];
  let url = `${baseUrl}?status=any&created_at_min=${sinceDate}&created_at_max=${untilDate}&limit=250&fields=${fields}`;

  while (url) {
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN } });
    if (!res.ok) return getMockShopifyData();

    const { orders } = await res.json();
    if (orders && orders.length) allOrders.push(...orders);

    const linkHeader = res.headers.get("link") || "";
    const nextMatch = linkHeader.match(/<([^>]*[?&]page_info=[^&>]+[^>]*)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
  }

  const monthlyRevenue = {};
  let totalRevenue = 0;
  let totalOrders = 0;

  allOrders.forEach(order => {
    if (order.financial_status === "paid" || order.financial_status === "partially_paid") {
      const month = order.created_at.slice(0, 7);
      const amount = parseFloat(order.total_price);
      monthlyRevenue[month] = (monthlyRevenue[month] || 0) + amount;
      totalRevenue += amount;
      totalOrders++;
    }
  });

  return { monthly: monthlyRevenue, totalRevenue, totalOrders, source: "shopify_api" };
}

// ── Triple Whale: summary-page API ────────────────────────────────────────
async function fetchTripleWhale(channel, from, to) {
  const TW_API_KEY = process.env.TRIPLEWHALE_API_KEY;
  const SHOP_DOMAIN = process.env.TW_SHOP_ID || "nemah-company.myshopify.com";

  if (!TW_API_KEY) return getMockTWData(channel);

  const today = new Date().toISOString().split("T")[0];
  const start = from
    ? from.split("T")[0]
    : new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split("T")[0];
  const end = to ? to.split("T")[0] : today;

  const body = { shopDomain: SHOP_DOMAIN, period: { start, end } };
  if (end >= today) body.todayHour = new Date().getUTCHours();

  try {
    const res = await fetch("https://api.triplewhale.com/api/v2/summary-page/get-data", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": TW_API_KEY },
      body: JSON.stringify(body)
    });

    if (!res.ok) return getMockTWData(channel);
    const data = await res.json();

    const map = {};
    (data.metrics || []).forEach(m => { map[m.id] = m.values?.current ?? null; });

    if (channel === "amazon") {
      return {
        source: "triplewhale_api",
        period: `${start} → ${end}`,
        amazon_sales:      map.amazonSales       ?? null,
        amazon_orders:     map.amazonOrders      ?? null,
        amazon_ad_spend:   map.amazonAds         ?? null,
        amazon_roas:       map.amazonROAS        ?? null,
        amazon_tacos:      map.amazonTACos       ?? null,
        amazon_net_profit: map.amazonNetProfit   ?? null,
      };
    }

    return {
      source: "triplewhale_api",
      period: `${start} → ${end}`,
      total_revenue:        map.sales            ?? null,
      blended_sales:        map.blendedSales     ?? null,
      gross_profit:         map.grossProfit      ?? null,
      total_ad_spend:       map.blendedAds       ?? null,
      blended_roas:         map.roas             ?? null,
      blended_cpa:          map.totalCpa         ?? null,
      mer:                  map.mer              ?? null,
      facebook_spend:       map.facebookAds      ?? null,
      facebook_roas:        map.facebookRoas     ?? null,
      google_spend:         map.googleAds        ?? null,
      google_roas:          map.googleRoas       ?? null,
      new_customer_revenue: map.newCustomerSales ?? null,
      new_customers_pct:    map.newCustomersPercent ?? null,
      aov:                  map.shopifyAov       ?? null,
    };
  } catch (e) {
    return getMockTWData(channel);
  }
}

// ── Fallback mock data ─────────────────────────────────────────────────────
function getMockShopifyData() {
  return {
    monthly: { "2026-01": 124011, "2026-02": 123181, "2026-03": 182217, "2026-04": 143740 },
    totalRevenue: 143740,
    totalOrders: 2297,
    source: "cached"
  };
}

function getMockTWData(channel) {
  if (channel === "amazon") {
    return { monthly: { "2026-01": 75150, "2026-02": 78332, "2026-03": 81694, "2026-04": 79873 }, source: "cached" };
  }
  return { monthly: { "2026-01": 124011, "2026-02": 123181, "2026-03": 182217, "2026-04": 143740 }, source: "cached" };
}
