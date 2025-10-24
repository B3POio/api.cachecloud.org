// controllers/crypto.controller.js
// Node 18+ has global fetch; no extra deps needed.

const P = {
  COINPAPRIKA: "https://api.coinpaprika.com/v1",
  COINCAP: "https://api.coincap.io/v2",
  COINBASE: "https://api.exchange.coinbase.com",
  FX_COINBASE: "https://api.coinbase.com/v2/exchange-rates?currency=USD",
  FX_OPEN_ER: "https://open.er-api.com/v6/latest/USD",
};


// helpers
const norm = (s) => String(s || "").trim().toUpperCase();
const normSymbol = (s) => norm(s);
const normFiat = (s) => {
  const f = norm(s || "USD");
  // Guard against non-3-letter values
  return /^[A-Z]{3}$/.test(f) ? f : "USD";
};

// tiny in-memory cache (swap for Redis later without changing route shapes)
const cache = new Map(); // key -> { data, exp }
function setCache(key, data, ttlSec) {
  cache.set(key, { data, exp: Date.now() + ttlSec * 1000 });
}
function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.exp) {
    cache.delete(key);
    return null;
  }
  return item.data;
}

// generic GET with minimal retry/backoff
async function httpGet(url, init = {}, retries = 1) {
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(url, { ...init, redirect: "follow" });
    if (res.ok) return res.json();
    if (i < retries && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
      continue;
    }
    const text = await res.text().catch(() => "");
    throw new Error(`GET ${url} failed: ${res.status} ${text}`);
  }
}

// cross-provider ids for core assets
const IDMAP = {
  BTC: {
    coincap: "bitcoin",
    paprika: "btc-bitcoin",
    coinbase: {
      USD: "BTC-USD",
      EUR: "BTC-EUR",
      GBP: "BTC-GBP",
    },
  },
  ETH: {
    coincap: "ethereum",
    paprika: "eth-ethereum",
    coinbase: {
      USD: "ETH-USD",
      EUR: "ETH-EUR",
      GBP: "ETH-GBP",
    },
  },
};

// ---------- FX (USD -> target fiat) ----------
async function getUsdToFiatRate(targetFiat) {
  const fiat = normFiat(targetFiat);
  if (fiat === "USD") return 1;

  const key = `fx:USD:${fiat}`;
  const hit = getCache(key);
  if (hit) return hit;

  // 1) Try Coinbase FX
  try {
    const cb = await httpGet(P.FX_COINBASE, {}, 1); // { data: { currency: "USD", rates: { EUR: "0.92", ... } } }
    const rateStr = cb?.data?.rates?.[fiat];
    const rate = rateStr != null ? Number(rateStr) : undefined;
    if (rate && isFinite(rate) && rate > 0) {
      setCache(key, rate, 300);
      return rate;
    }
  } catch (_) {
    // ignore & fall through
  }

  // 2) Fallback: Open ER API
  try {
    const er = await httpGet(P.FX_OPEN_ER, {}, 1); // { result: "success", base_code: "USD", rates: { EUR: 0.92, ... } }
    const rate = er?.rates?.[fiat];
    if (rate && isFinite(Number(rate)) && Number(rate) > 0) {
      setCache(key, Number(rate), 300);
      return Number(rate);
    }
  } catch (_) {
    // ignore & throw below
  }

  throw new Error(`FX rate not available for ${fiat}`);
}


function convertVal(valUsd, usdToFiatRate) {
  if (valUsd == null) return null;
  const n = Number(valUsd);
  if (!isFinite(n)) return null;
  return n * usdToFiatRate;
}

function convertOHLC(candles, usdToFiatRate) {
  return (candles || []).map((c) => ({
    t: c.t,
    o: c.o != null ? c.o * usdToFiatRate : null,
    h: c.h != null ? c.h * usdToFiatRate : null,
    l: c.l != null ? c.l * usdToFiatRate : null,
    c: c.c != null ? c.c * usdToFiatRate : null,
  }));
}

