// controllers/user.portfolio.controller.js
import admin from "firebase-admin";
const db = admin.firestore();
import { randomUUID } from "crypto";

const ALLOWED_METALS = new Set(["gold", "silver"]);
const ALLOWED_UNITS = new Set(["g", "oz", "lb"]);

function normalizeMetalKey(input) {
  const key = String(input || "").trim().toLowerCase();
  if (!ALLOWED_METALS.has(key)) return null;
  return key; // 'gold' | 'silver'
}

function normalizeUnit(input) {
  const u = String(input || "").trim().toLowerCase();
  if (!ALLOWED_UNITS.has(u)) return null;
  return u; // 'g' | 'oz' | 'lb'
}

// Put this near normalizeMetalKey / normalizeUnit
function normalizeName(input) {
  const name = String(input ?? "").trim().replace(/\s+/g, " ");
  if (!name || name.length > 80) return null;
  return name;
}


// Crypto wallets

// Adjust this to your auth middleware shape
function getUserIdFromReq(req) {
  return (
    req.user?.id ||
    req.user?.uid ||
    req.auth?.userId ||
    req.session?.user?.id ||
    null
  );
}

/**
 * POST /api/user/wallets
 * Body: { chain: 'btc'|'eth', address: string }
 * Creates portfolio.{bitcoin|ethereum} if missing and appends the wallet.
 */
export async function saveUserWallet(req, res, next) {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId) return res.status(401).json({ error: "Unauthenticated" });

    const chainRaw = String(req.body.chain || "").trim().toLowerCase();
    const address = String(req.body.address || "").trim();
    if (!["btc", "eth"].includes(chainRaw)) {
      return res.status(400).json({ error: "chain must be 'btc' or 'eth'" });
    }
    if (!address) return res.status(400).json({ error: "address is required" });

    // Minimal validation (tighten later)
    if (chainRaw === "eth" && !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return res.status(400).json({ error: "Invalid Ethereum address" });
    }
    if (chainRaw === "btc" && address.length < 26) {
      return res.status(400).json({ error: "Invalid Bitcoin address" });
    }

    const chainKey = chainRaw === "btc" ? "bitcoin" : "ethereum";
    const now = admin.firestore.Timestamp.now(); // ✅ allowed inside arrays
    const nowMs = Date.now();

    const userRef = db.collection("users").doc(userId);

    // Use a transaction to read/modify the array (no FieldValue sentinels in arrays)
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const data = snap.exists ? snap.data() : {};
      const portfolio = data?.portfolio || {};
      const existing = Array.isArray(portfolio[chainKey]) ? portfolio[chainKey] : [];

      const already = existing.some(
        (w) => (w?.address || "").toLowerCase() === address.toLowerCase()
      );
      if (already) {
        // No-op if the address already exists
        return { bitcoin: portfolio.bitcoin || [], ethereum: portfolio.ethereum || [] };
      }

      const wallet = { address, createdAt: now, createdAtMs: nowMs };
      const updated = [wallet, ...existing];

      // merge: true ensures we keep other portfolio fields
      tx.set(
        userRef,
        { portfolio: { [chainKey]: updated } },
        { merge: true }
      );

      return {
        bitcoin: chainKey === "bitcoin" ? updated : (portfolio.bitcoin || []),
        ethereum: chainKey === "ethereum" ? updated : (portfolio.ethereum || []),
      };
    });

    return res.status(201).json({
      ok: true,
      chain: chainKey,
      bitcoin: result.bitcoin || [],
      ethereum: result.ethereum || [],
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/user/wallets?chain=btc|eth (optional)
 * Returns arrays under portfolio.bitcoin / portfolio.ethereum (creates none).
 */
export async function getUserWallets(req, res, next) {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId) return res.status(401).json({ error: "Unauthenticated" });

    const chainRaw = req.query.chain ? String(req.query.chain).trim().toLowerCase() : null;
    if (chainRaw && !["btc", "eth"].includes(chainRaw)) {
      return res.status(400).json({ error: "chain must be 'btc' or 'eth' if provided" });
    }

    const snap = await db.collection("users").doc(userId).get();
    const data = snap.exists ? snap.data() : {};
    const portfolio = data?.portfolio || {};
    const bitcoin = Array.isArray(portfolio.bitcoin) ? portfolio.bitcoin : [];
    const ethereum = Array.isArray(portfolio.ethereum) ? portfolio.ethereum : [];

    if (chainRaw === "btc") return res.json({ bitcoin });
    if (chainRaw === "eth") return res.json({ ethereum });
    return res.json({ bitcoin, ethereum });
  } catch (err) {
    next(err);
  }
}


