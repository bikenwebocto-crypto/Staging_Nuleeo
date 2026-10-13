import { cn } from "@ui/lib/utils";

// Loading placeholder that respects the theme. Use in place of stale
// data when a query is fetching for the first time:
//
//   {properties.isLoading ? <Skeleton className="h-24 w-full rounded-2xl" /> : ...}
//
// Or compose into card/row shapes:
//
//   <SkeletonRow lines={2} avatarSize="md" />
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("animate-pulse bg-secondary/70 dark:bg-secondary/40 rounded-md", className)}
    />
  );
}

// A list-row skeleton with optional avatar bubble. Mirrors the shape
// of most list rows in the product (tenant, partner, transaction,
// agreement) so loading states don't visually jolt the layout when
// real rows render.
export function SkeletonRow({
  lines = 2,
  avatar = true,
  className,
}: {
  lines?: 1 | 2 | 3;
  avatar?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-3 p-4", className)}>
      {avatar && <Skeleton className="w-10 h-10 rounded-full shrink-0" />}
      <div className="flex-1 min-w-0 space-y-2">
        <Skeleton className="h-3 w-1/2" />
        {lines >= 2 && <Skeleton className="h-2.5 w-3/4" />}
        {lines >= 3 && <Skeleton className="h-2.5 w-2/3" />}
      </div>
    </div>
  );
}
