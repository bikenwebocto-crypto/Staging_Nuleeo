import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Logo } from "./Logo";

// Logo is the simplest of our shared UI primitives — pure render, no providers.
// Used here to prove the test pipeline can render React components from shared,
// catching prop-shape regressions during the de-duplication refactor.

describe("Logo", () => {
  it("renders a light wordmark by default (light theme)", () => {
    document.documentElement.classList.remove("dark");
    const { container } = render(<Logo />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("/logo-wordmark.png");
    expect(img?.getAttribute("alt")).toBe("Olio");
  });

  it("renders the white wordmark when an explicit white color is passed", () => {
    const { container } = render(<Logo color="white" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/logo-wordmark-white.png");
  });

  it("renders the symbol variant when requested", () => {
    document.documentElement.classList.remove("dark");
    const { container } = render(<Logo variant="symbol" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/logo-symbol.png");
  });

  it("respects a custom alt", () => {
    const { container } = render(<Logo alt="Olio Wallet" />);
    expect(container.querySelector("img")?.getAttribute("alt")).toBe("Olio Wallet");
  });
});
