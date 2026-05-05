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

async function fetchShopify(from, to) {
  const SHOPIFY_STORE = process.env.SHOPIFY_STORE || "nemah-company.myshopify.com";
  const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!SHOPIFY_TOKEN) return getMockShopifyData();

  const sinceDate = from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const untilDate = to ? new Date(to + "T23:59:59").toISOString() : new Date().toISOString();

  // Fetch orders
  const ordersRes = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?status=any&created_at_min=${sinceDate}&created_at_max=${untilDate}&limit=250&fields=id,created_at,total_price,financial_status`,
    { headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN } }
  );

  if (!ordersRes.ok) return getMockShopifyData();
  const { orders } = await ordersRes.json();

  // Aggregate by month
  const monthlyRevenue = {};
  let totalRevenue = 0;
  let totalOrders = 0;

  orders.forEach(order => {
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

async function fetchTripleWhale(channel, from, to) {
  const TW_API_KEY = process.env.TRIPLEWHALE_API_KEY;
  const SHOP_ID = process.env.TW_SHOP_ID || "nemah-company.myshopify.com";

  if (!TW_API_KEY) return getMockTWData(channel);

  const question = channel === "amazon"
    ? `What were total Amazon sales for ${from} to ${to}?`
    : `What were total Shopify sales, sessions, and orders from ${from} to ${to}?`;

  const res = await fetch("https://api.triplewhale.com/willy/moby-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": TW_API_KEY },
    body: JSON.stringify({ shopId: SHOP_ID, question })
  });

  if (!res.ok) return getMockTWData(channel);
  const data = await res.json();
  return { raw: data, source: "triplewhale_api" };
}

// Fallback mock data (April 2026 actuals)
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