/* ----------------------- Provider helpers ----------------------- */

async function paprikaGlobal() {
  const url = `${P.COINPAPRIKA}/global`;
  const data = await httpGet(url, {}, 1);
  return {
    marketCapUsd: data.market_cap_usd ?? null,
    volume24hUsd: data.volume_24h_usd ?? null,
    btcDominancePct: data.bitcoin_dominance_percentage ?? null,
    updatedAt: data.last_updated ?? new Date().toISOString(),
    provider: "coinpaprika",
  };
}

// currency-aware tickers from Paprika where possible
async function paprikaTickers(pairs /* [{symbol, paprikaId}] */, currency /* fiat */) {
  const out = [];
  const cur = normFiat(currency);
  for (const p of pairs) {
    const url = `${P.COINPAPRIKA}/tickers/${p.paprikaId}`;
    const t = await httpGet(url, {}, 1);
    const qUSD = t.quotes?.USD;
    const qCUR = t.quotes?.[cur];

    out.push({
      symbol: p.symbol,
      // Paprika may have direct fiat quotes (EUR/GBP etc.). Prefer them; keep USD alongside.
      price: qCUR?.price ?? null,
      marketCap: qCUR?.market_cap ?? null,
      volume24h: qCUR?.volume_24h ?? null,

      // Always include USD baselines for compatibility
      priceUsd: qUSD?.price ?? null,
      marketCapUsd: qUSD?.market_cap ?? null,
      volume24hUsd: qUSD?.volume_24h ?? null,

      change24hPct: qUSD?.percent_change_24h ?? null, // percent does not depend on fiat
      provider: "coinpaprika",
      currency: cur,
    });
  }
  return out;
}

async function coincapAssets(ids /* array of ids string */) {
  const url = `${P.COINCAP}/assets?ids=${ids.join(",")}`;
  const headers = process.env.COINCAP_API_KEY
    ? { Authorization: `Bearer ${process.env.COINCAP_API_KEY}` }
    : undefined;
  const data = await httpGet(url, { headers }, 1);
  return (data.data || []).map((a) => ({
    symbol: a.symbol?.toUpperCase(),
    priceUsd: a.priceUsd ? Number(a.priceUsd) : null,
    change24hPct: a.changePercent24Hr ? Number(a.changePercent24Hr) : null,
    marketCapUsd: a.marketCapUsd ? Number(a.marketCapUsd) : null,
    volume24hUsd: a.volumeUsd24Hr ? Number(a.volumeUsd24Hr) : null,
    provider: "coincap",
  }));
}

// CoinCap intraday/daily candles (preferred OHLC). Always USD quote; we convert later if needed.
async function coincapCandles({ baseId, interval, startMs, endMs }) {
  const headers = process.env.COINCAP_API_KEY
    ? { Authorization: `Bearer ${process.env.COINCAP_API_KEY}` }
    : undefined;
  const url = `${P.COINCAP}/candles?exchange=coinbase-pro&interval=${interval}&baseId=${baseId}&quoteId=usd&start=${startMs}&end=${endMs}`;
  const d = await httpGet(url, { headers }, 1);
  return (d.data || []).map((c) => ({
    t: c.period,
    o: Number(c.open),
    h: Number(c.high),
    l: Number(c.low),
    c: Number(c.close),
  }));
}

// CoinCap history fallback (close-only series; we emit o=h=l=c). USD only; convert later if needed.
async function coincapHistory({ baseId, interval, startMs, endMs }) {
  const headers = process.env.COINCAP_API_KEY
    ? { Authorization: `Bearer ${process.env.COINCAP_API_KEY}` }
    : undefined;
  const url = `${P.COINCAP}/assets/${baseId}/history?interval=${interval}&start=${startMs}&end=${endMs}`;
  const d = await httpGet(url, { headers }, 1);
  return (d.data || []).map((pt) => {
    const t = pt.time || pt.date || pt.period;
    const price = Number(pt.priceUsd);
    return { t, o: price, h: price, l: price, c: price };
  });
}

