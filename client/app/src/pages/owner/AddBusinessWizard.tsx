import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Check, CheckCircle2, Info, Loader2, X } from "lucide-react";
import { cn } from "@ui/lib/utils";
import type { Entity } from "@shared/firestore-schema";
import {
  BUSINESS_COUNTRIES,
  BUSINESS_FIELD_MAX,
  BUSINESS_ROLES,
  BUSINESS_ROLE_LABEL,
  BUSINESS_SECTORS,
  BUSINESS_TYPES,
  VAT_FILING_PERIODS,
  VAT_FILING_PERIOD_LABEL,
  WIZARD_STEPS,
  validateWizardStep,
  type BankingPreference,
  type BusinessType,
  type BusinessWizardData,
  type FieldErrors,
  type WizardStep,
} from "@shared/businesses";
import {
  useBusinessDraft,
  useBusinessPortfolio,
  useCreateBusiness,
  useDiscardBusinessDraft,
  useSaveBusinessDraft,
} from "@/lib/businesses";

// Full-page, four-step Add Business wizard. Progress autosaves to the
// server-side draft (debounced), so leaving and coming back resumes where the
// user was. Submission is idempotent (one submissionId per wizard session).

const TYPE_LABEL: Record<BusinessType, string> = {
  LIMITED_COMPANY: "Limited company",
  SELF_EMPLOYED: "Self-employed (sole trader)",
  PARTNERSHIP: "Partnership",
};

const STEP_COPY: Record<WizardStep, { heading: string; sub: string }> = {
  1: { heading: "Business details", sub: "Tell us what kind of business it is." },
  2: {
    heading: "Activity & tax",
    sub: "This sets your default categories and the VAT card on your dashboard.",
  },
  3: { heading: "Your role & share", sub: "How you're involved, and how much you own." },
  4: { heading: "Money & accountant", sub: "Where the business's money comes in and goes out." },
};

const STEPPER_LABEL = ["Type & name", "Activity & tax", "Role & share", "Money"];

const BANK_OPTIONS: { value: Exclude<BankingPreference, "NONE">; title: string; hint: string }[] = [
  {
    value: "PAYABL_ACCOUNT",
    title: "Open a business account",
    hint: "IBAN and card with our banking partner payabl.",
  },
  { value: "OPEN_BANKING", title: "Connect an existing bank", hint: "Bank feed via open banking" },
  { value: "BOTH", title: "Both", hint: "New account plus your existing bank" },
];

