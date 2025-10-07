// config/firebase.js
import dotenv from "dotenv";
dotenv.config(); // ✅ ensures .env is loaded, no matter import order

import admin from "firebase-admin";

// pull from env
const bucketName = process.env.STORAGE_BUCKET;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    ...(bucketName ? { storageBucket: bucketName } : {}),
  });
}

export const auth = admin.auth();
export const db = admin.firestore();
export const bucket = bucketName ? admin.storage().bucket() : null;
export { admin };