// Coinbase Exchange candles (public, no key). Granularities: 60,300,900,3600,21600,86400
function mapIntervalToCoinbaseGranularity(interval) {
  const m = {
    m1: 60,
    m5: 300,
    m15: 900,
    m30: 1800,     // not officially listed; coinbase uses 1800? If 1800 fails, we’ll round up to 3600 below.
    h1: 3600,
    h2: 7200,
    h6: 21600,
    h12: 43200,    // not standard; will round to 21600 or 86400
    d1: 86400,
  };
  let g = m[interval] || 3600;
  // normalize to Coinbase-supported set
  const allowed = [60, 300, 900, 3600, 21600, 86400];
  if (!allowed.includes(g)) {
    // round to nearest allowed
    g = allowed.reduce((prev, cur) => (Math.abs(cur - g) < Math.abs(prev - g) ? cur : prev), allowed[0]);
  }
  return g;
}

// --- add: human range parser (d/w/m/y) ---
function parseRangeToDays(rangeStr) {
  const s = String(rangeStr || "").trim().toLowerCase();
  const m = s.match(/^(\d+)\s*([dwmy])$/); // e.g. 2w, 1m, 3d, 1y
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    if (unit === "d") return n;
    if (unit === "w") return n * 7;
    if (unit === "m") return n * 30;   // treat "month" as 30d for charts
    if (unit === "y") return n * 365;
  }
  // Back-compat: if they passed plain "30d" or unknown -> try old logic
  if (s.endsWith("d")) return Number(s.slice(0, -1)) || 30;
  if (s === "1y") return 365;
  return 30;
}

// --- add: pick a sane OHLC interval for the range ---
function pickIntervalAuto(days) {
  if (days <= 2) return "m5";         // 1–2d → 5m
  if (days <= 3) return "m15";        // 3d   → 15m
  if (days <= 7) return "m30";        // 7d   → 30m
  if (days <= 14) return "h1";        // 2w   → 1h
  if (days <= 30) return "h2";        // 1m   → 2h
  if (days <= 90) return "h6";        // 3m   → 6h
  return "d1";                        // long → 1d
}

// Ensure ≤ 300 points
function adjustGranularityForRange(initialGranularitySec, startMs, endMs) {
  const allowed = [60, 300, 900, 3600, 21600, 86400]; // 1m,5m,15m,1h,6h,1d
  let g = initialGranularitySec;
  const rangeMs = endMs - startMs;
  while ((rangeMs / (g * 1000)) > 300) {
    const i = allowed.indexOf(g);
    if (i === -1 || i === allowed.length - 1) break; // already at max (1d)
    g = allowed[i + 1];
  }
  return g;
}

async function coinbaseCandles({ productId, interval, startMs, endMs }) {
  let gran = mapIntervalToCoinbaseGranularity(interval);
  gran = adjustGranularityForRange(gran, startMs, endMs); // ensure ≤ 300 points

  const startISO = new Date(startMs).toISOString();
  const endISO = new Date(endMs).toISOString();
  const url = `${P.COINBASE}/products/${productId}/candles?granularity=${gran}&start=${startISO}&end=${endISO}`;
  const res = await fetch(url, { headers: { "User-Agent": "cachecloud-api" } });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`GET ${url} failed: ${res.status} ${txt}`);
  }
  const arr = await res.json(); // [ time, low, high, open, close, volume ]
  const candles = (arr || [])
    .map((row) => ({ t: row[0] * 1000, l: +row[1], h: +row[2], o: +row[3], c: +row[4] }))
    .sort((a, b) => a.t - b.t);
  return candles;
}

/* ----------------------- Controllers ----------------------- */

