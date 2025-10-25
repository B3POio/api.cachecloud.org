// routes/routes.js
import { Router } from "express";
import { upload } from "../config/upload.js";
import { requireAuth } from "../middlewares/auth.js";
import * as c from "../controllers/core.controller.js";
import * as crypto from "../controllers/crypto.controller.js";
import * as metals from "../controllers/metals.controller.js";
import * as wallets from "../controllers/user.portfolio.controller.js";
import { getPortfolioSummary, getPortfolioChart } from "../controllers/portfolio.btc.data.controller.js";
import { getPortfolioSummary as getEthSummary, getPortfolioChart as getEthChart } from "../controllers/portfolio.eth.data.controller.js";
import { getPolymarketBitcoin, getPolymarketEthereum, getPolymarketGold,  getPolymarketSilver} from '../controllers/polymarket.controller.js';

const router = Router();

// Health
router.get("/health", c.health);

// Auth
router.post("/auth/signup", c.signup);
router.post("/auth/signin", c.signin);
router.post("/auth/signout", requireAuth,  c.signout);
router.get("/me", requireAuth, c.me);

// Subscribers
router.post("/subscribe", c.subscribe);
router.get("/subscribers/count", c.subscriberCount);

// Careers
router.get("/get-careers", c.getCareers);
router.get("/get-career/:id", c.getCareer);
router.post("/add-careers", requireAuth, c.addCareers);

// Volunteers
router.get("/volunteers", c.listVolunteers);
router.post("/volunteers/apply", upload.single("resume"), c.applyVolunteer);

// ✅ Crypto (auth-protected)
router.get("/crypto/global", requireAuth, crypto.getGlobal);
router.get("/crypto/summary", requireAuth, crypto.getSummary);
router.get("/crypto/chart", requireAuth, crypto.getChart);

// ✅ Polymarket (auth-protected)
router.get('/polymarket/bitcoin', requireAuth, getPolymarketBitcoin);
router.get('/polymarket/ethereum', requireAuth, getPolymarketEthereum);
router.get('/polymarket/gold', requireAuth, getPolymarketGold);
router.get('/polymarket/silver', requireAuth, getPolymarketSilver);

// ✅ Metals (auth-protected)
router.get("/metals/summary", requireAuth, metals.getSummary);
router.get("/metals/chart", requireAuth, metals.getChart);

// ✅ Portfolio data (auth-protected)
router.get("/portfolio/btc/summary", requireAuth, getPortfolioSummary);
router.get("/portfolio/btc/chart", requireAuth, getPortfolioChart);

router.get("/portfolio/eth/summary", requireAuth, getEthSummary);
router.get("/portfolio/eth/chart", requireAuth, getEthChart);     

// ✅ Crypto wallets (auth-protected)
router.get("/user/wallets", requireAuth, wallets.getUserWallets);
router.put("/user/wallets", requireAuth, wallets.updateUserWallet);
router.post("/user/wallets", requireAuth, wallets.saveUserWallet);
router.delete("/user/wallets", requireAuth, wallets.deleteUserWallet);

// ✅ Precious metals wallets (auth-protected)
router.get("/user/metalswallet", requireAuth, wallets.getPreciousHoldings);
router.put("/user/metalswallet", requireAuth, wallets.updatePreciousHolding);
router.post("/user/metalswallet", requireAuth, wallets.savePreciousHolding);
router.delete("/user/metalswallet", requireAuth, wallets.deletePreciousHolding);


// ✅ Settings (auth-protected)
router.put("/user/email/mirror", requireAuth, c.mirrorAuthedEmail);

export default router;
