// controllers/crypto.controller.js
// Node 18+ has global fetch; no extra deps needed.

const P = {
  COINPAPRIKA: "https://api.coinpaprika.com/v1",
  COINCAP: "https://api.coincap.io/v2",
  COINBASE: "https://api.exchange.coinbase.com",
};

// helpers
const norm = (s) => String(s || "").trim().toUpperCase();
const normSymbol = (s) => norm(s);

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
  BTC: { coincap: "bitcoin", paprika: "btc-bitcoin", coinbase: "BTC-USD" },
  ETH: { coincap: "ethereum", paprika: "eth-ethereum", coinbase: "ETH-USD" },
};

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

async function paprikaTickers(pairs /* [{symbol, paprikaId}] */) {
  const out = [];
  for (const p of pairs) {
    const url = `${P.COINPAPRIKA}/tickers/${p.paprikaId}`;
    const t = await httpGet(url, {}, 1);
    out.push({
      symbol: p.symbol,
      priceUsd: t.quotes?.USD?.price ?? null,
      change24hPct: t.quotes?.USD?.percent_change_24h ?? null,
      marketCapUsd: t.quotes?.USD?.market_cap ?? null,
      volume24hUsd: t.quotes?.USD?.volume_24h ?? null,
      provider: "coinpaprika",
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

// CoinCap intraday/daily candles (preferred OHLC)
async function coincapCandles({ baseId, interval, startMs, endMs }) {
  // intervals: m1,m5,m15,m30,h1,h2,h6,h12,d1
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

// CoinCap history fallback (close-only series; we emit o=h=l=c)
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
// We aim for ~200 points, within CoinCap/Coinbase supported set.
function pickIntervalAuto(days) {
  if (days <= 2) return "m5";         // 1–2d → 5m
  if (days <= 3) return "m15";        // 3d   → 15m
  if (days <= 7) return "m30";        // 7d   → 30m
  if (days <= 14) return "h1";        // 2w   → 1h
  if (days <= 30) return "h2";        // 1m   → 2h
  if (days <= 90) return "h6";        // 3m   → 6h
  return "d1";                        // long → 1d
}

// 1) Add this helper near your granularity mapper
function adjustGranularityForRange(initialGranularitySec, startMs, endMs) {
  const allowed = [60, 300, 900, 3600, 21600, 86400]; // 1m,5m,15m,1h,6h,1d
  let g = initialGranularitySec;
  const rangeMs = endMs - startMs;

  // If more than 300 buckets, bump to the next larger granularity
  while ((rangeMs / (g * 1000)) > 300) {
    const i = allowed.indexOf(g);
    if (i === -1 || i === allowed.length - 1) break; // already at max (1d)
    g = allowed[i + 1];
  }
  return g;
}


// 2) Update your coinbaseCandles() to use that helper
async function coinbaseCandles({ productId, interval, startMs, endMs }) {
  let gran = mapIntervalToCoinbaseGranularity(interval);
  gran = adjustGranularityForRange(gran, startMs, endMs); // 👈 ensure ≤ 300 points

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

  // Optional: you can return gran so callers know the actual resolution used
  return candles;
}


/* ----------------------- Controllers ----------------------- */

// GET /api/crypto/global
export async function getGlobal(_req, res, next) {
  try {
    const key = "global";
    const hit = getCache(key);
    if (hit) return res.json(hit);

    let out;
    try {
      out = await paprikaGlobal();
    } catch {
      // CoinCap approximation if Paprika unavailable
      const headers = process.env.COINCAP_API_KEY
        ? { Authorization: `Bearer ${process.env.COINCAP_API_KEY}` }
        : undefined;
      const top = await httpGet(`${P.COINCAP}/assets?limit=200`, { headers }, 1);
      const arr = top.data || [];
      const marketCapUsd = arr.reduce((s, a) => s + Number(a.marketCapUsd || 0), 0);
      const volume24hUsd = arr.reduce((s, a) => s + Number(a.volumeUsd24Hr || 0), 0);
      out = {
        marketCapUsd,
        volume24hUsd,
        btcDominancePct: null,
        updatedAt: new Date().toISOString(),
        provider: "coincap-approx",
      };
    }

    setCache(key, out, 60);
    res.json(out);
  } catch (err) {
    next(err);
  }
}

// GET /api/crypto/summary?symbols=BTC,ETH
export async function getSummary(req, res, next) {
  try {
    const symbols = (req.query.symbols || "BTC,ETH")
      .toString()
      .split(",")
      .map((s) => normSymbol(s))
      .filter(Boolean);

    const key = `summary:${symbols.join(",")}`;
    const hit = getCache(key);
    if (hit) return res.json(hit);

    // Paprika first
    const paprikaPairs = symbols
      .filter((s) => IDMAP[s]?.paprika)
      .map((s) => ({ symbol: s, paprikaId: IDMAP[s].paprika }));

    let list = [];
    try {
      if (paprikaPairs.length) list = await paprikaTickers(paprikaPairs);
    } catch {
      list = [];
    }

    // Fill any missing via CoinCap
    const missing = symbols.filter((s) => !list.find((x) => x.symbol === s) && IDMAP[s]?.coincap);
    if (missing.length) {
      const ids = missing.map((s) => IDMAP[s].coincap);
      const cc = await coincapAssets(ids);
      list = list.concat(cc.filter((x) => symbols.includes(x.symbol)));
    }

    // Guarantee order + shape
    const normalized = symbols.map(
      (s) =>
        list.find((x) => x.symbol === s) || {
          symbol: s,
          priceUsd: null,
          change24hPct: null,
          marketCapUsd: null,
          volume24hUsd: null,
          provider: null,
        }
    );

    const out = { symbols, data: normalized, updatedAt: new Date().toISOString() };
    setCache(key, out, 20);
    res.json(out);
  } catch (err) {
    next(err);
  }
}

// GET /api/crypto/chart?symbol=BTC&interval=auto&range=2w
export async function getChart(req, res, next) {
  try {
    const symbol = norm(req.query.symbol || "BTC");
    const rawInterval = String(req.query.interval || "auto"); // 👈 default to auto
    const rawRange = String(req.query.range || "30d");        // now accepts 2w, 1m, etc.

    const ids = IDMAP[symbol];
    if (!ids) return res.status(400).json({ error: `Unsupported symbol: ${symbol}` });

    const now = Date.now();
    const days = parseRangeToDays(rawRange);                  // 👈 new parser supports d/w/m/y
    const startMs = now - days * 24 * 60 * 60 * 1000;

    // 👇 compute interval if "auto"
    const interval = rawInterval === "auto" ? pickIntervalAuto(days) : rawInterval;

    const key = `chart:${symbol}:${interval}:${days}d`;
    const hit = getCache(key);
    if (hit) return res.json(hit);

    let candles = [];
    let provider = null;

    // 1) Try CoinCap candles (preferred OHLC)
    if (!process.env.DISABLE_COINCAP) {
      try {
        candles = await coincapCandles({ baseId: ids.coincap, interval, startMs, endMs: now });
        provider = "coincap";
      } catch {
        // continue
      }
    }

    // 2) Fallback: CoinCap history (close-only -> o=h=l=c)
    if (!candles || candles.length === 0) {
      try {
        candles = await coincapHistory({ baseId: ids.coincap, interval, startMs, endMs: now });
        provider = "coincap-history";
      } catch {
        // continue
      }
    }

    // 3) Final fallback: Coinbase Exchange candles
    if ((!candles || candles.length === 0) && ids.coinbase) {
      try {
        candles = await coinbaseCandles({
          productId: ids.coinbase,
          interval,
          startMs,
          endMs: now,
        });
        provider = "coinbase";
      } catch (e) {
        return res
          .status(502)
          .json({ error: "All providers unavailable for chart data", detail: e.message });
      }
    }

    if (!candles || candles.length === 0) {
      return res.status(502).json({ error: "All providers unavailable for chart data" });
    }

    const out = {
      symbol,
      interval,                      // actual interval used (might be auto-derived)
      range: rawRange,               // echo back input like "2w", "1m"
      days,                          // and the resolved day count
      candles,
      provider,
      updatedAt: new Date().toISOString(),
    };
    setCache(key, out, 600); // 10m cache
    res.json(out);
  } catch (err) {
    next(err);
  }
}

