// controllers/portfolio.data.controller.js
import admin from "firebase-admin";

const db = admin.firestore();
const MEMPOOL_BASE = process.env.MEMPOOL_API_BASE || "https://blockstream.info/api";

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

// ----------- tiny fetch helper with basic retry -----------
async function fetchJson(url, tries = 2) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "accept": "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      err = e;
      await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw err;
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
 * NOTE: This computes net flow for the address per tx: (sum of outputs to addr) - (sum of inputs from addr)
 * and maintains a running balance. We only scan back to the requested start date (or a safety page limit).
 */
async function getBtcAddressTimeSeries(address, sinceUnix, pageLimit = 8) {
  // Esplora: /address/:addr/txs returns latest 25 txs; paginate with /txs/chain?last_txid=<id>
  let url = `${MEMPOOL_BASE}/address/${address}/txs`;
  let txs = [];
  let pages = 0;

  // pull pages until either txs fall all before 'sinceUnix' or we hit page limit
  while (pages < pageLimit) {
    const page = await fetchJson(url);
    if (!Array.isArray(page) || page.length === 0) break;
    txs.push(...page);
    pages++;
    const last = page[page.length - 1];
    const lastId = last?.txid;
    if (!lastId) break;
    // stop if oldest page is older than sinceUnix significantly
    const minTime = Math.min(...page.map(t => (t?.status?.block_time || Number.MAX_SAFE_INTEGER)));
    if (minTime !== Number.MAX_SAFE_INTEGER && minTime < sinceUnix - 86400) break;
    url = `${MEMPOOL_BASE}/address/${address}/txs/chain/${lastId}`;
  }

  // Compute per-tx delta for this address
  // delta = sum(vout to address) - sum(vin from address)
  function isToMe(vout) {
    return vout?.scriptpubkey_address === address;
  }
  function isFromMe(vin) {
    return vin?.prevout?.scriptpubkey_address === address;
  }

  const txsWithDelta = txs
    .filter(t => t?.status?.confirmed) // chart uses confirmed history
    .map(t => {
      const time = Number(t?.status?.block_time || 0);
      const received = (t?.vout || []).reduce((s, v) => s + (isToMe(v) ? Number(v?.value || 0) : 0), 0);
      const sent     = (t?.vin  || []).reduce((s, v) => s + (isFromMe(v) ? Number(v?.prevout?.value || 0) : 0), 0);
      const delta = received - sent; // sats
      return { time, delta };
    })
    .filter(x => x.time >= sinceUnix)
    .sort((a,b) => a.time - b.time);

  // Collapse into daily buckets (UTC)
  const day = 86400;
  const dailyMap = new Map();
  for (const { time, delta } of txsWithDelta) {
    const dayStart = Math.floor(time / day) * day; // unix midnight UTC
    dailyMap.set(dayStart, (dailyMap.get(dayStart) || 0) + delta);
  }

  // Turn map -> sorted array of {t, flow}
  const series = Array.from(dailyMap.entries())
    .sort((a,b) => a[0] - b[0])
    .map(([t, flow]) => ({ t, flow })); // flow = net change that day (sats)

  return series;
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

    const lookbackDays = range === "90d" ? 90 : range === "1y" ? 365 : 30;
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
