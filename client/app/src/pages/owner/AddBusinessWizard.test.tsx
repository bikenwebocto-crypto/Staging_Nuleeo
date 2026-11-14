// UI tests for the Add Business wizard: per-step validation, conditional
// fields, draft resume, single submission, success screen honesty.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BusinessDraft } from "@shared/businesses";

const state = vi.hoisted(() => ({
  draft: null as BusinessDraft | null,
  saved: [] as unknown[],
  createCalls: [] as { submissionId: string; data: Record<string, unknown> }[],
  createPending: false,
}));

vi.mock("@/lib/businesses", () => ({
  useBusinessDraft: () => ({ isFetched: true, isLoading: false, data: { draft: state.draft } }),
  useSaveBusinessDraft: () => ({
    mutate: (v: unknown) => state.saved.push(v),
    isPending: false,
    isError: false,
    isSuccess: false,
  }),
  useDiscardBusinessDraft: () => ({
    mutate: (_: unknown, o?: { onSettled?: () => void }) => o?.onSettled?.(),
  }),
  useCreateBusiness: () => ({
    isPending: state.createPending,
    mutate: (
      v: { submissionId: string; data: Record<string, unknown> },
      o: { onSuccess: (b: unknown) => void },
    ) => {
      state.createCalls.push(v);
      o.onSuccess({
        id: "biz_1",
        name: (v.data.tradingName as string) || (v.data.legalName as string),
        bankingPreference: v.data.bankingPreference,
        bankingStatus: "NOT_STARTED",
        status: "SETTING_UP",
      });
    },
  }),
}));

import AddBusinessWizard from "./AddBusinessWizard";

const radio = (name: string) =>
  fireEvent.click(screen.getAllByRole("radio", { name: new RegExp(`^${name}`) })[0]);
const type = (label: RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const next = () =>
  fireEvent.click(screen.getByRole("button", { name: /^(Continue|Add business)$/ }));

beforeEach(() => {
  state.draft = null;
  state.saved = [];
  state.createCalls = [];
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function fillStep1(selfEmployed = false) {
  radio(selfEmployed ? "Self-employed" : "Limited company");
  type(/Legal name/, "Acme Holdings Ltd");
  type(/Country/, "CY");
  if (!selfEmployed) type(/Registration number/, "HE1");
}

describe("AddBusinessWizard", () => {
  it("blocks Continue on step 1 until required fields are valid", () => {
    render(<AddBusinessWizard />);
    next();
    expect(screen.getByText("Choose a business type")).toBeTruthy();
    expect(screen.getByText("Enter the legal name")).toBeTruthy();
    fillStep1();
    next();
    expect(screen.getByText("Step 2 of 4")).toBeTruthy();
  });

  it("self-employed doesn't need a registration number", () => {
    render(<AddBusinessWizard />);
    fillStep1(true);
    expect(screen.getByLabelText(/Registration number/).closest("div")?.textContent).toMatch(
      /optional/,
    );
    next();
    expect(screen.getByText("Step 2 of 4")).toBeTruthy();
  });

  it("shows VAT number and filing period only when VAT registered", () => {
    state.draft = {
      step: 2,
      data: { businessType: "SELF_EMPLOYED", legalName: "Jo", country: "GB" },
      updatedAt: "",
    };
    render(<AddBusinessWizard />);
    expect(screen.queryByLabelText(/VAT number/)).toBeNull();
    radio("Yes");
    expect(screen.getByLabelText(/VAT number/)).toBeTruthy();
    expect(screen.getByLabelText(/Filing period/)).toBeTruthy();
    radio("No");
    expect(screen.queryByLabelText(/VAT number/)).toBeNull();
  });

  it("resumes a saved draft at its step and autosaves progress", () => {
    state.draft = { step: 3, data: { legalName: "Saved Co" }, updatedAt: "" };
    render(<AddBusinessWizard />);
    expect(screen.getByText("Step 3 of 4")).toBeTruthy();
    expect(screen.getByText(/picked up where you left off/)).toBeTruthy();
    radio("Director");
    act(() => vi.advanceTimersByTime(900));
    expect(state.saved.at(-1)).toMatchObject({
      step: 3,
      data: { legalName: "Saved Co", role: "DIRECTOR" },
    });
  });

  it("allows a share below 100% and submits once, then shows honest banking status", () => {
    state.draft = {
      step: 3,
      data: {
        businessType: "LIMITED_COMPANY",
        legalName: "Acme Holdings Ltd",
        country: "CY",
        registrationNumber: "HE1",
        sector: "Advisory",
        vatRegistered: false,
        financialYearEnd: "12-31",
      },
      updatedAt: "",
    };
    render(<AddBusinessWizard />);
    radio("Shareholder");
    type(/Your ownership/, "40");
    next();
    expect(screen.getByText("Step 4 of 4")).toBeTruthy();
    radio("Open a business account with payabl");
    next();
    expect(state.createCalls).toHaveLength(1);
    expect(state.createCalls[0].data).toMatchObject({ role: "SHAREHOLDER", sharePercent: 40 });
    expect(state.createCalls[0].submissionId.length).toBeGreaterThanOrEqual(8);
    expect(screen.getByText("Business added")).toBeTruthy();
    expect(screen.getByText("Acme Holdings Ltd")).toBeTruthy();
    expect(screen.getByText(/No application has been sent/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open business" }).getAttribute("href")).toBe(
      "/business/biz_1",
    );
  });
});
