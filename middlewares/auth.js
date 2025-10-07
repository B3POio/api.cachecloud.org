// middlewares/auth.js
import { admin } from "../config/firebase.js";

export async function requireAuth(req, res, next) {
  try {
    const hdr = req.headers.authorization || "";
    const [, token] = hdr.split(" ");
    if (!token) return res.status(401).json({ error: "Missing bearer token" });

    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded; // attach user info for later use
    next();
  } catch (err) {
    console.error("Auth error:", err?.message || err);
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
