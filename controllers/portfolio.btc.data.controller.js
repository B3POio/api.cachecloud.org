// controllers/portfolio.data.controller.js
import admin from "firebase-admin";

const db = admin.firestore();

const MEMPOOL_BASE = process.env.ENTERPRISE_MEMPOOL_API_BASE || "https://enterprise.blockstream.info/api";
const CLIENT_ID = process.env.BLOCKSTREAM_CLIENT_ID;
const CLIENT_SECRET = process.env.BLOCKSTREAM_CLIENT_SECRET;

// Reuse the same shape your other controller supports
function getUserIdFromReq(req) {
  return (
    req.user?.id ||
    req.user?.uid ||
    req.auth?.userId ||
    req.session?.user?.id ||
    null
  );
}

// --- helpers (top of file) ---
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}


// ---- Add near top (with your other helpers) ----
let blockstreamTokenCache = { token: null, expiry: 0 };

async function getBlockstreamToken() {
  const now = Date.now();
  if (blockstreamTokenCache.token && now < blockstreamTokenCache.expiry) {
    return blockstreamTokenCache.token;
  }

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Missing BLOCKSTREAM_CLIENT_ID or BLOCKSTREAM_SECRET_ID");
  }

  const tokenUrl = process.env.BLOCKSTREAM_ENTERPRISE_LOGIN_URL;

  // Attempt A: credentials in body (common)
  const bodyA = new URLSearchParams();
  bodyA.set("client_id", CLIENT_ID);
  bodyA.set("client_secret", CLIENT_SECRET);
  bodyA.set("grant_type", "client_credentials");
  // scope often optional; add if your client requires it:
  // bodyA.set("scope", "openid");

  let res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: bodyA,
  });

  if (!res.ok) {
    const text = await res.text();
    const needsBasic =
      res.status === 401 &&
      /invalid_client|unauthorized_client/i.test(text);

    if (!needsBasic) {
      throw new Error(`Blockstream login failed: ${res.status} ${text}`);
    }

    // Attempt B: client secret via Basic header
    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
    const bodyB = new URLSearchParams();
    bodyB.set("grant_type", "client_credentials");
    // bodyB.set("scope", "openid");

    res = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic}`,
      },
      body: bodyB,
    });

    if (!res.ok) {
      const t2 = await res.text();
      throw new Error(`Blockstream login failed (basic): ${res.status} ${t2}`);
    }
  }

  const data = await res.json();
  const token = data.access_token;
  const expiresIn = Number(data.expires_in || 3600);
  if (!token) throw new Error("Blockstream login succeeded with no access_token");

  // refresh a little early
  blockstreamTokenCache = { token, expiry: Date.now() + expiresIn * 1000 - 30_000 };
  return token;
}

// Replace your existing fetchJson with this (keeps your retries/backoff)
async function fetchJson(url, tries = 6) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const token = await getBlockstreamToken();
      const res = await fetch(url, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
      });

      if (res.ok) {
        // Some endpoints (e.g., /blocks/tip/hash) are text/plain
        const ctype = res.headers.get("content-type") || "";
        if (ctype.includes("application/json")) return await res.json();
        return await res.text();
      }

      if (res.status === 401) {
        // token expired or audience mismatch → clear and retry
        blockstreamTokenCache.token = null;
        continue;
      }

      if (res.status === 429) {
        const ra = res.headers.get("retry-after");
        const waitMs = ra
          ? Math.max(0, Number(ra)) * 1000
          : Math.min(30_000, 400 * 2 ** attempt) + Math.floor(Math.random() * 250);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      if (res.status >= 500 && res.status < 600) {
        const waitMs = Math.min(20_000, 300 * 2 ** attempt) + Math.floor(Math.random() * 150);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    } catch (e) {
      lastErr = e;
      const waitMs = Math.min(20_000, 300 * 2 ** attempt) + Math.floor(Math.random() * 150);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}




/**
 * Pull minimal BTC address stats from Esplora/Mempool:
 *  GET /address/:addr  -> { chain_stats: { funded_txo_sum, spent_txo_sum, tx_count }, mempool_stats: {...} }
 */
async function getBtcAddressCoreStats(address) {
  const data = await fetchJson(`${MEMPOOL_BASE}/address/${address}`);
  const funded = Number(data?.chain_stats?.funded_txo_sum || 0);
  const spent  = Number(data?.chain_stats?.spent_txo_sum  || 0);
  const pendingFunded = Number(data?.mempool_stats?.funded_txo_sum || 0);
  const pendingSpent  = Number(data?.mempool_stats?.spent_txo_sum  || 0);

  const totalReceived = funded;
  const totalSent     = spent;
  const confirmedBalance = funded - spent;

  const mempoolDelta = pendingFunded - pendingSpent;
  const balanceIncludingMempool = confirmedBalance + mempoolDelta;

  return {
    address,
    totalReceived,    // sats
    totalSent,        // sats
    balance: confirmedBalance, // sats
    pendingDelta: mempoolDelta, // sats
    txCount: Number(data?.chain_stats?.tx_count || 0)
  };
}

/**
 * Build a daily time-series (UTC) for an address by walking recent txs.
 * - Uses a tiny inter-page delay to avoid tripping public rate limits.
 * - Auto-tunes page depth based on how far back `sinceUnix` is.
 */
async function getBtcAddressTimeSeries(address, sinceUnix, pageLimit = 8) {
  const day = 86400;
  const now = Math.floor(Date.now() / 1000);

  // Heuristic page depth for long lookbacks; caller can still raise pageLimit explicitly.
  const years = Math.max(0, (now - Number(sinceUnix || 0)) / (365 * day));
  const heuristicLimit =
    years >= 8 ? 200 :
    years >= 5 ? 120 :
    years >= 3 ?  80 :
    years >= 2 ?  50 :
    years >= 1 ?  24 : 8;

  const effectiveLimit = Math.max(pageLimit, heuristicLimit);

  let url = `${MEMPOOL_BASE}/address/${address}/txs`;
  const txs = [];
  const seen = new Set();
  let pages = 0;

  while (pages < effectiveLimit) {
    // small throttle between pages (125–300ms jitter) to reduce 429s
    if (pages > 0) await sleep(125 + Math.floor(Math.random() * 175));

    const page = await fetchJson(url);
    if (!Array.isArray(page) || page.length === 0) break;

    for (const t of page) {
      const id = t?.txid;
      if (id && !seen.has(id)) {
        seen.add(id);
        txs.push(t);
      }
    }

    pages++;
    const last = page[page.length - 1];
    const lastId = last?.txid;
    if (!lastId) break;

    // If the oldest tx on this page is well before the window, stop paginating
    const minTime = Math.min(
      ...page.map(t => Number(t?.status?.block_time ?? Number.MAX_SAFE_INTEGER))
    );
    if (minTime !== Number.MAX_SAFE_INTEGER && minTime < (sinceUnix - day)) break;

    url = `${MEMPOOL_BASE}/address/${address}/txs/chain/${lastId}`;
  }

  // Per-tx delta for this address (confirmed only)
  function isToMe(vout) {
    return vout?.scriptpubkey_address === address;
  }
  function isFromMe(vin) {
    return vin?.prevout?.scriptpubkey_address === address;
  }

  const txsWithDelta = txs
    .filter(t => t?.status?.confirmed)
    .map(t => {
      const time = Number(t?.status?.block_time || 0);
      const received = (t?.vout || []).reduce((s, v) => s + (isToMe(v) ? Number(v?.value || 0) : 0), 0);
      const sent     = (t?.vin  || []).reduce((s, v) => s + (isFromMe(v) ? Number(v?.prevout?.value || 0) : 0), 0);
      const delta = received - sent; // sats
      return { time, delta };
    })
    .filter(x => x.time >= sinceUnix)
    .sort((a, b) => a.time - b.time);

  // Collapse into daily buckets (UTC)
  const dailyMap = new Map();
  for (const { time, delta } of txsWithDelta) {
    const dayStart = Math.floor(time / day) * day; // unix midnight UTC
    dailyMap.set(dayStart, (dailyMap.get(dayStart) || 0) + delta);
  }

  return Array.from(dailyMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([t, flow]) => ({ t, flow })); // sats
}



/**
 * GET /api/portfolio/summary?chain=btc
 * Aggregates per-address stats for the authenticated user’s saved wallets.
 */
export async function getPortfolioSummary(req, res, next) {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId) return res.status(401).json({ error: "Unauthenticated" });

    const chainRaw = (req.query.chain || "btc").toString().toLowerCase();
    if (!["btc"].includes(chainRaw)) {
      return res.status(400).json({ error: "Only 'btc' supported for now" });
    }

    // read saved wallets from user doc
    const snap = await db.collection("users").doc(userId).get();
    const data = snap.exists ? snap.data() : {};
    const portfolio = data?.portfolio || {};
    const btcWallets = Array.isArray(portfolio.bitcoin) ? portfolio.bitcoin : [];

    if (btcWallets.length === 0) {
      return res.json({
        chain: "btc",
        totals: { balance: 0, totalReceived: 0, totalSent: 0, pendingDelta: 0 },
        wallets: []
      });
    }

    // parallel fetch
    const stats = await Promise.all(
      btcWallets.map(w => getBtcAddressCoreStats(w.address))
    );

    const totals = stats.reduce((acc, s) => {
      acc.balance       += s.balance;
      acc.totalReceived += s.totalReceived;
      acc.totalSent     += s.totalSent;
      acc.pendingDelta  += s.pendingDelta;
      return acc;
    }, { balance: 0, totalReceived: 0, totalSent: 0, pendingDelta: 0 });

    return res.json({
      chain: "btc",
      totals, // sats
      wallets: stats // per-wallet breakdown
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/portfolio/chart?chain=btc&range=30d|90d|1y
 * Returns a daily time-series aggregated across all saved wallets.
 * Output: { range, points: [{t, flow, cum}], note }
 *  - t: unix UTC midnight
 *  - flow: net change that day across wallets (sats)
 *  - cum: cumulative balance change from start (sats)
 */
export async function getPortfolioChart(req, res, next) {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId) return res.status(401).json({ error: "Unauthenticated" });

    const chainRaw = (req.query.chain || "btc").toString().toLowerCase();
    if (!["btc"].includes(chainRaw)) {
      return res.status(400).json({ error: "Only 'btc' supported for now" });
    }

    const range = (req.query.range || "30d").toString().toLowerCase();
    const now = Math.floor(Date.now() / 1000);
    const day = 86400;

    const lookbackDays =
  range === "90d"  ? 90 :
  range === "1y"   ? 365 :
  range === "2y"   ? 365 * 2 :
  range === "3y"   ? 365 * 3 :
  range === "5y"   ? 365 * 5 :
  range === "10y"  ? 365 * 10 :
  30;

    const since = now - lookbackDays * day;

    // read saved wallets
    const snap = await db.collection("users").doc(userId).get();
    const data = snap.exists ? snap.data() : {};
    const portfolio = data?.portfolio || {};
    const btcWallets = Array.isArray(portfolio.bitcoin) ? portfolio.bitcoin : [];

    if (btcWallets.length === 0) {
      return res.json({ chain: "btc", range, points: [], note: "No wallets saved" });
    }

    // fetch per-wallet daily flow series, then aggregate
    const perWalletSeries = await Promise.all(
      btcWallets.map(w => getBtcAddressTimeSeries(w.address, since))
    );

    // Aggregate daily flows across all wallets
    const dailyMap = new Map();
    for (const s of perWalletSeries) {
      for (const pt of s) {
        dailyMap.set(pt.t, (dailyMap.get(pt.t) || 0) + pt.flow);
      }
    }

    // Fill missing days with 0 flow so charts look continuous
    const points = [];
    for (let t = Math.floor(since / day) * day; t <= Math.floor(now / day) * day; t += day) {
      const flow = dailyMap.get(t) || 0;
      points.push({ t, flow });
    }

    // compute cumulative from start
    let cum = 0;
    const withCum = points.map(p => ({ ...p, cum: (cum += p.flow) }));

    return res.json({
      chain: "btc",
      range,
      points: withCum,
      note: "Values in satoshis. Chart shows confirmed history only (no mempool)."
    });
  } catch (err) {
    next(err);
  }
}
