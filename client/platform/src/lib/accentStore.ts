import { useState, useEffect, useSyncExternalStore } from "react";

export const ACCENT_COLORS = [
  { name: "Emerald", hex: "#10b981" },
  { name: "Blue", hex: "#3b82f6" },
  { name: "Violet", hex: "#8b5cf6" },
  { name: "Rose", hex: "#f43f5e" },
  { name: "Amber", hex: "#f59e0b" },
  { name: "Cyan", hex: "#06b6d4" },
  { name: "Pink", hex: "#ec4899" },
  { name: "Indigo", hex: "#6366f1" },
  { name: "Teal", hex: "#14b8a6" },
  { name: "Orange", hex: "#f97316" },
  { name: "Red", hex: "#ef4444" },
  { name: "Yellow", hex: "#eab308" },
  { name: "Lime", hex: "#84cc16" },
  { name: "Green", hex: "#22c55e" },
  { name: "Sky", hex: "#0ea5e9" },
  { name: "Purple", hex: "#a855f7" },
  { name: "Fuchsia", hex: "#d946ef" },
  { name: "Slate", hex: "#64748b" },
  { name: "Zinc", hex: "#71717a" },
  { name: "Stone", hex: "#78716c" },
] as const;

const STORAGE_KEY = "admin_accent_color";
const DEFAULT_COLOR = ACCENT_COLORS[0].hex;

let listeners: (() => void)[] = [];
let snapshot = localStorage.getItem(STORAGE_KEY) || DEFAULT_COLOR;

// Expose the accent as a CSS variable so styling can reference it declaratively
// (e.g. `bg-(--brand-accent)` / `text-(--brand-accent)`) without every consumer
// pulling the hook. Mirrors the app-side store so the admin platform gets the
// same accent-aware chrome (active nav, toggles, selected pills, etc.).
function applyToDocument(hex: string) {
  if (typeof document !== "undefined") {
    document.documentElement.style.setProperty("--brand-accent", hex);
  }
}
applyToDocument(snapshot);

function emitChange() {
  for (const l of listeners) l();
}

export function getAccentColor(): string {
  return snapshot;
}

export function setAccentColor(hex: string) {
  snapshot = hex;
  localStorage.setItem(STORAGE_KEY, hex);
  applyToDocument(hex);
  emitChange();
}

function subscribe(listener: () => void) {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

export function useAccentColor(): [string, (hex: string) => void] {
  const color = useSyncExternalStore(subscribe, () => snapshot);
  return [color, setAccentColor];
}
