// Realtime social-media link store backed by Firestore.
//
// Storage: a single Firestore doc at config/social holds the URL for each
// supported platform. Public read is permitted by firestore.rules so the
// landing footer (unauthenticated visitors) can render social icons.
//
// Reads: components subscribe via onSnapshot through `useSocialLinks()`.
// Edits made in /admin/social-media push to every connected client across
// platform / app / landing within ~1s.
//
// Writes: go through PUT /api/social, which requires admin and validates
// the payload server-side. Direct client writes are blocked by rules.
//
// First-paint cache: a tiny localStorage cache holds the last-seen links so
// the page renders instantly while Firestore catches up.

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "./firebase";
import { apiRequest } from "./queryClient";
import {
  COL,
  CONFIG_DOC_SOCIAL,
  DEFAULT_SOCIAL_LINKS,
  type SocialLinkMap,
  type SocialPlatformKey,
} from "@shared/firestore-schema";

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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ref = doc(db, COL.config, CONFIG_DOC_SOCIAL);
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
        setLoading(false);
      },
      (err) => {
        console.error("social onSnapshot failed:", err);
        setLoading(false);
      },
    );
    return () => unsub();
  }, []);

  return { links, loading };
}

// Persist one or more social links. Admin-only — server enforces via
// requirePlatformPrivilege("platform.modifySettings").
export async function saveSocialLinks(
  patch: Partial<Record<SocialPlatformKey, string>>,
): Promise<void> {
  await apiRequest("PUT", "/api/social", patch);
}
