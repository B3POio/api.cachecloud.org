// controllers/metals.controller.js
import axios from "axios";

/**
 * API Ninjas
 * Docs:
 *   - Commodity Price (spot):      https://api-ninjas.com/api/commodityprice
 *   - Commodity Historical:        https://api-ninjas.com/api/commodityprice (…historical on host)
 * Endpoints:
 *   - GET https://api.api-ninjas.com/v1/commodityprice?name=gold
 *   - GET https://api.api-ninjas.com/v1/commoditypricehistorical?name=gold&period=1h&start=1700000000&end=1700100000
 */

const NINJAS_BASE = "https://api.api-ninjas.com/v1";
const API_KEY = process.env.API_NINJA_API_KEY || process.env.API_NINJAS_API_KEY || process.env.API_NINJA_APIKEY;

if (!API_KEY) {
  console.warn(
    "[metals.controller] Missing API_NINJA_API_KEY (or API_NINJAS_API_KEY). " +
      "Set it in your environment to enable metals endpoints."
  );
}

/* --------------------------- helpers --------------------------- */

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function unixNowSec() {
  return Math.floor(Date.now() / 1000);
}

function toISOFromUnix(sec) {
  const t = Number(sec) * 1000;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

async function ninjaGet(path, params = {}) {
  const url = `${NINJAS_BASE}${path}`;
  try {
    const { data } = await axios.get(url, {
      params,
      headers: { "X-Api-Key": API_KEY },
      timeout: 10_000,
    });
    return data;
  } catch (err) {
    // Normalize API Ninjas error shapes
    const status = err?.response?.status;
    const msg = err?.response?.data?.error || err?.response?.data?.message || err.message;
    const e = new Error(msg || "API Ninjas request failed");
    e.status = status || 500;
    e.expose = true;
    throw e;
  }
}

// symbol "XAU/USD" → { name: "gold", base: "XAU", currency: "USD" }
function parseSymbol(symRaw) {
  const symbol = String(symRaw || "XAU/USD").toUpperCase();
  const [base, currency] = symbol.split("/");
  const name = base === "XAU" ? "gold"
             : base === "XAG" ? "silver"
             : base === "XPT" ? "platinum"
             : base === "XPD" ? "palladium"
             : "gold";
  return { symbol, base, currency: currency || "USD", name };
}

/**
 * Map UI ranges to {period, start, end}. We also accept "1w"/"2w".
 * Period choices keep responses lean but smooth for charts.
 */
function rangeToHistoricalParams(rangeIn) {
  const range = String(rangeIn || "30d").toLowerCase();
  const now = unixNowSec();

  function fromDays(days, period) {
    const secs = Math.max(1, Math.floor(Number(days))) * 24 * 60 * 60;
    return { period, start: now - secs, end: now };
  }

  switch (range) {
    case "1d":
      return fromDays(1, "15m");     // 15-min bars
    case "2d":
      return fromDays(2, "30m");     // 30-min bars
    case "3d":
      return fromDays(3, "1h");      // 1-hour bars
    case "1w":
    case "7d":
      return fromDays(7, "4h");      // 4-hour bars
    case "2w":
    case "14d":
      return fromDays(14, "4h");     // 4-hour bars
    case "30d":
      return fromDays(30, "1d");     // 1-day bars
    case "60d":
      return fromDays(60, "1d");     // 1-day bars
    case "90d":
      return fromDays(90, "1d");     // 1-day bars
    case "180d":
      return fromDays(180, "1d");    // 2-day bars
    case "1y":
    case "365d":
      return fromDays(365, "1d");    // 2-day bars (coarser)
    default:
      return fromDays(30, "1d");     // fallback
  }
}


/* ----------------------- GET /metals/summary ----------------------- */
/**
 * Optional query params:
 *   base=[XAU|XAG|XPT|XPD]     (default: all four)
 *   currency=[USD]             (API Ninjas quotes are USD; we keep USD)
 */
export async function getSummary(req, res) {
  try {
    if (!API_KEY) {
      return res.status(500).json({ error: "Server is not configured with API_NINJA_API_KEY" });
    }

    const rawBase = String(req.query.base || "").toUpperCase();
    const base =
      rawBase === "GOLD" ? "XAU" :
      rawBase === "SILVER" ? "XAG" :
      rawBase === "PLATINUM" ? "XPT" :
      rawBase === "PALLADIUM" ? "XPD" :
      rawBase || undefined; // keep original for XAU/XAG/etc
    // API Ninjas commodityprice is USD; keep currency fixed to USD to match the UI
    const currency = "USD";

    // Supported bases and mapping to commodity names
    const ALL = ["XAU", "XAG", "XPT", "XPD"];
    const wanted = ALL.filter((b) => !base || b === base);

    // Map to API names
    const toName = (b) =>
      b === "XAU" ? "gold" : b === "XAG" ? "silver" : b === "XPT" ? "platinum" : "palladium";

    // Fetch serially to stay within rate limits; switch to Promise.all if comfortable
    const items = [];
    for (const b of wanted) {
      const name = toName(b);
      const data = await ninjaGet("/commodityprice", { name });
      // API can return array or object; normalize
      const row = Array.isArray(data) ? data[0] : data;
      const price = toNum(row?.price);
      const time = row?.time != null ? Number(row.time) : null;

      items.push({
        symbol: `${b}/${currency}`,
        name,
        currency,
        price,
        change: null,          // 24h delta enriched on the proxy already (optional)
        percentChange: null,
        open: null,
        high: null,
        low: null,
        previousClose: null,
        datetime: time ? new Date(time * 1000).toISOString() : new Date().toISOString(),
      });
    }

    return res.json({
      updatedAt: new Date().toISOString(),
      items,
    });
  } catch (err) {
    console.error("[/metals/summary] error:", err);
    return res.status(err.status || 502).json({
      error: err?.expose && err.message ? err.message : "Failed to fetch metals summary from API Ninjas",
    });
  }
}

/* ------------------------ GET /metals/chart ------------------------ */
/**
 * Query:
 *   symbol=XAU/USD
 *   range=1d|2d|3d|7d|14d|30d  (also accepts 1w/2w)
 */
export async function getChart(req, res) {
  try {
    if (!API_KEY) {
      return res.status(500).json({ error: "Server is not configured with API_NINJA_API_KEY" });
    }

    const { symbol, name } = parseSymbol(req.query.symbol || "XAU/USD");
    const range = (req.query.range || "30d").toLowerCase();

    const { period, start, end } = rangeToHistoricalParams(range);

    const hist = await ninjaGet("/commoditypricehistorical", {
      name,
      period,
      start,
      end,
    });

    // Normalize possible array/object shapes
    const values = Array.isArray(hist) ? hist : Array.isArray(hist?.prices) ? hist.prices : [];

    // Map and sort ascending; guard for dupes by time
    const map = new Map();
    for (const v of values) {
      const tsec = Number(v?.time);
      if (!Number.isFinite(tsec)) continue;
      map.set(tsec, {
        t: toISOFromUnix(tsec),
        o: toNum(v?.open),
        h: toNum(v?.high),
        l: toNum(v?.low),
        c: toNum(v?.close ?? v?.price),
      });
    }
    const points = Array.from(map.keys())
      .sort((a, b) => a - b)
      .map((k) => map.get(k));

    return res.json({
      symbol,
      interval: period, // expose chosen period for debugging
      range,
      points,
    });
  } catch (err) {
    console.error("[/metals/chart] error:", err);
    return res.status(err.status || 502).json({
      error: err?.expose && err.message ? err.message : "Failed to fetch metals chart from API Ninjas",
    });
  }
}

export default {
  getSummary,
  getChart,
};
