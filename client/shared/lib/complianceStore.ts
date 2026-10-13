// Realtime compliance document store backed by Firestore.
//
// Storage: a single Firestore doc at config/compliance holds all four legal
// documents (Terms, Privacy, GDPR, Owner Terms). Public read is permitted
// by firestore.rules — the legal pages are linked from the signup
// checkboxes and the Google OAuth consent screen, which are accessed
// before sign-in.
//
// Reads: components subscribe via Firestore onSnapshot through the
// `useComplianceDoc()` / `useComplianceDocs()` hooks. Edits made on the
// platform admin app push to every connected client (across both
// platform.oliowallet.com and app.oliowallet.com) within ~1s.
//
// Writes: go through PUT /api/compliance, which requires admin and
// validates the payload server-side. Direct client writes are blocked by
// rules.
//
// First-paint cache: a tiny localStorage cache holds the last-seen content
// so the page renders instantly while Firestore catches up.

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "./firebase";
import { apiRequest } from "./queryClient";
import {
  COL,
  CONFIG_DOC_COMPLIANCE,
  type ComplianceDocKey,
  type ComplianceDocs,
} from "@shared/firestore-schema";
import { DEFAULT_COMPLIANCE_DOCS } from "@shared/compliance-defaults";

export type { ComplianceDocKey, ComplianceDocs };
export const defaultDocs = DEFAULT_COMPLIANCE_DOCS;

const CACHE_KEY = "compliance_docs_cache";

function readCache(): ComplianceDocs {
  try {
    const stored = localStorage.getItem(CACHE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<ComplianceDocs>;
      return { ...DEFAULT_COMPLIANCE_DOCS, ...parsed };
    }
  } catch {}
  return { ...DEFAULT_COMPLIANCE_DOCS };
}

function writeCache(docs: ComplianceDocs) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(docs));
  } catch {}
}

// Subscribe to all four compliance docs. Returns the current snapshot plus a
// loading flag for the very first read. Cache is returned synchronously so
// the page never paints the bare defaults if a previous visit populated it.
export function useComplianceDocs() {
  const [docs, setDocs] = useState<ComplianceDocs>(() => readCache());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ref = doc(db, COL.config, CONFIG_DOC_COMPLIANCE);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          const stored = snap.data() as Partial<ComplianceDocs>;
          const merged: ComplianceDocs = {
            ...DEFAULT_COMPLIANCE_DOCS,
            ...stored,
          };
          setDocs(merged);
          writeCache(merged);
        } else {
          setDocs({ ...DEFAULT_COMPLIANCE_DOCS });
        }
        setLoading(false);
      },
      (err) => {
        console.error("compliance onSnapshot failed:", err);
        setLoading(false);
      },
    );
    return () => unsub();
  }, []);

  return { docs, loading };
}

// Convenience hook for a single document.
export function useComplianceDoc(key: ComplianceDocKey) {
  const { docs, loading } = useComplianceDocs();
  return { html: docs[key], loading };
}

// Persist a single document. Admin-only — server enforces via
// requirePlatformPrivilege("platform.modifySettings").
export async function saveComplianceDoc(key: ComplianceDocKey, html: string): Promise<void> {
  await apiRequest("PUT", "/api/compliance", { [key]: html });
}