// GET /api/crypto/global?currency=EUR
export async function getGlobal(req, res, next) {
  try {
    const currency = normFiat(req.query.currency || "USD");
    const key = `global:${currency}`;
    const hit = getCache(key);
    if (hit) return res.json(hit);

    let base;
    try {
      base = await paprikaGlobal();
    } catch {
      // CoinCap approximation if Paprika unavailable (USD)
      const headers = process.env.COINCAP_API_KEY
        ? { Authorization: `Bearer ${process.env.COINCAP_API_KEY}` }
        : undefined;
      const top = await httpGet(`${P.COINCAP}/assets?limit=200`, { headers }, 1);
      const arr = top.data || [];
      const marketCapUsd = arr.reduce((s, a) => s + Number(a.marketCapUsd || 0), 0);
      const volume24hUsd = arr.reduce((s, a) => s + Number(a.volumeUsd24Hr || 0), 0);
      base = {
        marketCapUsd,
        volume24hUsd,
        btcDominancePct: null,
        updatedAt: new Date().toISOString(),
        provider: "coincap-approx",
      };
    }

    let out = { ...base, currency, marketCap: null, volume24h: null };
    if (currency === "USD") {
      out.marketCap = base.marketCapUsd;
      out.volume24h = base.volume24hUsd;
    } else {
      const r = await getUsdToFiatRate(currency);
      out.marketCap = convertVal(base.marketCapUsd, r);
      out.volume24h = convertVal(base.volume24hUsd, r);
    }

    setCache(key, out, 60);
    res.json(out);
  } catch (err) {
    next(err);
  }
}

// GET /api/crypto/summary?symbols=BTC,ETH&currency=GBP
export async function getSummary(req, res, next) {
  try {
    const currency = normFiat(req.query.currency || "USD");
    const symbols = (req.query.symbols || "BTC,ETH")
      .toString()
      .split(",")
      .map((s) => normSymbol(s))
      .filter(Boolean);

    const key = `summary:${symbols.join(",")}:${currency}`;
    const hit = getCache(key);
    if (hit) return res.json(hit);

    // 1) Paprika first (might or might not include direct EUR/GBP quotes)
    const paprikaPairs = symbols
      .filter((s) => IDMAP[s]?.paprika)
      .map((s) => ({ symbol: s, paprikaId: IDMAP[s].paprika }));

    let list = [];
    try {
      if (paprikaPairs.length) list = await paprikaTickers(paprikaPairs, currency);
    } catch {
      list = [];
    }

    // 2) Fill any missing symbols via CoinCap (USD values; we'll convert later if needed)
    const missingSyms = symbols.filter(
      (s) => !list.find((x) => x.symbol === s) && IDMAP[s]?.coincap
    );

    if (missingSyms.length) {
      const ids = missingSyms.map((s) => IDMAP[s].coincap);
      const cc = await coincapAssets(ids);
      const ccMapped = cc
        .filter((x) => missingSyms.includes(x.symbol))
        .map((x) => ({
          symbol: x.symbol,
          // leave 'price' null for now; we convert after merge
          price: null,
          marketCap: null,
          volume24h: null,

          // USD baselines (from CoinCap):
          priceUsd: x.priceUsd,
          marketCapUsd: x.marketCapUsd,
          volume24hUsd: x.volume24hUsd,

          change24hPct: x.change24hPct,
          provider: x.provider,
          currency, // requested fiat
        }));
      list = list.concat(ccMapped);
    }

    // 3) 🔁 Conversion pass:
    // For any item with missing fiat fields, convert from USD baselines using FX.
    if (currency !== "USD") {
      const usdToFiat = await getUsdToFiatRate(currency);
      list = list.map((x) => ({
        ...x,
        price: x.price ?? convertVal(x.priceUsd, usdToFiat),
        marketCap: x.marketCap ?? convertVal(x.marketCapUsd, usdToFiat),
        volume24h: x.volume24h ?? convertVal(x.volume24hUsd, usdToFiat),
        currency,
      }));
    } else {
      // Ensure fiat fields are filled for USD as well (mirror baselines)
      list = list.map((x) => ({
        ...x,
        price: x.price ?? x.priceUsd ?? null,
        marketCap: x.marketCap ?? x.marketCapUsd ?? null,
        volume24h: x.volume24h ?? x.volume24hUsd ?? null,
        currency,
      }));
    }

    // 4) Guarantee order + shape
    const normalized = symbols.map((s) => {
      const found = list.find((x) => x.symbol === s);
      return (
        found || {
          symbol: s,
          price: null,
          priceUsd: null,
          change24hPct: null,
          marketCap: null,
          marketCapUsd: null,
          volume24h: null,
          volume24hUsd: null,
          provider: null,
          currency,
        }
      );
    });

    const out = { symbols, currency, data: normalized, updatedAt: new Date().toISOString() };
    setCache(key, out, 20);
    res.json(out);
  } catch (err) {
    next(err);
  }
}


