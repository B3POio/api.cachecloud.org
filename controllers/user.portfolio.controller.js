// controllers/user.portfolio.controller.js
import admin from "firebase-admin";
const db = admin.firestore();

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