export async function deleteUserWallet(req, res, next) {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId) return res.status(401).json({ error: "Unauthenticated" });

    const chainRaw = (req.query.chain || req.body?.chain || "").toString().toLowerCase();
    const address = (req.query.address || req.body?.address || "").toString().trim();
    if (!["btc", "eth"].includes(chainRaw)) {
      return res.status(400).json({ error: "chain must be 'btc' or 'eth'" });
    }
    if (!address) return res.status(400).json({ error: "address is required" });

    const chainKey = chainRaw === "btc" ? "bitcoin" : "ethereum";
    const userRef = db.collection("users").doc(userId);

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const data = snap.exists ? snap.data() : {};
      const portfolio = data?.portfolio || {};
      const arr = Array.isArray(portfolio[chainKey]) ? portfolio[chainKey] : [];

      const nextArr = arr.filter(
        (w) => (w?.address || "").toLowerCase() !== address.toLowerCase()
      );

      // If nothing changed, return as-is
      if (nextArr.length === arr.length) {
        return { removed: 0, bitcoin: portfolio.bitcoin || [], ethereum: portfolio.ethereum || [] };
      }

      tx.set(userRef, { portfolio: { [chainKey]: nextArr } }, { merge: true });

      return {
        removed: arr.length - nextArr.length,
        bitcoin: chainKey === "bitcoin" ? nextArr : (portfolio.bitcoin || []),
        ethereum: chainKey === "ethereum" ? nextArr : (portfolio.ethereum || []),
      };
    });

    return res.json({ ok: true, removed: result.removed, bitcoin: result.bitcoin, ethereum: result.ethereum });
  } catch (err) {
    next(err);
  }
}

// PUT /api/user/wallets
// Body (or query): { chain:'btc'|'eth', oldAddress:string, newAddress:string }
export async function updateUserWallet(req, res, next) {
  try {
    const userId =
      req.user?.id || req.user?.uid || req.auth?.userId || req.session?.user?.id || null;
    if (!userId) return res.status(401).json({ error: "Unauthenticated" });

    const chainRaw = (req.body?.chain || req.query.chain || "").toString().toLowerCase();
    const oldAddress = (req.body?.oldAddress || req.query.oldAddress || "").toString().trim();
    const newAddress = (req.body?.newAddress || req.query.newAddress || "").toString().trim();

    if (!["btc", "eth"].includes(chainRaw)) {
      return res.status(400).json({ error: "chain must be 'btc' or 'eth'" });
    }
    if (!oldAddress || !newAddress) {
      return res.status(400).json({ error: "oldAddress and newAddress are required" });
    }

    // basic validation (same spirit as save)
    if (chainRaw === "eth" && !/^0x[a-fA-F0-9]{40}$/.test(newAddress)) {
      return res.status(400).json({ error: "Invalid Ethereum address" });
    }
    if (chainRaw === "btc" && newAddress.length < 26) {
      return res.status(400).json({ error: "Invalid Bitcoin address" });
    }

    const chainKey = chainRaw === "btc" ? "bitcoin" : "ethereum";
    const userRef = db.collection("users").doc(userId);
    const now = admin.firestore.Timestamp.now();
    const nowMs = Date.now();

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const data = snap.exists ? snap.data() : {};
      const portfolio = data?.portfolio || {};
      const arr = Array.isArray(portfolio[chainKey]) ? portfolio[chainKey] : [];

      const idx = arr.findIndex(
        (w) => (w?.address || "").toLowerCase() === oldAddress.toLowerCase()
      );
      if (idx === -1) {
        return { updated: 0, bitcoin: portfolio.bitcoin || [], ethereum: portfolio.ethereum || [] };
      }

      // prevent duplicate new address within same chain
      const dup = arr.some(
        (w, i) => i !== idx && (w?.address || "").toLowerCase() === newAddress.toLowerCase()
      );
      if (dup) {
        return { conflict: true };
      }

      const current = arr[idx] || {};
      const updatedWallet = {
        ...current,
        address: newAddress,
        updatedAt: now,
        updatedAtMs: nowMs,
      };

      const nextArr = arr.slice();
      nextArr[idx] = updatedWallet;

      tx.set(userRef, { portfolio: { [chainKey]: nextArr } }, { merge: true });

      return {
        updated: 1,
        bitcoin: chainKey === "bitcoin" ? nextArr : (portfolio.bitcoin || []),
        ethereum: chainKey === "ethereum" ? nextArr : (portfolio.ethereum || []),
      };
    });

    if (result?.conflict) {
      return res.status(409).json({ error: "Address already exists" });
    }

    return res.json({
      ok: true,
      updated: result.updated || 0,
      bitcoin: result.bitcoin,
      ethereum: result.ethereum,
    });
  } catch (err) {
    next(err);
  }
}