const DEFAULTS: BusinessWizardData = {
  businessType: "LIMITED_COMPANY",
  country: "CY",
  financialYearEnd: "12-31",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// Country-specific formats. Countries without an entry only get the
// required check.
const REG_FORMAT: Record<string, { re: RegExp; example: string }> = {
  CY: { re: /^(HE|AE|P)\s?\d{1,8}$/i, example: "HE 412345" },
};
const VAT_FORMAT: Record<string, { re: RegExp; example: string }> = {
  CY: { re: /^CY\s?\d{8}[A-Z]$/i, example: "CY10412345X" },
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const INPUT =
  "h-12 w-full rounded-2xl bg-[#1C2325] px-4 text-sm text-[#F4F4F2] placeholder:text-[#7D8287] [color-scheme:dark] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78C68] aria-[invalid=true]:outline aria-[invalid=true]:outline-1 aria-[invalid=true]:outline-[#FF7A7A]";

function newSubmissionId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

const needsRegistration = (d: BusinessWizardData) => d.businessType !== "SELF_EMPLOYED";
const needsShare = (d: BusinessWizardData) => d.role === "SHAREHOLDER" || d.role === "BOTH";

// Spec validation (copy + format rules) layered on top of the shared rules,
// which still guard the server contract (lengths, enums, etc.).
function validateStep(
  step: WizardStep,
  d: BusinessWizardData,
  existingNames: string[],
): FieldErrors {
  const e: FieldErrors = { ...validateWizardStep(step, d) };
  const put = (k: keyof BusinessWizardData, msg: string | null) => {
    if (msg) e[k] = msg;
    else delete e[k];
  };

  if (step === 1) {
    put("businessType", d.businessType ? null : "Select a business type.");
    const name = d.legalName?.trim() ?? "";
    put(
      "legalName",
      name.length < 2 || name.length > 100
        ? "Enter the business's legal name."
        : existingNames.includes(name.toLowerCase())
          ? "This business is already in your portfolio."
          : null,
    );
    if (!e.tradingName) delete e.tradingName;
    put("country", d.country ? null : "Select a country.");
    if (needsRegistration(d)) {
      const reg = d.registrationNumber?.trim() ?? "";
      const fmt = d.country ? REG_FORMAT[d.country] : undefined;
      put(
        "registrationNumber",
        !reg
          ? "Enter the registration number."
          : fmt && !fmt.re.test(reg)
            ? `Enter a valid registration number, e.g. ${fmt.example}.`
            : (e.registrationNumber ?? null),
      );
    } else {
      put("registrationNumber", null);
    }
  }

  if (step === 2) {
    put("sector", d.sector ? null : "Select what the business does.");
    put(
      "vatRegistered",
      typeof d.vatRegistered === "boolean"
        ? null
        : "Tell us if the business is registered for VAT.",
    );
    if (d.vatRegistered) {
      const vat = d.vatNumber?.trim() ?? "";
      const fmt = d.country ? VAT_FORMAT[d.country] : undefined;
      put(
        "vatNumber",
        !vat
          ? "Enter the VAT number."
          : fmt && !fmt.re.test(vat)
            ? `Enter a valid VAT number, e.g. ${fmt.example}.`
            : (e.vatNumber ?? null),
      );
      put("vatFilingPeriod", d.vatFilingPeriod ? null : "Select a filing period.");
    }
    if (e.financialYearEnd) e.financialYearEnd = "Select the financial year end.";
  }

  if (step === 3) {
    put("role", d.role ? null : "Select your role.");
    const s = d.sharePercent;
    if (needsShare(d) || typeof s === "number") {
      put(
        "sharePercent",
        typeof s !== "number" || Number.isNaN(s)
          ? needsShare(d)
            ? "Enter your share."
            : null
          : !Number.isFinite(s) || s < 0.01 || s > 100
            ? "Share must be between 0% and 100%."
            : (e.sharePercent ?? null),
      );
    }
  }

  if (step === 4) {
    put(
      "bankingPreference",
      d.bankingPreference && d.bankingPreference !== "NONE"
        ? null
        : "Choose how this business handles money.",
    );
    const email = d.accountantEmail?.trim();
    put(
      "accountantEmail",
      email && !EMAIL_RE.test(email) ? "Enter a valid email address." : (e.accountantEmail ?? null),
    );
  }

  return e;
}

function submitErrorMessage(err: unknown): string {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return "You're offline. Check your connection and try again.";
  }
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (/^401\b/.test(msg)) return "Your session has expired. Please log in again.";
  if (/^409\b/.test(msg)) return "This business is already in your portfolio.";
  return "We couldn't add the business. Please try again.";
}

function Field({
  id,
  label,
  optional,
  helper,
  error,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  helper?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-xs font-medium text-[#A3A7AB]">
        {label}
        {optional && <span className="text-[#7D8287]"> (optional)</span>}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-[#FF7A7A]">
          {error}
        </p>
      ) : (
        helper && <p className="text-xs text-[#7D8287]">{helper}</p>
      )}
    </div>
  );
}

function FieldError({ id, error }: { id: string; error?: string }) {
  if (!error) return null;
  return (
    <p id={`${id}-error`} className="text-xs text-[#FF7A7A]">
      {error}
    </p>
  );
}

function Choice({
  selected,
  onSelect,
  title,
  hint,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex items-center gap-3 rounded-2xl px-4 py-3.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78C68]",
        selected ? "bg-[#2A3134]" : "bg-[#1C2325] hover:bg-[#232B2E]",
      )}
    >
      <span
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
          selected ? "bg-[#E2F645] text-[#060A0B]" : "bg-white/[0.08]",
        )}
      >
        {selected && <Check size={12} aria-hidden="true" />}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-[#F4F4F2]">{title}</span>
        {hint && <span className="block text-xs text-[#A3A7AB]">{hint}</span>}
      </span>
    </button>
  );
}

