import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle, Banknote, Building2, Percent } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@ui/components/ui/card";
import { Input } from "@ui/components/ui/input";
import { Label } from "@ui/components/ui/label";
import { Slider } from "@ui/components/ui/slider";
import { Switch } from "@ui/components/ui/switch";

export type CalcMode = "buy" | "sell";

export function CalculatorModeToggle({
  mode,
  setMode,
  variant = "desktop",
}: {
  mode: CalcMode;
  setMode: (m: CalcMode) => void;
  variant?: "desktop" | "mobile";
}) {
  if (variant === "mobile") {
    return (
      <div className="bg-secondary/30 dark:bg-secondary/20 p-1.5 rounded-2xl inline-flex shadow-sm border border-border/40 w-full mt-6">
        <button
          onClick={() => setMode("buy")}
          className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-all ${mode === "buy" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          Buy
        </button>
        <button
          onClick={() => setMode("sell")}
          className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-all ${mode === "sell" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          Sell
        </button>
      </div>
    );
  }
  return (
    <div className="bg-secondary/30 dark:bg-secondary/20 p-1 rounded-xl inline-flex border border-border/40">
      <button
        onClick={() => setMode("buy")}
        className={`px-6 py-1.5 rounded-lg text-sm font-bold transition-all ${mode === "buy" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
      >
        Buy
      </button>
      <button
        onClick={() => setMode("sell")}
        className={`px-6 py-1.5 rounded-lg text-sm font-bold transition-all ${mode === "sell" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
      >
        Sell
      </button>
    </div>
  );
}

export function CalculatorBody({
  mode,
  setMode,
}: {
  mode: CalcMode;
  setMode: (m: CalcMode) => void;
}) {
  return (
    <div className="flex-1 h-full">
      {/* Mobile Header Text */}
      <div className="md:hidden pt-[var(--mobile-header-clearance)] px-6 mb-6">
        <h1 className="text-2xl font-bold text-foreground tracking-tight">Smart Calculator</h1>
        <p className="text-muted-foreground mt-1 text-sm">Real estate investment & tax analysis</p>
        <CalculatorModeToggle mode={mode} setMode={setMode} variant="mobile" />
      </div>

      <div className="p-6 md:p-8">
        <AnimatePresence mode="wait">
          {mode === "buy" ? (
            <motion.div
              key="buy"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0.2 }}
            >
              <BuyCalculator />
            </motion.div>
          ) : (
            <motion.div
              key="sell"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }}
            >
              <SellCalculator />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function BuyCalculator() {
  const [acquisitionPrice, setAcquisitionPrice] = useState(200000);
  const [acquisitionCosts, setAcquisitionCosts] = useState(4000);
  const [potentialCapex, setPotentialCapex] = useState(0);
  const [monthlyIncome, setMonthlyIncome] = useState(1300);
  const [occupancyRate] = useState(100);
  const [operatingExpensesPercent] = useState(0);

  const [isNewAsset, setIsNewAsset] = useState(true);
  const [isPrimaryResidence, setIsPrimaryResidence] = useState(true);
  const [areaSqm, setAreaSqm] = useState(150);

  const [useFinancing, setUseFinancing] = useState(true);
  const [ltv, setLtv] = useState(70);
  const [interestRate, setInterestRate] = useState(5);
  const [loanTerm, setLoanTerm] = useState(20);

  let vat = 0;
  if (isNewAsset) {
    if (isPrimaryResidence) {
      const pricePerSqm = acquisitionPrice / (areaSqm || 1);
      const reducedArea = Math.min(areaSqm, 130);
      const standardArea = Math.max(0, areaSqm - 130);
      const vatReduced = pricePerSqm * reducedArea * 0.05;
      const vatStandard = pricePerSqm * standardArea * 0.19;
      vat = vatReduced + vatStandard;
    } else {
      vat = acquisitionPrice * 0.19;
    }
  }

  let transferTax = 0;
  if (!isNewAsset) {
    const tier1Limit = 85000;
    const tier2Limit = 170000;
    let remainingPrice = acquisitionPrice;
    const amountTier1 = Math.min(remainingPrice, tier1Limit);
    transferTax += amountTier1 * 0.03;
    remainingPrice -= amountTier1;
    if (remainingPrice > 0) {
      const amountTier2 = Math.min(remainingPrice, tier2Limit - tier1Limit);
      transferTax += amountTier2 * 0.05;
      remainingPrice -= amountTier2;
    }
    if (remainingPrice > 0) {
      transferTax += remainingPrice * 0.08;
    }
    transferTax = transferTax * 0.5;
  }

  let stampDuty = 0;
  let remainingStampVal = acquisitionPrice;
  const stampTier1 = 5000;
  const stampTier2 = 170000;
  const stampAmt1 = Math.min(remainingStampVal, stampTier1);
  remainingStampVal -= stampAmt1;
  if (remainingStampVal > 0) {
    const stampAmt2 = Math.min(remainingStampVal, stampTier2 - stampTier1);
    stampDuty += stampAmt2 * 0.0015;
    remainingStampVal -= stampAmt2;
  }
  if (remainingStampVal > 0) {
    stampDuty += remainingStampVal * 0.002;
  }

  const totalTax = vat + transferTax + stampDuty;
  const acquisitionCostsTotal = acquisitionCosts;
  const totalInvestment = acquisitionPrice + acquisitionCostsTotal + totalTax + potentialCapex;

  const loanAmount = useFinancing ? totalInvestment * (ltv / 100) : 0;
  const equityNeeded = totalInvestment - loanAmount;

  const monthlyRate = interestRate / 100 / 12;
  const numberOfPayments = loanTerm * 12;
  let monthlyPayment = 0;
  if (useFinancing && loanAmount > 0 && interestRate > 0) {
    monthlyPayment =
      (loanAmount * monthlyRate * Math.pow(1 + monthlyRate, numberOfPayments)) /
      (Math.pow(1 + monthlyRate, numberOfPayments) - 1);
  } else if (useFinancing && loanAmount > 0 && interestRate === 0) {
    monthlyPayment = loanAmount / numberOfPayments;
  }

  const grossAnnualIncome = monthlyIncome * 12 * (occupancyRate / 100);
  const operatingExpenses = grossAnnualIncome * (operatingExpensesPercent / 100);
  const netOperatingIncome = grossAnnualIncome - operatingExpenses;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-10 items-start">
      <div className="lg:col-span-7 space-y-6">
        <Card className="border-border bg-card shadow-sm rounded-2xl">
          <CardHeader className="pb-3 p-6 border-b border-border/30">
            <CardTitle className="flex items-center gap-2 text-base font-bold">
              <Banknote className="w-5 h-5" />
              Financial Inputs
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6 space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <InputGroup
                label="Acquisition Price (€)"
                value={acquisitionPrice}
                setValue={setAcquisitionPrice}
                min={0}
                step={1000}
              />
              <InputGroup
                label="Acquisition Costs (€)"
                value={acquisitionCosts}
                setValue={setAcquisitionCosts}
                min={0}
                step={100}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <InputGroup
                label="Potential Capex (€)"
                value={potentialCapex}
                setValue={setPotentialCapex}
                min={0}
                step={1000}
              />
            </div>
            {useFinancing && (
              <div className="pt-2">
                <div className="flex justify-between items-end mb-3">
                  <Label className="text-sm font-semibold">Cash Downpayment</Label>
                  <div className="text-sm font-bold">
                    €{Math.round(totalInvestment * (1 - ltv / 100)).toLocaleString()} ({100 - ltv}%)
                  </div>
                </div>
                <Slider
                  value={[100 - ltv]}
                  onValueChange={(vals) => setLtv(100 - vals[0])}
                  max={100}
                  step={1}
                  className="py-2"
                />
                <p className="text-[11px] text-muted-foreground mt-3">
                  Adjusts your loan-to-value (LTV). Higher downpayment means a smaller loan.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-border bg-card shadow-sm rounded-2xl">
          <CardHeader className="pb-3 p-6 border-b border-border/30">
            <CardTitle className="flex items-center gap-2 text-base font-bold">
              <Building2 className="w-5 h-5" />
              Property Type & Tax
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6 space-y-4">
            <div className="flex items-center justify-between p-4 border border-border rounded-xl">
              <Label className="text-sm font-semibold">New Asset (VAT applies)</Label>
              <Switch checked={isNewAsset} onCheckedChange={setIsNewAsset} />
            </div>
            {isNewAsset && (
              <div className="space-y-4 pl-4 border-l-2 border-border ml-2">
                <div className="flex items-center justify-between p-4 border border-border rounded-xl">
                  <Label className="text-sm font-semibold">Primary Residence</Label>
                  <Switch checked={isPrimaryResidence} onCheckedChange={setIsPrimaryResidence} />
                </div>
                {isPrimaryResidence && (
                  <InputGroup
                    label="Area (sqm)"
                    value={areaSqm}
                    setValue={setAreaSqm}
                    min={1}
                    step={1}
                  />
                )}
                <div className="text-[11px] font-medium bg-info/10 p-4 rounded-xl text-info border border-info/20">
                  {isPrimaryResidence
                    ? "Reduced VAT (5%) applies to first 130 sqm. Standard VAT (19%) on remainder."
                    : "Standard VAT (19%) applies to total value."}
                </div>
              </div>
            )}
            {!isNewAsset && (
              <div className="text-[11px] font-medium bg-success/10 p-4 rounded-xl text-success border border-success/20">
                Transfer Fees apply (3-8% tiered rates) with 50% discount rule. No VAT.
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-border bg-card shadow-sm rounded-2xl">
          <CardHeader className="pb-3 p-6 border-b border-border/30">
            <CardTitle className="flex items-center gap-2 text-base font-bold">
              <Percent className="w-5 h-5" />% Financing
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6 space-y-5">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-semibold">Use Financing</Label>
              <Switch checked={useFinancing} onCheckedChange={setUseFinancing} />
            </div>
            {useFinancing && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5 pt-2">
                <InputGroup
                  label="LTV (%)"
                  value={ltv}
                  setValue={setLtv}
                  min={0}
                  max={100}
                  step={1}
                />
                <InputGroup
                  label="Interest Rate (%)"
                  value={interestRate}
                  setValue={setInterestRate}
                  min={0}
                  max={15}
                  step={0.1}
                />
                <InputGroup
                  label="Loan Term (Years)"
                  value={loanTerm}
                  setValue={setLoanTerm}
                  min={1}
                  max={40}
                  step={1}
                />
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="lg:col-span-5 space-y-6">
        <div className="sticky top-24 space-y-4">
          <div className="flex flex-col sm:flex-row gap-4">
            <Card className="border-border bg-card shadow-sm flex-1 rounded-2xl">
              <CardContent className="p-5 flex flex-col justify-center h-full">
                <Label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-3">
                  Expected
                  <br />
                  Monthly Income
                  <br />
                  (€)
                </Label>
                <Input
                  type="number"
                  value={monthlyIncome}
                  onChange={(e) => setMonthlyIncome(Number(e.target.value))}
                  className="text-xl font-bold border-border h-12 rounded-xl"
                />
              </CardContent>
            </Card>
            <Card className="bg-success border-none shadow-sm flex-1 text-success-foreground rounded-2xl">
              <CardContent className="p-5 flex flex-col justify-center h-full">
                <Label className="text-[10px] font-bold text-success-foreground/90 uppercase tracking-wider mb-3">
                  Net Monthly
                  <br />
                  Income
                  <br />
                  (After Loan)
                </Label>
                <div className="text-3xl font-extrabold tracking-tight">
                  €{Math.round(netOperatingIncome / 12 - monthlyPayment).toLocaleString()}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card className="border-border bg-card shadow-sm w-[48%] rounded-2xl">
            <CardContent className="p-5">
              <Label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-2 block">
                Gross Yield
              </Label>
              <div className="text-2xl font-extrabold tracking-tight">
                {totalInvestment > 0 ? ((grossAnnualIncome / totalInvestment) * 100).toFixed(2) : 0}
                %
              </div>
            </CardContent>
          </Card>

          <Card className="border-border bg-card shadow-sm rounded-2xl mt-6">
            <CardHeader className="pb-3 border-b border-border/30 p-6">
              <CardTitle className="text-base font-bold">Investment Breakdown</CardTitle>
            </CardHeader>
            <CardContent className="p-6 space-y-4">
              <SummaryRow label="Tax Payment" value={totalTax} isCurrency />
              <SummaryRow label="Acquisition Costs" value={acquisitionCostsTotal} isCurrency />
              <SummaryRow label="Potential Capex" value={potentialCapex} isCurrency />
              <div className="my-3 border-t border-border/30" />
              <SummaryRow label="Total Investment" value={totalInvestment} isCurrency bold />
              <div className="my-5 border-t border-border/30 border-dashed" />
              <SummaryRow label="Loan Amount" value={loanAmount} isCurrency />
              <SummaryRow label="Equity Needed" value={equityNeeded} isCurrency bold />
              <SummaryRow label="Monthly Payment" value={monthlyPayment} isCurrency />
              <div className="my-5 border-t border-border/30 border-dashed" />
              <SummaryRow label="Gross Annual Income" value={grossAnnualIncome} isCurrency />
              <SummaryRow
                label="Operating Expenses (Year)"
                value={operatingExpenses}
                isCurrency
                negative
              />
              <SummaryRow label="Net Operating Income" value={netOperatingIncome} isCurrency bold />
            </CardContent>
          </Card>

          <Card className="bg-secondary/10 border-none shadow-sm rounded-2xl">
            <CardContent className="p-6">
              <h4 className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-4">
                Tax Breakdown
              </h4>
              <div className="space-y-3 text-[13px]">
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground font-medium">VAT</span>
                  <span className="font-semibold">€{Math.round(vat).toLocaleString()}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground font-medium">Transfer Tax</span>
                  <span className="font-semibold">€{Math.round(transferTax).toLocaleString()}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground font-medium">Stamp Duty</span>
                  <span className="font-semibold">€{Math.round(stampDuty).toLocaleString()}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function SellCalculator() {
  const [salePrice, setSalePrice] = useState(200000);
  const [acquisitionPrice, setAcquisitionPrice] = useState(100000);
  const [acquisitionYear, setAcquisitionYear] = useState(2020);
  const [indexationRate, setIndexationRate] = useState(2);
  const [taxRate, setTaxRate] = useState(20);

  const [useGeneralExemption, setUseGeneralExemption] = useState(true);
  const [usePrimaryExemption, setUsePrimaryExemption] = useState(false);
  const [useAgriExemption, setUseAgriExemption] = useState(false);

  const currentYear = 2026;
  const holdingPeriod = Math.max(0, currentYear - acquisitionYear);

  const indexedCost = acquisitionPrice * Math.pow(1 + indexationRate / 100, holdingPeriod);

  let totalExemption = 0;
  if (useGeneralExemption) totalExemption += 30000;
  if (usePrimaryExemption) totalExemption += 150000;
  if (useAgriExemption) totalExemption += 50000;

  const rawProfit = salePrice - indexedCost;
  const taxableProfit = Math.max(0, rawProfit - totalExemption);
  const capitalGainsTax = taxableProfit * (taxRate / 100);
  const netProceeds = salePrice - capitalGainsTax;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
      <div className="lg:col-span-7 space-y-8">
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Banknote className="w-5 h-5 text-primary" />
              Disposal Inputs
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <InputGroup
                label="Selling Price (€)"
                value={salePrice}
                setValue={setSalePrice}
                min={0}
                step={1000}
              />
              <InputGroup
                label="Acquisition Price (€)"
                value={acquisitionPrice}
                setValue={setAcquisitionPrice}
                min={0}
                step={1000}
              />
              <InputGroup
                label="Apply Assumed Indexation (%)"
                value={indexationRate}
                setValue={setIndexationRate}
                min={0}
                max={20}
                step={0.1}
              />
              <InputGroup
                label="Capital Gain Tax (%)"
                value={taxRate}
                setValue={setTaxRate}
                min={0}
                max={100}
                step={0.1}
              />
              <InputGroup
                label="Acquisition Year"
                value={acquisitionYear}
                setValue={setAcquisitionYear}
                min={1900}
                max={currentYear}
                step={1}
              />
              <div className="space-y-3">
                <Label>Holding Period (Years)</Label>
                <div className="h-10 flex items-center px-3 border rounded-md bg-secondary/20 text-muted-foreground font-medium">
                  {holdingPeriod} Years
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="w-5 h-5 text-primary" />
              Exemptions
            </CardTitle>
            <CardDescription>Select applicable lifetime exemptions (used once)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between p-3 border rounded-xl bg-secondary/20">
                <div>
                  <Label className="text-base block">General Exemption</Label>
                  <span className="text-xs text-muted-foreground">€30,000</span>
                </div>
                <Switch checked={useGeneralExemption} onCheckedChange={setUseGeneralExemption} />
              </div>
              <div className="flex items-center justify-between p-3 border rounded-xl bg-secondary/20">
                <div>
                  <Label className="text-base block">Primary Residence</Label>
                  <span className="text-xs text-muted-foreground">€150,000</span>
                </div>
                <Switch checked={usePrimaryExemption} onCheckedChange={setUsePrimaryExemption} />
              </div>
              <div className="flex items-center justify-between p-3 border rounded-xl bg-secondary/20">
                <div>
                  <Label className="text-base block">Agricultural Land</Label>
                  <span className="text-xs text-muted-foreground">€50,000</span>
                </div>
                <Switch checked={useAgriExemption} onCheckedChange={setUseAgriExemption} />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="lg:col-span-5 space-y-6">
        <div className="sticky top-24 space-y-6">
          <Card className="bg-success text-success-foreground border-none shadow-lg">
            <CardContent className="pt-6">
              <p className="text-success-foreground/80 text-sm font-medium mb-1">Net Proceeds</p>
              <div className="text-4xl font-bold tracking-tight">
                €{Math.round(netProceeds).toLocaleString()}
              </div>
            </CardContent>
          </Card>

          <Card className="border-border bg-card shadow-sm">
            <CardHeader className="pb-3 border-b border-border/50">
              <CardTitle className="text-lg">Capital Gain Breakdown</CardTitle>
            </CardHeader>
            <CardContent className="pt-4 space-y-3">
              <SummaryRow label="Cost (Acquisition)" value={acquisitionPrice} isCurrency />
              <SummaryRow label={`${currentYear} Cost (Indexed)`} value={indexedCost} isCurrency />
              <SummaryRow label="Exemption Applied" value={totalExemption} isCurrency negative />
              <div className="my-2 border-t border-border/50" />
              <SummaryRow label="Taxable Profit" value={taxableProfit} isCurrency bold />
              <SummaryRow
                label="Capital Gain Tax"
                value={capitalGainsTax}
                isCurrency
                bold
                color="text-destructive"
              />
            </CardContent>
          </Card>

          <Card className="bg-warning/10 border-warning/20 shadow-sm">
            <CardContent className="p-4 flex gap-3">
              <AlertCircle className="text-warning shrink-0" size={20} />
              <div className="text-xs text-warning">
                <p className="font-semibold mb-1">Important Note</p>
                Calculations assume property in Cyprus. Indexation applies to acquisition cost based
                on Consumer Price Index (assumed rate here).
              </div>
            </CardContent>
          </Card>

          <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3 flex items-start gap-3 text-destructive text-sm">
            <AlertCircle size={18} className="shrink-0 mt-0.5" />
            <p>
              <strong>Disclaimer:</strong> Olio does not offer financial advice. For professional
              financial advice, please contact our team.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function InputGroup({
  label,
  value,
  setValue,
  min,
  max,
  step,
}: {
  label: string;
  value: number;
  setValue: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium text-muted-foreground">{label}</Label>
      <Input
        type="number"
        value={value}
        onChange={(e) => setValue(Number(e.target.value))}
        min={min}
        max={max}
        step={step}
        className="h-11 bg-background"
      />
    </div>
  );
}

function SummaryRow({
  label,
  value,
  isCurrency,
  negative,
  highlight,
  bold,
  color,
}: {
  label: string;
  value: number | string;
  isCurrency?: boolean;
  negative?: boolean;
  highlight?: boolean;
  bold?: boolean;
  color?: string;
}) {
  const displayValue =
    isCurrency && typeof value === "number"
      ? `${negative ? "-" : ""}€${Math.round(value).toLocaleString()}`
      : value;

  return (
    <div
      className={`flex justify-between items-center text-sm ${highlight ? "bg-primary/10 p-2 rounded-lg -mx-2 text-primary font-medium" : ""} ${bold ? "font-bold" : ""}`}
    >
      <span className={highlight ? "" : "text-muted-foreground"}>{label}</span>
      <span className={color ? color : negative ? "text-destructive" : ""}>{displayValue}</span>
    </div>
  );
}
