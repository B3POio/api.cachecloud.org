// controllers/portfolio.eth.data.controller.js
// Ethereum portfolio controller using Etherscan **V2**.
// Exposes two handlers:
//   - getPortfolioSummary -> { totals, wallets: [...] }  (wei fields as strings)
//   - getPortfolioChart   -> { chain: "eth", range, points: [{t,flow,cum}], note } (wei strings)
//
// ENV (backend):
//   ETHERSCAN_API_KEY        (required)
//   ETHERSCAN_API_BASE       (optional, default: https://api.etherscan.io/v2/api)
//   ETHERSCAN_CHAIN_ID       (optional, default: 1 for mainnet)

import admin from "firebase-admin";

const db = admin.firestore();

// ====== Config (Etherscan V2) ======
const ETHERSCAN_BASE  = process.env.ETHERSCAN_API_BASE || "https://api.etherscan.io/v2/api";
const ETHERSCAN_KEY   = process.env.ETHERSCAN_API_KEY || "";
const ETHERSCAN_CHAIN = Number(process.env.ETHERSCAN_CHAIN_ID || 1); // 1 = mainnet

// ====== Generic helpers ======
function getUserIdFromReq(req) {
  // Try common placements from different auth middlewares
  return (
    req.user?.sub ||               // OIDC "sub"
    req.user?.uid ||
    req.user?.id ||
    req.auth?.uid ||
    req.auth?.userId ||
    req.token?.uid ||
    req.session?.user?.uid ||
    req.session?.user?.id ||
    null
  );
}

function assertAddress(addr) {
  if (!addr) {
    const e = new Error("No Ethereum address on file for this user.");
    e.status = 404; throw e;
  }
  if (typeof addr !== "string" || !addr.startsWith("0x") || addr.length !== 42) {
    const e = new Error("Invalid Ethereum address format.");
    e.status = 400; throw e;
  }
}

function toDayUTC(tsSec) {
  const d = new Date(tsSec * 1000);
  const Y = d.getUTCFullYear();
  const M = String(d.getUTCMonth() + 1).padStart(2, "0");
  const D = String(d.getUTCDate()).padStart(2, "0");
  return `${Y}-${M}-${D}`;
}

function dateDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function rangeToDays(range) {
  switch ((range || "30d").toLowerCase()) {
    case "30d": return 30;
    case "90d": return 90;
    case "1y":  return 365;
    default:    return 30;
  }
}

function sumBigInt(arr) {
  return arr.reduce((acc, v) => acc + v, 0n);
}

function toWeiBI(valueStr) {
  if (!valueStr) return 0n;
  try { return BigInt(valueStr); } catch { return 0n; }
}

function asTimestampMs(v) {
  if (!v) return 0;
  if (typeof v.toMillis === "function") return v.toMillis(); // Firestore Timestamp
  if (typeof v === "object" && typeof v.seconds === "number") return v.seconds * 1000;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function pickLatestAddressFromArray(arr) {
  // arr: [{ address, createdAtMs?, createdAt? }, ...]
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const withScore = arr
    .map((it) => {
      const addr = (it?.address || "").trim();
      const score = Number(it?.createdAtMs) || asTimestampMs(it?.createdAt) || 0;
      return { addr, score };
    })
    .filter((x) => typeof x.addr === "string" && x.addr.length > 0);

  if (withScore.length === 0) return null;
  withScore.sort((a, b) => b.score - a.score);
  return withScore[0].addr;
}

function extractAddressFromUnknownShape(node) {
  // Accept object {address} or array of {address}
  if (!node) return null;
  if (Array.isArray(node)) return pickLatestAddressFromArray(node);
  if (typeof node === "object") {
    if (typeof node.address === "string" && node.address) return node.address.trim();
    // Shallow scan nested objects in case of custom nesting
    for (const v of Object.values(node)) {
      if (v && typeof v === "object") {
        const found = extractAddressFromUnknownShape(v);
        if (found) return found;
      }
    }
  }
  return null;
}

// 🔁 Convert any BigInt anywhere in the payload to a decimal string
function toJSONSafe(x) {
  if (typeof x === "bigint") return x.toString(10);
  if (Array.isArray(x)) return x.map(toJSONSafe);
  if (x && typeof x === "object") {
    const out = {};
    for (const [k, v] of Object.entries(x)) out[k] = toJSONSafe(v);
    return out;
  }
  return x;
}

// ====== Firestore lookup ======
async function getEthAddressForUser(uid) {
  if (!uid) return null;
  const doc = await db.collection("users").doc(uid).get();
  const data = doc.exists ? doc.data() : null;
  if (!data) return null;

  // Try arrays OR objects in several common places
  const candidates = [
    data?.portfolio?.ethereum, // array or object
    data?.portfolio?.eth,      // array or object
    data?.ethereum,            // array or object (your current doc shape)
  ];

  for (const node of candidates) {
    const addr = extractAddressFromUnknownShape(node);
    if (addr) return addr.trim();
  }

  console.warn(
    "[ETH lookup] No address found for uid:",
    uid,
    "Known keys missing: portfolio.ethereum.address / portfolio.eth.address / ethereum.address (array or object)"
  );
  return null;
}

// ====== Etherscan V2 fetching ======
async function etherscanFetch(params) {
  if (!ETHERSCAN_KEY) {
    const e = new Error("ETHERSCAN_API_KEY is not set");
    e.status = 500; // internal config issue
    throw e;
  }

  const url = new URL(ETHERSCAN_BASE);
  // V2 requires chainid
  url.searchParams.set("chainid", String(ETHERSCAN_CHAIN));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set("apikey", ETHERSCAN_KEY);

  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    const e = new Error(`Etherscan HTTP ${res.status}`);
    e.status = 502;
    throw e;
  }

  const json = await res.json();

  // Normalize common cases
  const status = String(json?.status ?? "");
  const message = String(json?.message ?? "");
  const result = json?.result;

  // Success path
  if (status === "1") return result;

  // Soft "no data" → treat as empty OK
  if (status === "0" && /no transactions found/i.test(message)) {
    return Array.isArray(result) ? result : [];
  }

  // Map NOTOK messages to better HTTP codes
  const msg = String(result || message || "NOTOK");
  const err = new Error(`Etherscan error: ${msg}`);
  if (/invalid api key/i.test(msg)) { err.status = 401; throw err; }
  if (/max rate limit/i.test(msg))  { err.status = 429; throw err; }
  if (/invalid address/i.test(msg)) { err.status = 400; throw err; }

  err.status = 502; throw err;
}