function Segment({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "min-h-10 flex-1 rounded-xl px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78C68]",
        selected ? "bg-[#E2F645] text-[#060A0B]" : "text-[#F4F4F2] hover:bg-[#2A3134]",
      )}
    >
      {children}
    </button>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="flex gap-2.5 rounded-2xl bg-[#73C2CD]/10 px-4 py-3 text-xs leading-relaxed text-[#A3A7AB]">
      <Info size={14} className="mt-0.5 shrink-0 text-[#73C2CD]" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function Stepper({ step, done }: { step: WizardStep; done?: boolean }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-3 gap-y-2" aria-label="Progress">
      {WIZARD_STEPS.map((s, i) => {
        const complete = done || s.id < step;
        const current = !done && s.id === step;
        return (
          <li key={s.id} className="flex items-center gap-2">
            <span
              className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                complete
                  ? "bg-[#7BD88F] text-[#060A0B]"
                  : current
                    ? "bg-[#E2F645] text-[#060A0B]"
                    : "bg-[#1C2325] text-[#7D8287]",
              )}
              aria-hidden="true"
            >
              {complete ? <Check size={12} /> : s.id}
            </span>
            <span className={cn("text-xs", current ? "text-[#F4F4F2]" : "text-[#7D8287]")}>
              {STEPPER_LABEL[i]}
              <span className="sr-only">{complete ? " (done)" : current ? " (current)" : ""}</span>
            </span>
            {i < WIZARD_STEPS.length - 1 && (
              <span className="hidden text-[#3A4245] sm:inline" aria-hidden="true">
                ·
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ConfirmDiscard({
  onKeep,
  onDiscard,
  busy,
}: {
  onKeep: () => void;
  onDiscard: () => void;
  busy: boolean;
}) {
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    keepRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onKeep();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKeep]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={onKeep}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="discard-title"
        aria-describedby="discard-desc"
        className="w-full max-w-[400px] rounded-[24px] bg-[#111618] p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="discard-title" className="text-lg font-semibold">
          Discard this business?
        </h2>
        <p id="discard-desc" className="mt-2 text-sm text-[#A3A7AB]">
          Your details won't be saved.
        </p>
        <div className="mt-6 flex gap-3">
          <button
            ref={keepRef}
            type="button"
            onClick={onKeep}
            className="h-11 flex-1 rounded-full bg-white/[0.08] text-sm font-semibold hover:bg-white/[0.12]"
          >
            Keep editing
          </button>
          <button
            type="button"
            onClick={onDiscard}
            disabled={busy}
            className="flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-[#FF7A7A] text-sm font-semibold text-[#060A0B] hover:brightness-95 disabled:opacity-60"
          >
            {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}

function SuccessScreen({ business }: { business: Entity }) {
  const name = business.name;
  const pref = business.bankingPreference ?? "NONE";
  const status = business.bankingStatus ?? "NOT_STARTED";
  const opensAccount = pref === "PAYABL_ACCOUNT" || pref === "BOTH";
  const applicationStarted = status === "PENDING_PROVIDER" || status === "ACTIVE";

  let message: ReactNode;
  if (opensAccount && applicationStarted) {
    message = (
      <>
        {name} is in your business portfolio. Your business account application has started; finish
        verification with our banking partner when you're ready.
        {pref === "BOTH" && " Connect your existing bank from the business page."}
      </>
    );
  } else if (opensAccount) {
    message = `${name} is in your business portfolio. We saved your banking choice and will ask you to finish the account application once it's available.`;
  } else if (pref === "OPEN_BANKING") {
    message = `${name} is in your business portfolio. Connect your bank to start seeing transactions.`;
  } else {
    message = `${name} is in your business portfolio.`;
  }

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-10 px-4 py-10 sm:px-6">
      <Stepper step={4} done />
      <div className="flex flex-col items-center text-center">
        <CheckCircle2 size={48} className="text-[#7BD88F]" aria-hidden="true" />
        <h1 className="mt-5 text-[28px] font-semibold tracking-[-0.02em]">Business added</h1>
        <p className="mt-3 max-w-[480px] text-sm leading-relaxed text-[#A3A7AB]" role="status">
          {message}
        </p>
        <Link
          href={`/business/${encodeURIComponent(business.id)}`}
          className="mt-8 flex h-12 w-full max-w-[320px] items-center justify-center rounded-full bg-white text-sm font-semibold text-[#060A0B] hover:brightness-95"
        >
          Open business
        </Link>
      </div>
    </div>
  );
}

export default function AddBusinessWizard() {
  const [, setLocation] = useLocation();
  const draftQuery = useBusinessDraft();
  const saveDraft = useSaveBusinessDraft();
  const discardDraft = useDiscardBusinessDraft();
  const create = useCreateBusiness();
  const portfolio = useBusinessPortfolio({ q: "", ownership: "all", view: "active" });

  const [step, setStep] = useState<WizardStep>(1);
  const [data, setData] = useState<BusinessWizardData>(DEFAULTS);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [resumed, setResumed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [created, setCreated] = useState<Entity | null>(null);
  const [shareText, setShareText] = useState("");
  const submissionId = useRef(newSubmissionId());
  const hydrated = useRef(false);

  const existingNames = useMemo(
    () =>
      (portfolio.data?.businesses ?? []).flatMap((b) =>
        [b.name, b.legalName].filter((n): n is string => !!n).map((n) => n.trim().toLowerCase()),
      ),
    [portfolio.data],
  );
  const ownsOtherBusinesses = (portfolio.data?.counts.active ?? 0) > 0;

  // Resume a saved draft once.
  useEffect(() => {
    if (hydrated.current || !draftQuery.isFetched) return;
    hydrated.current = true;
    const d = draftQuery.data?.draft;
    if (d && Object.keys(d.data).length > 0) {
      setData({ ...DEFAULTS, ...d.data });
      setStep(d.step);
      setShareText(d.data.sharePercent != null ? String(d.data.sharePercent) : "");
      setResumed(true);
      setDirty(true);
    }
  }, [draftQuery.isFetched, draftQuery.data]);

  // Debounced autosave of progress (only once the user has entered something).
  const saveRef = useRef(saveDraft.mutate);
  saveRef.current = saveDraft.mutate;
  useEffect(() => {
    if (!hydrated.current || created || !dirty) return;
    const t = setTimeout(() => saveRef.current({ step, data }), 800);
    return () => clearTimeout(t);
  }, [step, data, created, dirty]);

  const update = (patch: Partial<BusinessWizardData>) => {
    setData((d) => ({ ...d, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(patch) as (keyof BusinessWizardData)[]) delete next[k];
      return next;
    });
    setDirty(true);
  };
  const set = <K extends keyof BusinessWizardData>(k: K, v: BusinessWizardData[K]) =>
    update({ [k]: v } as Partial<BusinessWizardData>);

  const go = (s: WizardStep) => {
    setErrors({});
    setSubmitError(null);
    setStep(s);
    window.scrollTo({ top: 0 });
  };

  const onContinue = () => {
    const e = validateStep(step, data, existingNames);
    if (Object.keys(e).length) {
      setErrors(e);
      const first = Object.keys(e)[0];
      document.getElementById(`biz-${first}`)?.focus();
      return;
    }
    if (step < 4) return go((step + 1) as WizardStep);
    if (create.isPending) return;
    setSubmitError(null);
    const payload: BusinessWizardData = {
      ...data,
      legalName: data.legalName?.trim(),
      tradingName: data.tradingName?.trim() || data.legalName?.trim(),
      registrationNumber: needsRegistration(data) ? data.registrationNumber?.trim() : undefined,
      vatNumber: data.vatRegistered ? data.vatNumber?.trim().toUpperCase() : undefined,
      vatFilingPeriod: data.vatRegistered ? data.vatFilingPeriod : undefined,
      accountantEmail: data.accountantEmail?.trim() || undefined,
    };
    create.mutate(
      { submissionId: submissionId.current, data: payload },
      {
        onSuccess: (b) => setCreated(b),
        onError: (err) => setSubmitError(submitErrorMessage(err)),
      },
    );
  };

  const leave = () => {
    if (created || !dirty) return setLocation("/business");
    setConfirmOpen(true);
  };
  const discard = () =>
    discardDraft.mutate(undefined, {
      onSettled: () => {
        setConfirmOpen(false);
        setLocation("/business");
      },
    });

  const err = (k: keyof BusinessWizardData) => errors[k];
  const aria = (k: keyof BusinessWizardData) => ({
    id: `biz-${k}`,
    "aria-invalid": !!errors[k],
    "aria-describedby": errors[k] ? `biz-${k}-error` : undefined,
  });

  const [yeMonth, yeDay] = useMemo(() => {
    const [m, d] = (data.financialYearEnd ?? "").split("-");
    return [m ?? "", d ?? ""];
  }, [data.financialYearEnd]);
  const setYearEnd = (m: string, d: string) => {
    if (!m) return set("financialYearEnd", undefined);
    const max = DAYS_IN_MONTH[Number(m) - 1];
    const day = d && Number(d) <= max ? d : String(max).padStart(2, "0");
    set("financialYearEnd", `${m}-${day}`);
  };

  const regExample = (data.country && REG_FORMAT[data.country]?.example) || "HE 412345";
  const vatExample = (data.country && VAT_FORMAT[data.country]?.example) || "CY10412345X";
  const saveState = saveDraft.isPending
    ? "Saving…"
    : saveDraft.isError
      ? "Couldn't save draft"
      : saveDraft.isSuccess
        ? "Draft saved"
        : "";
  const copy = STEP_COPY[step];

  return (
    <div className="min-h-dvh bg-[#060A0B] text-[#F4F4F2]">
      <header className="mx-auto flex w-full max-w-[960px] items-center justify-between gap-4 px-4 pt-6 sm:px-6">
        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-[#A3A7AB]">
          <Link href="/business" className="hover:text-[#F4F4F2]">
            Portfolio
          </Link>
          <span aria-hidden="true">›</span>
          <span className="text-[#F4F4F2]" aria-current="page">
            Add business
          </span>
        </nav>
        <div className="flex items-center gap-3">
          {!created && (
            <span className="hidden text-xs text-[#7D8287] sm:inline" aria-live="polite">
              {saveState}
            </span>
          )}
          <button
            type="button"
            onClick={leave}
            aria-label="Close"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-[#1C2325] hover:bg-[#2A3134] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78C68]"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </header>

      {created ? (
        <SuccessScreen business={created} />
      ) : draftQuery.isLoading ? (
        <div className="flex justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-[#7D8287]" aria-label="Loading" />
        </div>
      ) : (
        <main className="mx-auto flex w-full max-w-[640px] flex-col gap-8 px-4 py-10 sm:px-6">
          <div>
            <h1 className="text-[28px] font-semibold tracking-[-0.02em]">Add business</h1>
            <p className="mt-1 text-sm text-[#A3A7AB]">
              About 3 minutes. You can finish the details later.
            </p>
            {resumed && step === (draftQuery.data?.draft?.step ?? 0) && (
              <p className="mt-2 text-sm text-[#A3A7AB]">
                We picked up where you left off.{" "}
                <button
                  type="button"
                  className="font-semibold text-[#73C2CD] hover:underline"
                  onClick={() => {
                    setData(DEFAULTS);
                    setShareText("");
                    setResumed(false);
                    go(1);
                  }}
                >
                  Start over
                </button>
              </p>
            )}
            <div className="mt-6">
              <Stepper step={step} />
            </div>
            <p className="mt-6 text-xs font-medium text-[#7D8287]">Step {step} of 4</p>
            <h2 className="mt-1 text-xl font-semibold">{copy.heading}</h2>
            <p className="mt-1 text-sm text-[#A3A7AB]">{copy.sub}</p>
          </div>

          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              onContinue();
            }}
            className="flex flex-col gap-6"
          >
            {step === 1 && (
              <>
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-2 text-xs font-medium text-[#A3A7AB]">Business type</legend>
                  <div
                    id="biz-businessType"
                    tabIndex={-1}
                    role="radiogroup"
                    aria-describedby={err("businessType") ? "biz-businessType-error" : undefined}
                    className="flex flex-col gap-1 rounded-2xl bg-[#1C2325] p-1 sm:flex-row"
                  >
                    {BUSINESS_TYPES.map((t) => (
                      <Segment
                        key={t}
                        selected={data.businessType === t}
                        onSelect={() =>
                          update(
                            t === "SELF_EMPLOYED"
                              ? { businessType: t, registrationNumber: undefined }
                              : { businessType: t },
                          )
                        }
                      >
                        {TYPE_LABEL[t]}
                      </Segment>
                    ))}
                  </div>
                  <FieldError id="biz-businessType" error={err("businessType")} />
                  <p className="text-xs text-[#7D8287]">
                    Self-employed? No registration number or directors needed; we'll skip those.
                  </p>
                </fieldset>
                <Field id="biz-legalName" label="Legal name" error={err("legalName")}>
                  <input
                    {...aria("legalName")}
                    className={INPUT}
                    value={data.legalName ?? ""}
                    maxLength={Math.min(100, BUSINESS_FIELD_MAX.legalName)}
                    onChange={(e) => set("legalName", e.target.value)}
                    placeholder={
                      data.businessType === "SELF_EMPLOYED" ? "Your full name" : "Acme Holdings Ltd"
                    }
                  />
                </Field>
                <Field
                  id="biz-tradingName"
                  label="Trading name"
                  optional
                  helper="Leave blank to use the legal name."
                  error={err("tradingName")}
                >
                  <input
                    {...aria("tradingName")}
                    className={INPUT}
                    value={data.tradingName ?? ""}
                    maxLength={BUSINESS_FIELD_MAX.tradingName}
                    onChange={(e) => set("tradingName", e.target.value)}
                    placeholder={data.legalName?.trim() || "Acme"}
                  />
                </Field>
                <Field id="biz-country" label="Country" error={err("country")}>
                  <select
                    {...aria("country")}
                    className={INPUT}
                    value={data.country ?? ""}
                    onChange={(e) => set("country", e.target.value || undefined)}
                  >
                    <option value="">Select a country</option>
                    {BUSINESS_COUNTRIES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
                {needsRegistration(data) && (
                  <Field
                    id="biz-registrationNumber"
                    label="Registration number"
                    error={err("registrationNumber")}
                  >
                    <input
                      {...aria("registrationNumber")}
                      className={INPUT}
                      value={data.registrationNumber ?? ""}
                      maxLength={BUSINESS_FIELD_MAX.registrationNumber}
                      onChange={(e) => set("registrationNumber", e.target.value.toUpperCase())}
                      placeholder={regExample}
                    />
                  </Field>
                )}
              </>
            )}

            {step === 2 && (
              <>
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-2 text-xs font-medium text-[#A3A7AB]">
                    What does the business do?
                  </legend>
                  <div
                    id="biz-sector"
                    tabIndex={-1}
                    className="flex flex-wrap gap-2"
                    role="radiogroup"
                    aria-describedby={err("sector") ? "biz-sector-error" : undefined}
                  >
                    {BUSINESS_SECTORS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        role="radio"
                        aria-checked={data.sector === s}
                        onClick={() => set("sector", s)}
                        className={cn(
                          "h-10 rounded-full px-4 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78C68]",
                          data.sector === s
                            ? "bg-[#E2F645] text-[#060A0B]"
                            : "bg-[#1C2325] text-[#F4F4F2] hover:bg-[#2A3134]",
                        )}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                  <FieldError id="biz-sector" error={err("sector")} />
                </fieldset>

                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-2 text-xs font-medium text-[#A3A7AB]">
                    Registered for VAT?
                  </legend>
                  <div
                    id="biz-vatRegistered"
                    tabIndex={-1}
                    className="grid grid-cols-2 gap-2"
                    role="radiogroup"
                    aria-describedby={err("vatRegistered") ? "biz-vatRegistered-error" : undefined}
                  >
                    <Choice
                      selected={data.vatRegistered === true}
                      onSelect={() =>
                        update({
                          vatRegistered: true,
                          vatFilingPeriod: data.vatFilingPeriod ?? "QUARTERLY",
                        })
                      }
                      title="Yes"
                    />
                    <Choice
                      selected={data.vatRegistered === false}
                      onSelect={() => set("vatRegistered", false)}
                      title="No"
                    />
                  </div>
                  <FieldError id="biz-vatRegistered" error={err("vatRegistered")} />
                </fieldset>

                {data.vatRegistered && (
                  <>
                    <Field id="biz-vatNumber" label="VAT number" error={err("vatNumber")}>
                      <input
                        {...aria("vatNumber")}
                        className={INPUT}
                        value={data.vatNumber ?? ""}
                        maxLength={BUSINESS_FIELD_MAX.vatNumber}
                        onChange={(e) => set("vatNumber", e.target.value.toUpperCase())}
                        placeholder={vatExample}
                      />
                    </Field>
                    <Field
                      id="biz-vatFilingPeriod"
                      label="Filing period"
                      error={err("vatFilingPeriod")}
                    >
                      <select
                        {...aria("vatFilingPeriod")}
                        className={INPUT}
                        value={data.vatFilingPeriod ?? ""}
                        onChange={(e) =>
                          set(
                            "vatFilingPeriod",
                            (e.target.value || undefined) as BusinessWizardData["vatFilingPeriod"],
                          )
                        }
                      >
                        <option value="">Select a filing period</option>
                        {VAT_FILING_PERIODS.map((p) => (
                          <option key={p} value={p}>
                            {VAT_FILING_PERIOD_LABEL[p]}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </>
                )}

                <Field
                  id="biz-financialYearEnd"
                  label="Financial year end"
                  error={err("financialYearEnd")}
                >
                  <div className="grid grid-cols-2 gap-2">
                    <select
                      {...aria("financialYearEnd")}
                      aria-label="Day"
                      className={INPUT}
                      value={yeDay}
                      disabled={!yeMonth}
                      onChange={(e) => setYearEnd(yeMonth, e.target.value)}
                    >
                      {Array.from(
                        { length: yeMonth ? DAYS_IN_MONTH[Number(yeMonth) - 1] : 31 },
                        (_, i) => (
                          <option key={i} value={String(i + 1).padStart(2, "0")}>
                            {i + 1}
                          </option>
                        ),
                      )}
                    </select>
                    <select
                      aria-label="Month"
                      className={INPUT}
                      value={yeMonth}
                      onChange={(e) => setYearEnd(e.target.value, yeDay)}
                    >
                      <option value="">Month</option>
                      {MONTHS.map((m, i) => (
                        <option key={m} value={String(i + 1).padStart(2, "0")}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                </Field>
              </>
            )}

            {step === 3 && (
              <>
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-2 text-xs font-medium text-[#A3A7AB]">Your role</legend>
                  <div
                    id="biz-role"
                    tabIndex={-1}
                    className="flex flex-col gap-2"
                    role="radiogroup"
                    aria-describedby={err("role") ? "biz-role-error" : undefined}
                  >
                    {BUSINESS_ROLES.map((r) => (
                      <Choice
                        key={r}
                        selected={data.role === r}
                        onSelect={() => {
                          if (r === "DIRECTOR") {
                            setShareText("");
                            update({ role: r, sharePercent: undefined });
                          } else {
                            set("role", r);
                          }
                        }}
                        title={BUSINESS_ROLE_LABEL[r]}
                      />
                    ))}
                  </div>
                  <FieldError id="biz-role" error={err("role")} />
                </fieldset>
                {needsShare(data) && (
                  <Field
                    id="biz-sharePercent"
                    label="Your share"
                    helper="Under 100%? You'll add the other shareholders next."
                    error={err("sharePercent")}
                  >
                    <div className="relative">
                      <input
                        {...aria("sharePercent")}
                        className={cn(INPUT, "pr-10")}
                        inputMode="decimal"
                        value={shareText}
                        onChange={(e) => {
                          const v = e.target.value.replace(",", ".");
                          setShareText(v);
                          set("sharePercent", v.trim() === "" ? undefined : Number(v));
                        }}
                        placeholder="100"
                      />
                      <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm text-[#7D8287]">
                        %
                      </span>
                    </div>
                  </Field>
                )}
                {ownsOtherBusinesses && (
                  <Note>
                    You own other companies here, so money moving between them is tagged as a
                    transfer, not revenue.
                  </Note>
                )}
              </>
            )}

            {step === 4 && (
              <>
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-2 text-xs font-medium text-[#A3A7AB]">
                    Business account
                  </legend>
                  <div
                    id="biz-bankingPreference"
                    tabIndex={-1}
                    className="flex flex-col gap-2"
                    role="radiogroup"
                    aria-describedby={
                      err("bankingPreference") ? "biz-bankingPreference-error" : undefined
                    }
                  >
                    {BANK_OPTIONS.map((o) => (
                      <Choice
                        key={o.value}
                        selected={data.bankingPreference === o.value}
                        onSelect={() => set("bankingPreference", o.value)}
                        title={o.title}
                        hint={o.hint}
                      />
                    ))}
                  </div>
                  <FieldError id="biz-bankingPreference" error={err("bankingPreference")} />
                </fieldset>
                <Field
                  id="biz-accountantEmail"
                  label="Accountant's email"
                  optional
                  helper="So the accountant pack has somewhere to go. You can add it later."
                  error={err("accountantEmail")}
                >
                  <input
                    {...aria("accountantEmail")}
                    type="email"
                    autoComplete="off"
                    className={INPUT}
                    value={data.accountantEmail ?? ""}
                    maxLength={BUSINESS_FIELD_MAX.accountantEmail}
                    onChange={(e) => set("accountantEmail", e.target.value)}
                    placeholder="accountant@firm.com"
                  />
                </Field>
              </>
            )}

            {submitError && (
              <p
                role="alert"
                className="rounded-2xl bg-[#FF7A7A]/10 px-4 py-3 text-sm text-[#FF7A7A]"
              >
                {submitError}
              </p>
            )}

            <div className="flex items-center justify-between gap-3 pt-2">
              {step === 1 ? (
                <button
                  type="button"
                  onClick={leave}
                  className="h-12 rounded-full bg-white/[0.08] px-6 text-sm font-semibold hover:bg-white/[0.12]"
                >
                  Cancel
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => go((step - 1) as WizardStep)}
                  disabled={create.isPending}
                  className="h-12 rounded-full bg-white/[0.08] px-6 text-sm font-semibold hover:bg-white/[0.12] disabled:opacity-60"
                >
                  Back
                </button>
              )}
              <button
                type="submit"
                disabled={create.isPending}
                aria-busy={create.isPending}
                className="flex h-12 min-w-[140px] items-center justify-center gap-2 rounded-full bg-white px-6 text-sm font-semibold text-[#060A0B] hover:brightness-95 disabled:opacity-60"
              >
                {create.isPending && (
                  <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                )}
                {step < 4 ? "Continue" : "Add business"}
              </button>
            </div>
          </form>
        </main>
      )}

      {confirmOpen && (
        <ConfirmDiscard
          onKeep={() => setConfirmOpen(false)}
          onDiscard={discard}
          busy={discardDraft.isPending}
        />
      )}
    </div>
  );
}