//Precious metals wallets

// POST /api/user/precious
// Body: { metal: 'gold'|'silver', amount: number, unit: 'g'|'oz'|'lb' }
// Body: { metal:'gold'|'silver', name:string, amount:number, unit:'g'|'oz'|'lb' }
export async function savePreciousHolding(req, res, next) {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId) return res.status(401).json({ error: "Unauthenticated" });

    const metal = normalizeMetalKey(req.body?.metal);
    const unit = normalizeUnit(req.body?.unit);
    const amountRaw = req.body?.amount;
    const name = normalizeName(req.body?.name);

    if (!metal) return res.status(400).json({ error: "metal must be 'gold' or 'silver'" });
    if (!name) return res.status(400).json({ error: "name is required (1–80 chars)" });
    if (!unit) return res.status(400).json({ error: "unit must be 'g', 'oz', or 'lb'" });

    const amount = Number(amountRaw);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "amount must be a positive number" });
    }

    const now = admin.firestore.Timestamp.now();
    const nowMs = Date.now();
    const id = randomUUID();

    const userRef = db.collection("users").doc(userId);

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const data = snap.exists ? snap.data() : {};
      const portfolio = data?.portfolio || {};
      const arr = Array.isArray(portfolio[metal]) ? portfolio[metal] : [];

      // prevent duplicate names (case-insensitive) within same metal
      const existsByName = arr.some(e => (e?.name || "").toLowerCase() === name.toLowerCase());
      if (existsByName) {
        return { conflict: true, gold: portfolio.gold || [], silver: portfolio.silver || [] };
      }

      const entry = { id, name, amount, unit, createdAt: now, createdAtMs: nowMs };
      const updated = [entry, ...arr];

      tx.set(userRef, { portfolio: { [metal]: updated } }, { merge: true });

      return {
        [metal]: updated,
        gold: metal === "gold" ? updated : (portfolio.gold || []),
        silver: metal === "silver" ? updated : (portfolio.silver || []),
      };
    });

    if (result?.conflict) {
      return res.status(409).json({ error: "A wallet with that name already exists for this metal" });
    }

    return res.status(201).json({
      ok: true,
      metal,
      id,
      gold: result.gold || [],
      silver: result.silver || [],
    });
  } catch (err) {
    next(err);
  }
}



// GET /api/user/precious?metal=gold|silver (optional)
// Returns arrays under portfolio.gold / portfolio.silver (creates none).
export async function getPreciousHoldings(req, res, next) {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId) return res.status(401).json({ error: "Unauthenticated" });

    const metalRaw = req.query.metal ? String(req.query.metal).trim().toLowerCase() : null;
    if (metalRaw && !ALLOWED_METALS.has(metalRaw)) {
      return res.status(400).json({ error: "metal must be 'gold' or 'silver' if provided" });
    }

    const snap = await db.collection("users").doc(userId).get();
    const data = snap.exists ? snap.data() : {};
    const portfolio = data?.portfolio || {};
    const gold = Array.isArray(portfolio.gold) ? portfolio.gold : [];
    const silver = Array.isArray(portfolio.silver) ? portfolio.silver : [];

    if (metalRaw === "gold") return res.json({ gold });
    if (metalRaw === "silver") return res.json({ silver });
    return res.json({ gold, silver });
  } catch (err) {
    next(err);
  }
}


