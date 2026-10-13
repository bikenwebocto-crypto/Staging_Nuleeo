import { useState } from "react";
import { HeaderActions } from "@/components/common/AdminLayout";
import {
  CalculatorBody,
  CalculatorModeToggle,
  type CalcMode,
} from "@ui/components/common/CalculatorBody";

export default function AdminCalculatorPage() {
  const [mode, setMode] = useState<CalcMode>("buy");

  return (
    <>
      <HeaderActions>
        <CalculatorModeToggle mode={mode} setMode={setMode} />
      </HeaderActions>
      <CalculatorBody mode={mode} setMode={setMode} />
    </>
  );
}
