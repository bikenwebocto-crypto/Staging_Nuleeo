import { AlertTriangle, TrendingDown, TrendingUp } from "lucide-react";

type TransactionType = "income" | "expense" | "neutral";

type ActivityTransaction = {
  id: string;
  propertyId: string;
  type: TransactionType;
  name: string;
  date: string;
  currency: string;
  amount: number;
  category: string;
};

type PropertyActivityLogProps = {
  property: {
    id: string;
  };
  transactions: ActivityTransaction[];
};

export default function PropertyActivityLog({ property, transactions }: PropertyActivityLogProps) {
  const items = transactions.filter((t) => t.propertyId === property.id);

  return (
    <>
      {/* Activity Log */}
      <h3 className="font-bold text-foreground mb-4 text-lg mt-8">Recent Activity</h3>
      <div className="space-y-4 mb-8">
        {items.length > 0 ? (
          items.map((tx) => (
            <div
              key={tx.id}
              className="flex items-center justify-between bg-card p-4 rounded-2xl shadow-sm border border-border"
            >
              <div className="flex items-center gap-3">
                <div
                  className={`w-12 h-12 rounded-full flex items-center justify-center text-lg overflow-hidden border ${
                    tx.type === "neutral"
                      ? "bg-yellow-500/10 border-yellow-500/20 text-yellow-700 dark:text-yellow-400"
                      : tx.type === "income"
                        ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-700 dark:text-emerald-400"
                        : "bg-red-500/10 border-red-500/20 text-red-600 dark:text-red-400"
                  }`}
                >
                  {tx.type === "income" ? (
                    <TrendingUp size={20} />
                  ) : tx.type === "expense" ? (
                    <TrendingDown size={20} />
                  ) : (
                    <AlertTriangle size={20} />
                  )}
                </div>
                <div className="flex flex-col">
                  <span className="font-semibold text-sm text-foreground line-clamp-1">
                    {tx.name}
                  </span>
                  <span className="text-xs text-muted-foreground">{tx.date}</span>
                </div>
              </div>
              <div className="flex flex-col items-end min-w-[80px]">
                <span
                  className={`font-bold text-sm ${
                    tx.type === "income"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : tx.type === "expense"
                        ? "text-foreground"
                        : "text-orange-500 dark:text-orange-400"
                  }`}
                >
                  {tx.type === "expense" ? "-" : tx.type === "income" ? "+" : ""}
                  {tx.currency}
                  {tx.amount}
                </span>
                <span className="text-[10px] text-muted-foreground/70 capitalize">
                  {tx.category}
                </span>
              </div>
            </div>
          ))
        ) : (
          <div className="bg-card p-8 rounded-2xl shadow-sm border border-border text-center">
            <p className="text-muted-foreground text-sm">No recent activity for this property.</p>
          </div>
        )}
      </div>
    </>
  );
}