async function getNormalTxs(address, startBlock = 0, endBlock = 99999999) {
  return etherscanFetch({
    module: "account",
    action: "txlist",
    address,
    startblock: startBlock,
    endblock: endBlock,
    sort: "asc",
  });
}

async function getInternalTxs(address, startBlock = 0, endBlock = 99999999) {
  return etherscanFetch({
    module: "account",
    action: "txlistinternal",
    address,
    startblock: startBlock,
    endblock: endBlock,
    sort: "asc",
  });
}

// ====== Core stats ======
async function getEthCoreStats(address) {
  assertAddress(address);
  // Current balance (wei)
  const balanceRes = await etherscanFetch({
    module: "account",
    action: "balance",
    address,
    tag: "latest",
  });
  const balance = BigInt(balanceRes || "0");

  // Walk transfers (normal + internal) to compute totals and counts
  const [normal, internal] = await Promise.all([ getNormalTxs(address), getInternalTxs(address) ]);

  const incoming = [];
  const outgoing = [];
  const txHashesFrom = new Set();
  const txHashesTo   = new Set();
  const addrLc = address.toLowerCase();

  for (const tx of normal) {
    const val = toWeiBI(tx.value);
    if (tx.to?.toLowerCase() === addrLc) {
      incoming.push(val);
      txHashesTo.add(tx.hash);
    }
    if (tx.from?.toLowerCase() === addrLc) {
      // Outgoing includes value + gas
      const gasUsed  = BigInt(tx.gasUsed || 0);
      const gasPrice = BigInt(tx.gasPrice || 0);
      outgoing.push(val + gasUsed * gasPrice);
      txHashesFrom.add(tx.hash);
    }
  }

  for (const itx of internal) {
    const val = toWeiBI(itx.value);
    if (itx.to?.toLowerCase() === addrLc) incoming.push(val);
    if (itx.from?.toLowerCase() === addrLc) outgoing.push(val);
  }

  const totalReceived = sumBigInt(incoming);
  const totalSent     = sumBigInt(outgoing);
  const txCount       = new Set([...txHashesFrom, ...txHashesTo]).size;

  return {
    address,
    totalReceived, // bigint
    totalSent,     // bigint (normal txs include gas paid)
    balance,       // bigint
    pendingDelta: 0n, // bigint
    txCount,          // number
  };
}

// ====== Time series (daily UTC) ======
function buildDailyZeros(fromDateUTC) {
  const start = new Date(fromDateUTC);
  start.setUTCHours(0, 0, 0, 0);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const days = Math.floor((today - start) / (24 * 3600 * 1000)) + 1;
  const map = new Map();
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 24 * 3600 * 1000);
    const Y = d.getUTCFullYear();
    const M = String(d.getUTCMonth() + 1).padStart(2, "0");
    const D = String(d.getUTCDate()).padStart(2, "0");
    map.set(`${Y}-${M}-${D}`, 0n);
  }
  return map;
}

