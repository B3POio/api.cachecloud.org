// routes/routes.js
import { Router } from "express";
import * as c from "../controllers/core.controller.js";
import { requireAuth } from "../middlewares/auth.js";
import { upload } from "../config/upload.js";
import * as crypto from "../controllers/crypto.controller.js";
import * as metals from "../controllers/metals.controller.js";
import { getPolymarketBitcoin, getPolymarketEthereum, getPolymarketGold,  getPolymarketSilver} from '../controllers/polymarket.controller.js';
import { saveUserWallet, getUserWallets, deleteUserWallet, updateUserWallet } from "../controllers/user.portfolio.controller.js";
import { getPortfolioSummary, getPortfolioChart } from "../controllers/portfolio.btc.data.controller.js";
import { getPortfolioSummary as getEthSummary, getPortfolioChart as getEthChart } from "../controllers/portfolio.eth.data.controller.js";

const router = Router();

// Health
router.get("/health", c.health);

// Auth
router.post("/auth/signup", c.signup);
router.post("/auth/signin", c.signin);
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

// ✅ Portfolio data (BTC now, ETH later)
router.get("/portfolio/btc/summary", requireAuth, getPortfolioSummary);
router.get("/portfolio/btc/chart", requireAuth, getPortfolioChart);

router.get("/portfolio/eth/summary", requireAuth, getEthSummary);
router.get("/portfolio/eth/chart", requireAuth, getEthChart);     

// ✅ Portfolio wallets
router.post("/user/wallets", requireAuth, saveUserWallet);
router.get("/user/wallets", requireAuth, getUserWallets);
router.delete("/user/wallets", requireAuth, deleteUserWallet);
router.put("/user/wallets", requireAuth, updateUserWallet);

// Settings
router.put("/user/email/mirror", requireAuth, c.mirrorAuthedEmail);


export default router;
