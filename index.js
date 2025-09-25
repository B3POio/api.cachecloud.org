// index.js
import express from "express";
import dotenv from "dotenv";
import admin from "firebase-admin";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import multer from "multer";
import mime from "mime";
import { sendWelcomeEmail, sendVolunteerApplicationReceipt, notifyAdminOfVolunteer } from "./mail/postmark.js";


dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 5015);

// --- Security & Perf ---
app.disable("x-powered-by");
app.use(helmet());
app.use(compression());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

// If running behind Nginx/ELB
if ((process.env.TRUST_PROXY || "").toLowerCase() === "true") {
  app.set("trust proxy", 1);
}

// --- CORS (allowlist via env) ---
// CORS_ORIGINS="https://app.example.com,https://admin.example.com"
const allowlist = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, cb) {
    if (!origin || allowlist.length === 0 || allowlist.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
};
app.use(cors(corsOptions));

// --- Rate limiting for public API ---
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX || 300),
  standardHeaders: true,
  legacyHeaders: false
});
app.use("/api", limiter);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    storageBucket: process.env.STORAGE_BUCKET // <-- add this
  });
}
const db = admin.firestore();
const bucket = admin.storage().bucket(); // now uses the default bucket above

// --- File uploads (resumes) ---
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    // ~10 MB max
    fileSize: Number(process.env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024),
  },
  fileFilter: (req, file, cb) => {
    const allowed = new Set([
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "image/png",
      "image/jpeg",
      "image/jpg",
      "image/webp",
      "image/heic"
    ]);
    if (allowed.has(file.mimetype)) return cb(null, true);
    cb(new Error("Unsupported file type"));
  },
});

// ---------- ROUTES (your existing ones) ----------
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/api/subscribe", async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "Email is required" });
    }

    const normalized = email.trim().toLowerCase();

    await db
      .collection("subscribers")
      .doc(normalized)
      .set(
        {
          email: normalized,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          subscribed: true,
        },
        { merge: true }
      );

    // Kick off welcome email (non-blocking)
    Promise.resolve(
      sendWelcomeEmail(normalized)
    ).catch((err) => {
      console.error("Welcome email failed:", err?.message || err);
    });

    return res.json({ message: `Saved: ${normalized}` });
  } catch (err) {
    return next(err);
  }
});

app.get("/api/subscribers/count", async (req, res, next) => {
  try {
    const snapshot = await db.collection("subscribers").count().get();
    const count = snapshot.data().count;
    res.json({ totalSubscribers: count });
  } catch (err) {
    next(err);
  }
});

app.get("/api/get-careers", async (req, res, next) => {
  try {
    const snapshot = await db.collection("careers").get();
    const careers = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    res.json({ careers });
  } catch (err) {
    next(err);
  }
});

// NEW detail route (path param)
app.get("/api/get-career/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    const doc = await db.collection("careers").doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: "Career not found" });
    res.json({ career: { id: doc.id, ...doc.data() } });
  } catch (err) {
    next(err);
  }
});

app.post("/api/add-careers", async (req, res, next) => {
  try {
    let careers = req.body;

    // Normalize: allow single object or array
    if (!Array.isArray(careers)) {
      careers = [careers];
    }

    if (careers.length === 0) {
      return res.status(400).json({ error: "No job postings provided" });
    }

    const batch = db.batch();
    const careersRef = db.collection("careers");

    careers.forEach(job => {
      const docRef = careersRef.doc(); // auto-generate ID
      batch.set(docRef, {
        ...job,
        postedAt: job.postedAt || admin.firestore.FieldValue.serverTimestamp(),
        active: job.active !== undefined ? job.active : true,
      });
    });

    await batch.commit();

    res.json({ message: `${careers.length} job(s) added successfully.` });
  } catch (err) {
    next(err);
  }
});

app.get("/api/volunteers", async (req, res, next) => {
  try {
    const snapshot = await db.collection("volunteers")
      .orderBy("createdAt", "desc")
      .limit(100)
      .get();

    const volunteers = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ volunteers });
  } catch (err) {
    next(err);
  }
});

