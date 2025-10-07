import { Router } from "express";
import multer from "multer";
import * as c from "../controllers/core.controller.js";
import { requireAuth } from "../middlewares/auth.js";
import { upload } from "../config/upload.js";

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

export default router;