// GET /api/crypto/chart?symbol=BTC&interval=auto&range=2w&currency=EUR
export async function getChart(req, res, next) {
  try {
    const symbol = norm(req.query.symbol || "BTC");
    const currency = normFiat(req.query.currency || "USD");
    const rawInterval = String(req.query.interval || "auto");
    const rawRange = String(req.query.range || "30d");

    const ids = IDMAP[symbol];
    if (!ids) return res.status(400).json({ error: `Unsupported symbol: ${symbol}` });

    const now = Date.now();
    const days = parseRangeToDays(rawRange);
    const startMs = now - days * 24 * 60 * 60 * 1000;
    const interval = rawInterval === "auto" ? pickIntervalAuto(days) : rawInterval;

    const key = `chart:${symbol}:${interval}:${days}d:${currency}`;
    const hit = getCache(key);
    if (hit) return res.json(hit);

    let candles = [];
    let provider = null;

    // 1) Try CoinCap candles (USD-only OHLC → convert if needed)
    if (!process.env.DISABLE_COINCAP) {
      try {
        candles = await coincapCandles({ baseId: ids.coincap, interval, startMs, endMs: now });
        provider = "coincap";
      } catch {
        // continue
      }
    }

    // 2) Fallback: CoinCap history (close-only series; USD → convert)
    if (!candles || candles.length === 0) {
      try {
        candles = await coincapHistory({ baseId: ids.coincap, interval, startMs, endMs: now });
        provider = "coincap-history";
      } catch {
        // continue
      }
    }

    // 3) Coinbase candles with direct fiat product (USD/EUR/GBP)
    let coinbaseUsedDirectFiat = false;
    if ((!candles || candles.length === 0) && ids.coinbase) {
      const productId =
        ids.coinbase[currency] || ids.coinbase["USD"]; // prefer direct fiat pair; else USD
      try {
        candles = await coinbaseCandles({
          productId,
          interval,
          startMs,
          endMs: now,
        });
        provider = "coinbase";
        coinbaseUsedDirectFiat = !!ids.coinbase[currency];
      } catch (e) {
        return res
          .status(502)
          .json({ error: "All providers unavailable for chart data", detail: e.message });
      }
    }

    if (!candles || candles.length === 0) {
      return res.status(502).json({ error: "All providers unavailable for chart data" });
    }

    // If data is in USD (CoinCap or Coinbase USD product), convert to target fiat
    let convertedCandles = candles;
    let convertedFrom = null;

    if (currency !== "USD") {
      const sourcedInUsd =
        provider === "coincap" ||
        provider === "coincap-history" ||
        (provider === "coinbase" && !coinbaseUsedDirectFiat);

      if (sourcedInUsd) {
        const r = await getUsdToFiatRate(currency);
        convertedCandles = convertOHLC(candles, r);
        convertedFrom = "USD";
      }
    }

    const out = {
      symbol,
      currency,
      interval, // actual interval used (might be auto-derived)
      range: rawRange, // echo back input like "2w", "1m"
      days, // resolved day count
      candles: convertedCandles,
      provider,
      convertedFrom, // "USD" when conversion was applied; null if native fiat
      updatedAt: new Date().toISOString(),
    };
    setCache(key, out, 600); // 10m cache
    res.json(out);
  } catch (err) {
    next(err);
  }
}