app.post("/api/volunteers/apply", upload.single("resume"), async (req, res, next) => {
  try {
    const {
      firstName,
      middleName,
      lastName,
      phone,
      email,
      socials,
      jobId,         
      jobTitle: jtRaw 
    } = req.body || {};

    if (!firstName || !lastName || !phone || !email) {
      return res.status(400).json({ error: "firstName, lastName, phone, and email are required." });
    }

    // Parse socials (unchanged) ...
    let socialsParsed = [];
    if (typeof socials === "string" && socials.trim()) {
      try { socialsParsed = JSON.parse(socials); } catch {
        socialsParsed = socials.split(",").map(s => s.trim()).filter(Boolean);
      }
    } else if (Array.isArray(socials)) {
      socialsParsed = socials;
    }

    let socialsNormalized = {};
    if (Array.isArray(socialsParsed)) {
      socialsParsed.forEach(entry => {
        const [platform, handle] = entry.split(/[:=]/).map(s => s.trim());
        if (platform && handle) socialsNormalized[platform.toLowerCase()] = handle;
      });
    } else if (typeof socialsParsed === "object" && socialsParsed !== null) {
      Object.entries(socialsParsed).forEach(([platform, handle]) => {
        if (platform && handle) socialsNormalized[platform.toLowerCase()] = String(handle).trim();
      });
    }

    // --- Resolve job title if only jobId was sent ---
    let jobTitle = jtRaw ? String(jtRaw).trim() : null;
    if (jobId && !jobTitle) {
      const jobDoc = await db.collection("careers").doc(String(jobId)).get();
      if (jobDoc.exists) {
        const data = jobDoc.data() || {};
        jobTitle = data.title || data.name || data.jobTitle || null;
      }
    }

    // --- Prepare Firestore doc ---
    const docRef = db.collection("volunteers").doc();
    const createdAt = admin.firestore.FieldValue.serverTimestamp();

    let resumeUrl = null;
    if (req.file) {
      const ext = mime.getExtension(req.file.mimetype) || "bin";
      const fileName = `volunteers/${docRef.id}/resume.${ext}`;
      const file = bucket.file(fileName);

      await file.save(req.file.buffer, {
        contentType: req.file.mimetype,
        resumable: false,
        metadata: { cacheControl: "private, max-age=0, no-transform" },
      });

      const [signedUrl] = await file.getSignedUrl({
        action: "read",
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });
      resumeUrl = signedUrl;
    }

    await docRef.set({
      firstName: String(firstName).trim(),
      middleName: middleName ? String(middleName).trim() : null,
      lastName: String(lastName).trim(),
      phone: String(phone).trim(),
      email: String(email).trim().toLowerCase(),
      socials: socialsNormalized,
      resumeUrl,
      resumeUploaded: Boolean(req.file),
      createdAt,
      status: "new",
      jobId: jobId ? String(jobId).trim() : null,   
      jobTitle: jobTitle || null                    
    });

    // Kick off both emails (do not block response)
    const applicantPayload = {
      id: docRef.id,
      firstName, middleName, lastName,
      phone,
      email: String(email).trim().toLowerCase(),
      socials: socialsNormalized,
      resumeUrl,
      createdAt: new Date().toISOString() // human-readable for admin email
    };

    Promise.allSettled([
      sendVolunteerApplicationReceipt({
        to: String(email).trim().toLowerCase(),
        firstName,
        jobTitle,
        jobId: jobId ? String(jobId) : undefined
      }),
      notifyAdminOfVolunteer({
        applicant: applicantPayload,
        jobTitle,
        jobId: jobId ? String(jobId) : undefined
      })
    ]).catch(err => {
      console.error("Error sending volunteer emails:", err?.message || err);
    });

    return res.json({
      message: "Application received",
      id: docRef.id,
      resumeUploaded: Boolean(req.file),
      job: { id: jobId || null, title: jobTitle || null }
    });
  } catch (err) {
    next(err);
  }
});


// 404
app.use((req, res) => {
  res.status(404).json({ error: "Not Found" });
});

// Central error handler
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  const isProd = process.env.NODE_ENV === "production";
  if (!isProd) console.error(err);
  res.status(status).json({
    error: isProd ? "Internal Server Error" : err.message || "Internal Error",
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
