import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { formatDate } from "@ui/lib/format";
import { AgreementDocument } from "./AgreementDocument";
import type { AgreementDocumentData } from "./AgreementDocument";
import type { AgreementIndexation } from "@shared/firestore-schema";

afterEach(cleanup);

// Mirrors the screenshot lease (Makariou III Ave, fixed 5% yearly after 10mo).
const doc = (indexation: AgreementIndexation | null): AgreementDocumentData => ({
  id: "agr_988f50ab39e0eab1d1e3cb4a",
  status: "active",
  leaseType: "Residential Lease",
  address: "Makariou III Avenue",
  monthlyRent: 1000,
  deposit: 2000,
  startDate: "2026-05-31",
  endDate: "2027-05-31",
  noticePeriodMonths: null,
  paymentDayOfMonth: null,
  paymentFrequency: "monthly",
  rentalDurationMonths: 12,
  rentFreePeriodMonths: null,
  prepaidRents: 2,
  autoRenewal: "none",
  indexation,
  termsAndConditions: null,
  signedAt: null,
});

const renderDoc = (indexation: AgreementIndexation | null) =>
  render(
    <AgreementDocument
      agreement={doc(indexation)}
      landlordName="James Christodoulou"
      tenantName="Kotsios Kotsiou"
    />,
  );

describe("AgreementDocument — Next increase line", () => {
  it("shows the Next Increase row with the scheduled date once indexation is seeded", () => {
    renderDoc({
      type: "fixed",
      rate: 5,
      delayMonths: 10,
      frequency: "yearly",
      nextIncreaseDate: "2027-03-31",
      appliedSteps: 0,
    });
    expect(screen.getByText("Next Increase")).toBeTruthy();
    expect(screen.getByText(formatDate("2027-03-31"))).toBeTruthy();
    // The descriptive terms line still renders too.
    expect(screen.getByText("Rent Increase")).toBeTruthy();
  });

  it("appends the applied-steps count after one or more increases", () => {
    renderDoc({
      type: "fixed",
      rate: 5,
      frequency: "yearly",
      nextIncreaseDate: "2028-03-31",
      appliedSteps: 2,
    });
    expect(screen.getByText(`${formatDate("2028-03-31")} · 2 applied`)).toBeTruthy();
  });

  it("hides the Next Increase row when indexation has no scheduled date (legacy lease)", () => {
    renderDoc({ type: "fixed", rate: 5, frequency: "yearly" });
    expect(screen.queryByText("Next Increase")).toBeNull();
    // Rent Increase (the static terms) still shows.
    expect(screen.getByText("Rent Increase")).toBeTruthy();
  });

  it("hides the Next Increase row entirely when there is no indexation", () => {
    renderDoc(null);
    expect(screen.queryByText("Next Increase")).toBeNull();
  });
});
