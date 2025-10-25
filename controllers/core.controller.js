import fetch from "node-fetch";
import mime from "mime";
import { admin, db, bucket } from "../config/firebase.js";
import {
  sendWelcomeEmail,
  sendVolunteerApplicationReceipt,
  notifyAdminOfVolunteer,
} from "../mail/postmark.js";

// ENV + helpers
const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY;
const MIN_PASSWORD_LEN = Number(process.env.MIN_PASSWORD_LEN || 8);

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ---------- ROUTE CONTROLLERS ----------

export async function health(_req, res) {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
}

// AUTH  ----------------------------------------------------

// POST /auth/signup
export async function signup(req, res, next) {
  try {
    const { email, password, displayName } = req.body || {};
    if (!isValidEmail(email))
      return res.status(400).json({ error: "Valid email required" });
    if (!password || password.length < MIN_PASSWORD_LEN) {
      return res
        .status(400)
        .json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters` });
    }

    const userRecord = await admin.auth().createUser({
      email: String(email).toLowerCase(),
      password,
      displayName: displayName || undefined,
      emailVerified: false,
      disabled: false,
    });

    const profileRef = db.collection("users").doc(userRecord.uid);
    await profileRef.set(
      {
        email: userRecord.email,
        displayName: userRecord.displayName || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        role: "user",
      },
      { merge: true }
    );

    const customToken = await admin.auth().createCustomToken(userRecord.uid);
    res.status(201).json({
      uid: userRecord.uid,
      customToken,
      info: "Exchange customToken for an ID token using Firebase client SDK.",
    });
  } catch (err) {
    if (err?.code === "auth/email-already-exists") {
      return res.status(409).json({ error: "Email already in use" });
    }
    next(err);
  }
}

// POST /auth/signin
export async function signin(req, res, next) {
  try {
    const { email, password } = req.body || {};
    if (!isValidEmail(email))
      return res.status(400).json({ error: "Valid email required" });
    if (!password)
      return res.status(400).json({ error: "Password required" });

    if (!FIREBASE_WEB_API_KEY) {
      return res.status(500).json({
        error: "Server missing FIREBASE_WEB_API_KEY config",
      });
    }

    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: String(email).toLowerCase(),
        password,
        returnSecureToken: true,
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      const errMsg = data?.error?.message || "Authentication failed";
      const map = {
        EMAIL_NOT_FOUND: "No user found with that email",
        INVALID_PASSWORD: "Invalid password",
        USER_DISABLED: "User account is disabled",
      };
      return res.status(401).json({ error: map[errMsg] || errMsg });
    }

    res.json({
      uid: data.localId,
      idToken: data.idToken,
      refreshToken: data.refreshToken,
      expiresIn: Number(data.expiresIn || 3600),
    });
  } catch (err) {
    next(err);
  }
}

// POST /auth/signout
export async function signout(req, res, next) {
  try {
    const hdr = req.headers.authorization || "";
    const [, token] = hdr.split(" ");
    if (!token)
      return res.status(400).json({ error: "Missing bearer token" });

    // Verify the token and revoke it
    const decoded = await admin.auth().verifyIdToken(token);
    await admin.auth().revokeRefreshTokens(decoded.uid);

    // Optional: log or update user record
    await db.collection("users").doc(decoded.uid).set(
      {
        lastSignoutAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.json({ message: "Successfully signed out" });
  } catch (err) {
    if (err.code === "auth/id-token-expired") {
      return res.status(400).json({ error: "Token already expired" });
    }
    next(err);
  }
}


export function me(req, res) {
  res.json({
    uid: req.user.uid,
    email: req.user.email || null,
    auth_time: req.user.auth_time,
    claims: req.user,
  });
}

// SUBSCRIBERS ----------------------------------------------

export async function subscribe(req, res, next) {
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

    Promise.resolve(sendWelcomeEmail(normalized)).catch((err) =>
      console.error("Welcome email failed:", err?.message || err)
    );

    res.json({ message: `Saved: ${normalized}` });
  } catch (err) {
    next(err);
  }
}

export async function subscriberCount(_req, res, next) {
  try {
    const snapshot = await db.collection("subscribers").count().get();
    res.json({ totalSubscribers: snapshot.data().count });
  } catch (err) {
    next(err);
  }
}

// CAREERS ---------------------------------------------------

export async function getCareers(_req, res, next) {
  try {
    const snapshot = await db.collection("careers").get();
    const careers = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    res.json({ careers });
  } catch (err) {
    next(err);
  }
}

export async function getCareer(req, res, next) {
  try {
    const id = req.params.id;
    const doc = await db.collection("careers").doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: "Career not found" });
    res.json({ career: { id: doc.id, ...doc.data() } });
  } catch (err) {
    next(err);
  }
}

export async function addCareers(req, res, next) {
  try {
    let careers = req.body;
    if (!Array.isArray(careers)) careers = [careers];
    if (careers.length === 0)
      return res.status(400).json({ error: "No job postings provided" });

    const batch = db.batch();
    const careersRef = db.collection("careers");

    careers.forEach((job) => {
      const docRef = careersRef.doc();
      batch.set(docRef, {
        ...job,
        postedAt:
          job.postedAt || admin.firestore.FieldValue.serverTimestamp(),
        active: job.active !== undefined ? job.active : true,
      });
    });

    await batch.commit();
    res.json({ message: `${careers.length} job(s) added successfully.` });
  } catch (err) {
    next(err);
  }
}

// VOLUNTEERS ------------------------------------------------

export async function listVolunteers(_req, res, next) {
  try {
    const snapshot = await db
      .collection("volunteers")
      .orderBy("createdAt", "desc")
      .limit(100)
      .get();

    const volunteers = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ volunteers });
  } catch (err) {
    next(err);
  }
}

export async function applyVolunteer(req, res, next) {
  try {
    const {
      firstName,
      middleName,
      lastName,
      phone,
      email,
      socials,
      jobId,
      jobTitle: jtRaw,
    } = req.body || {};

    if (!firstName || !lastName || !phone || !email) {
      return res
        .status(400)
        .json({ error: "firstName, lastName, phone, and email are required." });
    }

    // --- Parse socials ---
    let socialsParsed = [];
    if (typeof socials === "string" && socials.trim()) {
      try {
        socialsParsed = JSON.parse(socials);
      } catch {
        socialsParsed = socials
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
    } else if (Array.isArray(socials)) socialsParsed = socials;

    let socialsNormalized = {};
    if (Array.isArray(socialsParsed)) {
      socialsParsed.forEach((entry) => {
        const [platform, handle] = entry.split(/[:=]/).map((s) => s.trim());
        if (platform && handle)
          socialsNormalized[platform.toLowerCase()] = handle;
      });
    } else if (typeof socialsParsed === "object" && socialsParsed !== null) {
      Object.entries(socialsParsed).forEach(([platform, handle]) => {
        if (platform && handle)
          socialsNormalized[platform.toLowerCase()] = String(handle).trim();
      });
    }

    // --- Resolve job title ---
    let jobTitle = jtRaw ? String(jtRaw).trim() : null;
    if (jobId && !jobTitle) {
      const jobDoc = await db.collection("careers").doc(String(jobId)).get();
      if (jobDoc.exists) {
        const data = jobDoc.data() || {};
        jobTitle = data.title || data.name || data.jobTitle || null;
      }
    }

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
      jobTitle: jobTitle || null,
    });

    const applicantPayload = {
      id: docRef.id,
      firstName,
      middleName,
      lastName,
      phone,
      email: String(email).trim().toLowerCase(),
      socials: socialsNormalized,
      resumeUrl,
      createdAt: new Date().toISOString(),
    };

    Promise.allSettled([
      sendVolunteerApplicationReceipt({
        to: String(email).trim().toLowerCase(),
        firstName,
        jobTitle,
        jobId: jobId ? String(jobId) : undefined,
      }),
      notifyAdminOfVolunteer({
        applicant: applicantPayload,
        jobTitle,
        jobId: jobId ? String(jobId) : undefined,
      }),
    ]).catch((err) =>
      console.error("Error sending volunteer emails:", err?.message || err)
    );

    res.json({
      message: "Application received",
      id: docRef.id,
      resumeUploaded: Boolean(req.file),
      job: { id: jobId || null, title: jobTitle || null },
    });
  } catch (err) {
    next(err);
  }
}

export async function mirrorAuthedEmail(req, res, next) {
  try {
    const uid = req.user?.uid;
    const email = req.user?.email;
    if (!uid) return res.status(401).json({ error: "Unauthenticated" });
    if (!email) return res.status(400).json({ error: "No email on session" });

    await db.collection("users").doc(uid).set(
      {
        email: String(email).toLowerCase(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.json({ ok: true, email });
  } catch (err) {
    next(err);
  }
}