async function getEthTimeSeries(address, days) {
  assertAddress(address);
  const sinceDate = dateDaysAgo(days);
  const sinceUnix = Math.floor(sinceDate.getTime() / 1000);
  const [normal, internal] = await Promise.all([ getNormalTxs(address), getInternalTxs(address) ]);

  const buckets = buildDailyZeros(sinceDate);
  const addrLc = address.toLowerCase();

  // Normal txs
  for (const tx of normal) {
    const ts = Number(tx.timeStamp || 0);
    if (!Number.isFinite(ts) || ts < sinceUnix) continue;
    const day = toDayUTC(ts);
    const val = toWeiBI(tx.value);

    if (tx.to?.toLowerCase() === addrLc) {
      buckets.set(day, buckets.get(day) + val);
    }
    if (tx.from?.toLowerCase() === addrLc) {
      const gasUsed  = BigInt(tx.gasUsed || 0);
      const gasPrice = BigInt(tx.gasPrice || 0);
      buckets.set(day, buckets.get(day) - (val + gasUsed * gasPrice));
    }
  }

  // Internal txs
  for (const itx of internal) {
    const ts = Number(itx.timeStamp || 0);
    if (!Number.isFinite(ts) || ts < sinceUnix) continue;
    const day = toDayUTC(ts);
    const val = toWeiBI(itx.value);

    if (itx.to?.toLowerCase() === addrLc) {
      buckets.set(day, buckets.get(day) + val);
    }
    if (itx.from?.toLowerCase() === addrLc) {
      buckets.set(day, buckets.get(day) - val);
    }
  }

  const points = [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([t, flow]) => ({ t, flow, /* cum to be added below */ }));

  let cum = 0n;
  const withCum = points.map(p => {
    cum += p.flow;
    return { t: p.t, flow: p.flow, cum };
  });

  return withCum;
}

// getPortfolioSummary
export async function getPortfolioSummary(req, res, next) {
  try {
    const { chain, address: qpAddress } = req.query;

    if (chain && String(chain).toLowerCase() !== "eth") {
      const e = new Error("Unsupported chain; this controller only handles 'eth'.");
      e.status = 400;
      throw e;
    }

    let address = (qpAddress || "").trim();
    if (!address) {
      const uid = getUserIdFromReq(req);
      address = await getEthAddressForUser(uid);
    }

    // If no address on file, return empty payload (200) and let the frontend handle UX.
    if (!address) {
      const empty = {
        totals: {
          balance:       0n,
          totalReceived: 0n,
          totalSent:     0n,
          pendingDelta:  0n,
        },
        wallets: [],
      };
      return res.json(toJSONSafe(empty)); // ensure BigInt-safe JSON
    }

    // Validate if an address was provided/found
    assertAddress(address);

    const stats = await getEthCoreStats(address);

    // Align with BTC UI contract
    const payload = {
      totals: {
        balance:       stats.balance,
        totalReceived: stats.totalReceived,
        totalSent:     stats.totalSent,
        pendingDelta:  stats.pendingDelta,
      },
      wallets: [
        {
          address:       stats.address,
          balance:       stats.balance,
          totalReceived: stats.totalReceived,
          totalSent:     stats.totalSent,
          pendingDelta:  stats.pendingDelta,
          txCount:       stats.txCount,
        },
      ],
    };

    return res.json(toJSONSafe(payload)); // BigInt-safe
  } catch (err) {
    next(err);
  }
}


// getPortfolioChart
export async function getPortfolioChart(req, res, next) {
  try {
    const { chain, range = "30d", address: qpAddress } = req.query;

    if (chain && String(chain).toLowerCase() !== "eth") {
      const e = new Error("Unsupported chain; this controller only handles 'eth'.");
      e.status = 400;
      throw e;
    }

    let address = (qpAddress || "").trim();
    if (!address) {
      const uid = getUserIdFromReq(req);
      address = await getEthAddressForUser(uid);
    }

    // No address on file → empty series, 200 OK
    if (!address) {
      return res.json({
        chain: "eth",
        range,
        points: [],
        note: "No Ethereum address on file; returning empty time series.",
      });
    }

    // Validate if an address was provided/found
    assertAddress(address);

    const days = rangeToDays(range);
    const points = await getEthTimeSeries(address, days);

    return res.json(
      toJSONSafe({
        chain: "eth",
        range,
        points, // bigint fields (if any) → strings via toJSONSafe
        note: "Values in wei. Chart shows confirmed history only (no mempool).",
      })
    );
  } catch (err) {
    next(err);
  }
}
