// Firebase client SDK initialization, shared by app and platform bundles.
// Landing must NOT import this module — landing has no auth.
//
// Config values are public and safe to bundle. They come from the project's
// root .env file (loaded by each per-app Vite config via envDir). See
// .env.example for the variable names; populate them from Firebase Console
// → Project settings → Your apps → Web app config.

import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, OAuthProvider, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";
import { getFunctions, type Functions } from "firebase/functions";

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

// Region the Stripe Payments extension was installed into. Used by getFunctions
// so callable invocations (e.g. createPortalLink) target the right region.
export const STRIPE_EXT_REGION = "europe-central2";

// Reuse the existing app instance during HMR so we don't initialize twice.
export const firebaseApp: FirebaseApp = getApps()[0] ?? initializeApp(config);

export const auth: Auth = getAuth(firebaseApp);

export const db: Firestore = getFirestore(firebaseApp);

export const stripeFunctions: Functions = getFunctions(firebaseApp, STRIPE_EXT_REGION);

export const googleProvider = new GoogleAuthProvider();

// Requires Apple enabled under Firebase Console → Authentication → Sign-in
// method, with a Services ID + key registered in the Apple Developer account.
export const appleProvider = new OAuthProvider("apple.com");
appleProvider.addScope("email");
appleProvider.addScope("name");
