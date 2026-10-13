import { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}

// Mobile-only page header. Desktop pages get their breadcrumb / chrome from
// DesktopHeader, so this renders nothing above the md breakpoint.
export function PageHeader({ title, subtitle, action }: PageHeaderProps) {
  return (
    <div className="md:hidden mb-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">{title}</h1>
          {subtitle ? <p className="text-muted-foreground mt-1 text-sm">{subtitle}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </div>
  );
}

interface PageHeaderActionProps {
  onClick: () => void;
  icon: ReactNode;
  label: string;
}

export function PageHeaderAction({ onClick, icon, label }: PageHeaderActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-lg active:scale-95 transition"
    >
      {icon}
    </button>
  );
}
