import { defineConfig } from "vitest/config";

// Separate Vitest project for Firestore SECURITY-RULES tests. These run against
// the Firestore emulator (started by `firebase emulators:exec` — see the
// `test:rules` script and CI's "Firestore Rules" job) in a NODE environment,
// not happy-dom, and are deliberately kept OUT of the main suite (which has no
// emulator running). The main vitest.config.ts excludes tests/firestore-rules/**
// so the two never collide.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/firestore-rules/**/*.test.ts"],
    globals: false,
    // The emulator round-trips over HTTP and the first connection + JAR warm-up
    // can be slow, so give hooks and assertions generous headroom.
    testTimeout: 15000,
    hookTimeout: 30000,
  },
});