// DELETE /api/user/metalswallet?id=<uuid>&metal=gold|silver
export async function deletePreciousHolding(req, res, next) {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId) return res.status(401).json({ error: "Unauthenticated" });

    const metal = normalizeMetalKey(req.query.metal || req.body?.metal);
    const id = String(req.query.id || req.body?.id || "").trim();
    const name = normalizeName(req.query.name || req.body?.name);

    if (!metal) return res.status(400).json({ error: "metal must be 'gold' or 'silver'" });
    if (!id && !name) return res.status(400).json({ error: "Provide id or name" });

    const userRef = db.collection("users").doc(userId);

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const data = snap.exists ? snap.data() : {};
      const portfolio = data?.portfolio || {};
      const arr = Array.isArray(portfolio[metal]) ? portfolio[metal] : [];

      const nextArr = arr.filter((e) => {
        const sameId = id && (e?.id || "") === id;
        const sameName = name && (e?.name || "").toLowerCase() === name.toLowerCase();
        return !(sameId || sameName);
      });

      if (nextArr.length === arr.length) {
        return { removed: 0, gold: portfolio.gold || [], silver: portfolio.silver || [] };
      }

      tx.set(userRef, { portfolio: { [metal]: nextArr } }, { merge: true });

      return {
        removed: arr.length - nextArr.length,
        gold: metal === "gold" ? nextArr : (portfolio.gold || []),
        silver: metal === "silver" ? nextArr : (portfolio.silver || []),
      };
    });

    return res.json({ ok: true, removed: result.removed, gold: result.gold, silver: result.silver });
  } catch (err) {
    next(err);
  }
}


// PUT /api/user/precious
// Body (or query): { metal:'gold'|'silver', id:string, amount?:number, unit?:'g'|'oz'|'lb' }
// Body/QS: { metal:'gold'|'silver', id:string, name?:string, amount?:number, unit?:'g'|'oz'|'lb' }
export async function updatePreciousHolding(req, res, next) {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId) return res.status(401).json({ error: "Unauthenticated" });

    const metal = normalizeMetalKey(req.body?.metal || req.query?.metal);
    const id = String(req.body?.id || req.query?.id || "").trim();
    if (!metal) return res.status(400).json({ error: "metal must be 'gold' or 'silver'" });
    if (!id) return res.status(400).json({ error: "id is required" });

    // read optional fields from body or query
    const raw = (k) => (req.body?.[k] !== undefined ? req.body?.[k] : req.query?.[k]);

    const nameRaw = raw("name");
    const unitRaw = raw("unit");
    const amountRaw = raw("amount");

    const nextName = nameRaw === undefined ? undefined : normalizeName(nameRaw);
    if (nameRaw !== undefined && !nextName) {
      return res.status(400).json({ error: "name, if provided, must be 1–80 chars" });
    }

    const nextUnit = unitRaw === undefined ? undefined : normalizeUnit(unitRaw);
    if (unitRaw !== undefined && !nextUnit) {
      return res.status(400).json({ error: "unit must be 'g', 'oz', or 'lb' if provided" });
    }

    const nextAmount = amountRaw === undefined ? undefined : Number(amountRaw);
    if (amountRaw !== undefined && (!Number.isFinite(nextAmount) || nextAmount <= 0)) {
      return res.status(400).json({ error: "amount must be a positive number if provided" });
    }

    if (nextAmount === undefined && nextUnit === undefined && nextName === undefined) {
      return res.status(400).json({ error: "Provide at least one of name, amount, or unit to update" });
    }

    const now = admin.firestore.Timestamp.now();
    const nowMs = Date.now();

    const userRef = db.collection("users").doc(userId);

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const data = snap.exists ? snap.data() : {};
      const portfolio = data?.portfolio || {};
      const arr = Array.isArray(portfolio[metal]) ? portfolio[metal] : [];

      const idx = arr.findIndex((e) => (e?.id || "") === id);
      if (idx === -1) {
        return { updated: 0, gold: portfolio.gold || [], silver: portfolio.silver || [] };
      }

      if (nextName) {
        const dupe = arr.some((e, i) =>
          i !== idx && (e?.name || "").toLowerCase() === nextName.toLowerCase()
        );
        if (dupe) return { conflict: true };
      }

      const current = arr[idx] || {};
      const updatedEntry = {
        ...current,
        ...(nextName !== undefined ? { name: nextName } : {}),
        ...(nextAmount !== undefined ? { amount: nextAmount } : {}),
        ...(nextUnit !== undefined ? { unit: nextUnit } : {}),
        updatedAt: now,
        updatedAtMs: nowMs,
      };

      const nextArr = arr.slice();
      nextArr[idx] = updatedEntry;

      tx.set(userRef, { portfolio: { [metal]: nextArr } }, { merge: true });

      return {
        updated: 1,
        gold: metal === "gold" ? nextArr : (portfolio.gold || []),
        silver: metal === "silver" ? nextArr : (portfolio.silver || []),
      };
    });

    if (result?.conflict) {
      return res.status(409).json({ error: "A wallet with that name already exists for this metal" });
    }

    return res.json({
      ok: true,
      updated: result.updated || 0,
      gold: result.gold,
      silver: result.silver,
    });
  } catch (err) {
    next(err);
  }
}


