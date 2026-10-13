import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

// The avatar dropdown's "Profile Settings" item lives in the SHARED DesktopHeader,
// which renders for owner, tenant, AND admin. When Appearance/Profile moved to the
// new /admin/profile page we repointed ONLY the admin branch. These tests lock in
// that each role still routes to its own settings surface — guarding against a
// cross-app regression in this shared component.

const { setLocation } = vi.hoisted(() => ({ setLocation: vi.fn() }));

vi.mock("wouter", () => ({
  useLocation: () => ["/", setLocation],
  Link: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@ui/lib/useAuth", () => ({
  useAuth: () => ({ profile: { firstName: "Ada", lastName: "Min" }, signOut: vi.fn() }),
}));
// Heavy descendants we don't exercise here — stub so the unit stays focused on
// DesktopHeader's own routing logic.
vi.mock("@ui/components/common/ProfileDrawer", () => ({ ProfileDrawer: () => null }));
vi.mock("@ui/components/common/CommandPalette", () => ({ CommandPalette: () => null }));

// happy-dom doesn't provide a usable localStorage / matchMedia out of the box,
// and DesktopHeader reads both during theme init. Stub minimal in-memory versions.
const memStore: Record<string, string> = {};
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => (k in memStore ? memStore[k] : null),
    setItem: (k: string, v: string) => {
      memStore[k] = String(v);
    },
    removeItem: (k: string) => {
      delete memStore[k];
    },
    clear: () => {
      for (const k of Object.keys(memStore)) delete memStore[k];
    },
    key: (i: number) => Object.keys(memStore)[i] ?? null,
    get length() {
      return Object.keys(memStore).length;
    },
  },
});
Object.defineProperty(globalThis, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  }),
});

import { DesktopHeader } from "./DesktopHeader";

function clickProfileSettings() {
  // Open the avatar dropdown (its toggle shows the profile name), then click the item.
  fireEvent.click(screen.getByText("Ada Min").closest("button")!);
  fireEvent.click(screen.getByText("Profile Settings"));
}

describe("DesktopHeader · Profile Settings routing by role", () => {
  beforeEach(() => setLocation.mockReset());
  afterEach(() => cleanup());

  it("admin → /admin/profile (single navigation, no legacy ?tab link)", () => {
    render(<DesktopHeader role="admin" menuItems={[]} />);
    clickProfileSettings();
    expect(setLocation).toHaveBeenCalledTimes(1);
    expect(setLocation).toHaveBeenCalledWith("/admin/profile");
  });

  it("owner → /owner/settings (unchanged by the split)", () => {
    render(<DesktopHeader role="owner" menuItems={[]} />);
    clickProfileSettings();
    expect(setLocation).toHaveBeenCalledWith("/owner/settings");
  });

  it("tenant → /tenant/settings (unchanged by the split)", () => {
    render(<DesktopHeader role="tenant" menuItems={[]} />);
    clickProfileSettings();
    expect(setLocation).toHaveBeenCalledWith("/tenant/settings");
  });
});
