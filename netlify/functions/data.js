// netlify/functions/data.js
// Secure API proxy — keeps keys server-side, never exposed to browser

export async function handler(event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const { channel, from, to } = event.queryStringParameters || {};

  try {
    const [shopifyData, twData] = await Promise.all([
      fetchShopify(from, to),
      fetchTripleWhale(channel, from, to)
    ]);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ shopify: shopifyData, triplewhale: twData, fetchedAt: new Date().toISOString() })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
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

  // Paginate through all orders via Link header cursor
  const allOrders = [];
  let url = `${baseUrl}?status=any&created_at_min=${sinceDate}&created_at_max=${untilDate}&limit=250&fields=${fields}`;

  while (url) {
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN } });
    if (!res.ok) return getMockShopifyData();

    const { orders } = await res.json();
    if (orders && orders.length) allOrders.push(...orders);

    // Follow cursor to next page
    const linkHeader = res.headers.get("link") || "";
    const nextMatch = linkHeader.match(/<([^>]*[?&]page_info=[^&>]+[^>]*)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
  }

  // Aggregate by month
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

// ── Triple Whale: summary-page API (no Moby credits needed) ───────────────
async function fetchTripleWhale(channel, from, to) {
  const TW_API_KEY = process.env.TRIPLEWHALE_API_KEY;
  const SHOP_DOMAIN = process.env.TW_SHOP_ID || "nemah-company.myshopify.com";

  if (!TW_API_KEY) return getMockTWData(channel);

  // Build period: default to current month if no dates provided
  const today = new Date().toISOString().split("T")[0];
  const start = from
    ? from.split("T")[0]
    : new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split("T")[0];
  const end = to ? to.split("T")[0] : today;

  const body = { shopDomain: SHOP_DOMAIN, period: { start, end } };

  // TW requires todayHour when the end date is today
  if (end >= today) {
    body.todayHour = new Date().getUTCHours();
  }

  try {
    const res = await fetch("https://api.triplewhale.com/api/v2/summary-page/get-data", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": TW_API_KEY },
      body: JSON.stringify(body)
    });

    if (!res.ok) return getMockTWData(channel);

    const data = await res.json();

    // Build lookup map: metricId → current value
    const map = {};
    (data.metrics || []).forEach(m => {
      map[m.id] = m.values?.current ?? null;
    });

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

    // DTC / blended view
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

// ── Fallback mock data (April 2026 actuals) ────────────────────────────────
function getMockShopifyData() {
  return {
    monthly: {
      "2026-01": 124011, "2026-02": 123181, "2026-03": 182217, "2026-04": 143740
    },
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
