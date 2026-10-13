// Landing-only realtime social-links hook.
//
// Landing has no auth and must NOT pull in firebase/auth — we initialize a
// Firestore-only Firebase app here and subscribe to the public `config/social`
// doc directly. Reads are allowed unauthenticated by firestore.rules.

import { useEffect, useState } from "react";
import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getFirestore, doc, onSnapshot } from "firebase/firestore";
import {
  COL,
  CONFIG_DOC_SOCIAL,
  DEFAULT_SOCIAL_LINKS,
  type SocialLinkMap,
} from "@shared/firestore-schema";

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const landingApp: FirebaseApp = getApps()[0] ?? initializeApp(config);
const landingDb = getFirestore(landingApp);

const CACHE_KEY = "social_links_cache";

function readCache(): SocialLinkMap {
  try {
    const stored = localStorage.getItem(CACHE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<SocialLinkMap>;
      return { ...DEFAULT_SOCIAL_LINKS, ...parsed };
    }
  } catch {}
  return { ...DEFAULT_SOCIAL_LINKS };
}

function writeCache(links: SocialLinkMap) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(links));
  } catch {}
}

export function useSocialLinks() {
  const [links, setLinks] = useState<SocialLinkMap>(() => readCache());

  useEffect(() => {
    const ref = doc(landingDb, COL.config, CONFIG_DOC_SOCIAL);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          const stored = snap.data() as Partial<SocialLinkMap>;
          const merged: SocialLinkMap = { ...DEFAULT_SOCIAL_LINKS, ...stored };
          setLinks(merged);
          writeCache(merged);
        } else {
          setLinks({ ...DEFAULT_SOCIAL_LINKS });
        }
      },
      (err) => {
        console.error("social onSnapshot failed:", err);
      },
    );
    return () => unsub();
  }, []);

  return links;
}
