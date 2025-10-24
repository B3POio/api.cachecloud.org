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

// --- NEW: tiny cache for FX ---
const fxCache = new Map(); // key -> { val, exp }
function setFx(key, val, ttlSec = 300) {
  fxCache.set(key, { val, exp: Date.now() + ttlSec * 1000 });
}
function getFx(key) {
  const x = fxCache.get(key);
  if (!x) return null;
  if (Date.now() > x.exp) { fxCache.delete(key); return null; }
  return x.val;
}

// --- NEW: same FX sources you already use in crypto controller ---
const FX_COINBASE = "https://api.coinbase.com/v2/exchange-rates?currency=USD";
const FX_OPEN_ER  = "https://open.er-api.com/v6/latest/USD";

async function getUsdToFiatRate(targetFiat /* "USD"|"EUR"|"GBP" */) {
  const fiat = String(targetFiat || "USD").toUpperCase();
  if (fiat === "USD") return 1;

  const cacheKey = `fx:USD:${fiat}`;
  const hit = getFx(cacheKey);
  if (hit) return hit;

  // 1) Coinbase FX
  try {
    const { data } = await axios.get(FX_COINBASE, { timeout: 8000 });
    const rateStr = data?.data?.rates?.[fiat];
    const rate = rateStr != null ? Number(rateStr) : undefined;
    if (rate && isFinite(rate) && rate > 0) { setFx(cacheKey, rate, 300); return rate; }
  } catch {}

  // 2) Open ER fallback
  try {
    const { data } = await axios.get(FX_OPEN_ER, { timeout: 8000 });
    const rate = data?.rates?.[fiat];
    if (rate && isFinite(Number(rate)) && Number(rate) > 0) {
      setFx(cacheKey, Number(rate), 300);
      return Number(rate);
    }
  } catch {}

  throw new Error(`FX rate not available for ${fiat}`);
}

/* ----------------------- GET /metals/summary ----------------------- */
/**
 * Optional query params:
 *   base=[XAU|XAG|XPT|XPD]     (default: all four)
 *   currency=[USD]             (API Ninjas quotes are USD; we keep USD)
 */
// ----------------------- GET /metals/summary -----------------------
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
      rawBase || undefined;

    // NEW: accept EUR/GBP; default USD
    const reqCurrency = String(req.query.currency || "USD").toUpperCase();
    const currency = ["USD", "EUR", "GBP"].includes(reqCurrency) ? reqCurrency : "USD";

    const ALL = ["XAU", "XAG", "XPT", "XPD"];
    const wanted = ALL.filter((b) => !base || b === base);
    const toName = (b) => (b === "XAU" ? "gold" : b === "XAG" ? "silver" : b === "XPT" ? "platinum" : "palladium");

    const items = [];
    for (const b of wanted) {
      const name = toName(b);

      // 1) Always fetch USD spot from API Ninjas (their native quote)
      const nin = await ninjaGet("/commodityprice", { name }); // USD-only
      const row = Array.isArray(nin) ? nin[0] : nin;
      const priceUsd = toNum(row?.price);
      const time = row?.time != null ? Number(row.time) : null;

      // 2) Convert to requested currency using FX (only if not USD)
      let price = priceUsd;
      if (price != null && currency !== "USD") {
        const r = await getUsdToFiatRate(currency);
        price = priceUsd * r;
      }

      items.push({
        symbol: `${b}/${currency}`,
        name,
        currency,
        price,
        change: null,
        percentChange: null,
        open: null,
        high: null,
        low: null,
        previousClose: null,
        datetime: time ? new Date(time * 1000).toISOString() : new Date().toISOString(),
        provider: currency === "USD" ? "api-ninjas" : "api-ninjas+fx",
      });
    }

    return res.json({ updatedAt: new Date().toISOString(), items });
  } catch (err) {
    console.error("[/metals/summary] error:", err);
    return res.status(err.status || 502).json({
      error: err?.expose && err.message ? err.message : "Failed to fetch metals summary",
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
