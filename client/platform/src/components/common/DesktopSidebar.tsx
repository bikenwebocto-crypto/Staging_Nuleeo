import { useEffect, useState } from "react";
import { UserPlus, Building2, Handshake, X, ArrowLeft, Gift, Crown, Store } from "lucide-react";
import { DesktopSidebar as SharedDesktopSidebar } from "@ui/components/common/DesktopSidebar";
import { useToast } from "@ui/hooks/use-toast";
import { parseApiError } from "@ui/lib/queryClient";
import { usePrivileges } from "@ui/lib/usePrivileges";
import { menuItems, tenantMenuItems, adminMenuItems } from "@/lib/menuItems";
import {
  useAdminUsers,
  useInviteUser,
  useCreatePartner,
  useGrantCompPlan,
  PARTNER_DURATION_OPTIONS,
  type PartnerDurationMonths,
  type PartnerType,
} from "@/lib/adminQueries";
import { AdminAddUnitDrawer } from "@/components/admin/AdminAddUnitDrawer";
import { AdminAddListingDrawer } from "@/components/admin/AdminAddListingDrawer";
import type { PlatformPrivilegeKey } from "@shared/firestore-schema";

interface DesktopSidebarProps {
  role?: "owner" | "tenant" | "admin";
}

type CreateView = "menu" | "user" | "unit" | "partner" | "listing" | "comp-advance" | "comp-pro";

const createOptions: {
  icon: typeof UserPlus;
  label: string;
  view: CreateView;
  privilege?: PlatformPrivilegeKey;
}[] = [
  { icon: UserPlus, label: "New User", view: "user", privilege: "users.assignRoles" },
  { icon: Building2, label: "New Unit", view: "unit", privilege: "properties.editAny" },
  { icon: Handshake, label: "New Partner", view: "partner", privilege: "comm.partners" },
  { icon: Store, label: "New Listing", view: "listing", privilege: "comm.partners" },
  {
    icon: Gift,
    label: "Complimentary Advance",
    view: "comp-advance",
    privilege: "users.assignRoles",
  },
  { icon: Crown, label: "Complimentary PRO", view: "comp-pro", privilege: "users.assignRoles" },
];

export function DesktopSidebar({ role = "owner" }: DesktopSidebarProps) {
  const { canPlatform } = usePrivileges();
  const { toast } = useToast();
  const { data: allUsers = [] } = useAdminUsers();
  const inviteUser = useInviteUser();
  const createPartner = useCreatePartner();
  const grantCompPlan = useGrantCompPlan();

  // Build the role-appropriate item list. Admin items are gated by the live
  // privilege matrix so flipping a privilege in /admin/settings hides items
  // immediately. Items without a `privilege` are always visible.
  let items: Array<{ icon: any; label: string; path: string; privilege?: string }> = menuItems;
  if (role === "tenant") items = tenantMenuItems;
  if (role === "admin") {
    items = adminMenuItems.filter(
      (item) => !item.privilege || canPlatform(item.privilege as PlatformPrivilegeKey),
    );
  }

  // ── Create modal (header `+` button dispatches open-admin-create) ────
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [createView, setCreateView] = useState<CreateView>("menu");
  const [isAdminAddUnitOpen, setIsAdminAddUnitOpen] = useState(false);
  const [isAdminAddListingOpen, setIsAdminAddListingOpen] = useState(false);
  const [userSearch, setUserSearch] = useState("");
  const [selectedUser, setSelectedUser] = useState<{
    id: string;
    name: string;
    email: string;
  } | null>(null);

  const [userForm, setUserForm] = useState({
    fullName: "",
    email: "",
    phone: "",
    role: "owner" as "owner" | "tenant" | "admin",
  });
  const [partnerForm, setPartnerForm] = useState({
    name: "",
    type: "broker" as PartnerType,
    contactName: "",
    email: "",
    phone: "",
    durationMonths: 1 as PartnerDurationMonths,
  });

  // Comp plans target end-users (owners + tenants); the server promotes
  // a tenant to owner on grant so they can actually exercise the plan.
  // Admins/superadmins are excluded — staff don't get customer perks.
  const compPlanCandidates =
    createView === "comp-advance" || createView === "comp-pro"
      ? allUsers.filter(
          (u) =>
            (u.rawRoles.includes("owner") || u.rawRoles.includes("tenant")) &&
            !u.rawRoles.includes("admin") &&
            !u.rawRoles.includes("superadmin"),
        )
      : allUsers;
  const filteredUsers =
    userSearch.length >= 2 && !selectedUser
      ? compPlanCandidates
          .filter(
            (u) =>
              u.name.toLowerCase().includes(userSearch.toLowerCase()) ||
              u.email.toLowerCase().includes(userSearch.toLowerCase()),
          )
          .slice(0, 5)
      : [];

  // Auto-select when the typed value uniquely identifies a user — most
  // commonly an exact email match. Lets admins paste an email and click
  // Grant without an extra dropdown tap. Falls back to the manual click
  // when the search is ambiguous (e.g. partial name with multiple hits).
  useEffect(() => {
    if (selectedUser || userSearch.length < 2) return;
    const needle = userSearch.trim().toLowerCase();
    if (!needle) return;
    const exact = compPlanCandidates.find(
      (u) => u.email.toLowerCase() === needle || u.name.toLowerCase() === needle,
    );
    if (exact) {
      setSelectedUser({ id: exact.id, name: exact.name, email: exact.email });
      setUserSearch(exact.name);
    }
  }, [userSearch, selectedUser, compPlanCandidates]);

  useEffect(() => {
    const handler = () => openCreateModal();
    window.addEventListener("open-admin-create", handler);
    return () => window.removeEventListener("open-admin-create", handler);
  }, []);

  const openCreateModal = () => {
    setCreateView("menu");
    setUserSearch("");
    setSelectedUser(null);
    setUserForm({ fullName: "", email: "", phone: "", role: "owner" });
    setPartnerForm({
      name: "",
      type: "broker",
      contactName: "",
      email: "",
      phone: "",
      durationMonths: 1,
    });
    setIsCreateOpen(true);
  };
  const closeCreateModal = () => {
    setIsCreateOpen(false);
    setCreateView("menu");
    setUserSearch("");
    setSelectedUser(null);
  };

  const handleCreateUser = async () => {
    const [firstName, ...rest] = userForm.fullName.trim().split(/\s+/);
    const lastName = rest.join(" ");
    try {
      const result = await inviteUser.mutateAsync({
        email: userForm.email.trim().toLowerCase(),
        firstName: firstName || "",
        lastName,
        roles: [userForm.role],
      });
      // inviteLink is null when the email already has a Firebase Auth
      // account (we don't mint a setup link for existing users). Skip the
      // clipboard write so we don't paste the literal string "null".
      let copied = false;
      if (result.inviteLink) {
        try {
          await navigator.clipboard.writeText(result.inviteLink);
          copied = true;
        } catch {}
      }
      toast({
        title: "User created",
        description: copied
          ? "Password-setup link copied to clipboard — share it with the user."
          : "User added. They already have an account — no setup link needed.",
      });
      closeCreateModal();
    } catch (err: any) {
      toast({
        title: "Failed to create user",
        description: parseApiError(err),
        variant: "destructive",
      });
    }
  };

  const handleCreatePartner = async () => {
    try {
      await createPartner.mutateAsync({
        name: partnerForm.name.trim(),
        type: partnerForm.type,
        contactName: partnerForm.contactName,
        email: partnerForm.email,
        phone: partnerForm.phone,
        durationMonths: partnerForm.durationMonths,
      });
      toast({ title: "Partner created", description: `${partnerForm.name} has been added.` });
      closeCreateModal();
    } catch (err: any) {
      toast({
        title: "Failed to create partner",
        description: parseApiError(err),
        variant: "destructive",
      });
    }
  };

  const handleGrantComp = async (plan: "advance" | "pro") => {
    if (!selectedUser) return;
    try {
      await grantCompPlan.mutateAsync({ userId: selectedUser.id, plan });
      toast({
        title: "Plan granted",
        description: `${selectedUser.name} now has complimentary ${plan === "pro" ? "PRO" : "Advance"} for 12 months.`,
      });
      closeCreateModal();
    } catch (err: any) {
      toast({
        title: "Failed to grant plan",
        description: parseApiError(err),
        variant: "destructive",
      });
    }
  };

  return (
    <>
      <SharedDesktopSidebar
        role={role}
        items={items}
        brandHref={role === "admin" ? "/admin" : undefined}
      />

      {isCreateOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={closeCreateModal}
          />
          <div className="relative bg-card rounded-2xl shadow-xl border border-border w-[420px] max-w-[90vw] max-h-[85vh] overflow-y-auto">
            <div className="sticky top-0 bg-card rounded-t-2xl p-6 pb-4 border-b border-border z-10">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {createView !== "menu" && (
                    <button
                      onClick={() => setCreateView("menu")}
                      className="p-1 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground mr-1"
                    >
                      <ArrowLeft size={18} />
                    </button>
                  )}
                  <h3 className="text-lg font-semibold text-foreground">
                    {createView === "menu" && "Create New"}
                    {createView === "user" && "New User"}
                    {createView === "partner" && "New Partner"}
                    {createView === "comp-advance" && "Complimentary Advance"}
                    {createView === "comp-pro" && "Complimentary PRO"}
                  </h3>
                </div>
                <button
                  onClick={closeCreateModal}
                  className="p-1 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            <div className="p-6 pt-4">
              {createView === "menu" && (
                <div className="space-y-1">
                  {createOptions
                    .filter((option) => !option.privilege || canPlatform(option.privilege))
                    .map((option) => (
                      <div
                        key={option.label}
                        onClick={() => {
                          if (option.view === "unit") {
                            closeCreateModal();
                            setIsAdminAddUnitOpen(true);
                          } else if (option.view === "listing") {
                            closeCreateModal();
                            setIsAdminAddListingOpen(true);
                          } else {
                            setCreateView(option.view);
                          }
                        }}
                        className="flex items-center gap-3 px-3 py-3 rounded-xl cursor-pointer hover:bg-secondary transition-all duration-200 group"
                      >
                        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
                          <option.icon size={18} className="text-primary" />
                        </div>
                        <span className="font-medium text-sm text-foreground">{option.label}</span>
                      </div>
                    ))}
                </div>
              )}

              {createView === "user" && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleCreateUser();
                  }}
                  className="space-y-4"
                >
                  <p className="text-sm text-muted-foreground">
                    A password-setup link will be copied to your clipboard so you can share it with
                    them.
                  </p>
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium text-foreground">Full Name</label>
                    <input
                      type="text"
                      value={userForm.fullName}
                      onChange={(e) => setUserForm({ ...userForm, fullName: e.target.value })}
                      placeholder="e.g. Jane Doe"
                      required
                      className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium text-foreground">
                      Email Address
                    </label>
                    <input
                      type="email"
                      value={userForm.email}
                      onChange={(e) => setUserForm({ ...userForm, email: e.target.value })}
                      placeholder="jane@example.com"
                      required
                      className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium text-foreground">Role</label>
                    <select
                      value={userForm.role}
                      onChange={(e) =>
                        setUserForm({
                          ...userForm,
                          role: e.target.value as "owner" | "tenant" | "admin",
                        })
                      }
                      className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                    >
                      <option value="owner">Owner</option>
                      <option value="tenant">Tenant</option>
                      <option value="admin">Admin</option>
                    </select>
                  </div>
                  <div className="flex gap-3 pt-2">
                    <button
                      type="button"
                      onClick={() => setCreateView("menu")}
                      className="flex-1 px-4 py-2.5 border border-border rounded-lg text-sm font-medium hover:bg-muted transition"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={!userForm.fullName || !userForm.email || inviteUser.isPending}
                      className="flex-1 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {inviteUser.isPending ? "Creating…" : "Create & Copy Link"}
                    </button>
                  </div>
                </form>
              )}

              {createView === "partner" && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleCreatePartner();
                  }}
                  className="space-y-4"
                >
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium text-foreground">
                      Partner Name
                    </label>
                    <input
                      type="text"
                      value={partnerForm.name}
                      onChange={(e) => setPartnerForm({ ...partnerForm, name: e.target.value })}
                      placeholder="e.g. ABC Realty"
                      required
                      className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="block text-sm font-medium text-foreground">Type</label>
                      <select
                        value={partnerForm.type}
                        onChange={(e) =>
                          setPartnerForm({ ...partnerForm, type: e.target.value as PartnerType })
                        }
                        required
                        className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 capitalize"
                      >
                        <option value="broker">Broker</option>
                        <option value="contractor">Contractor</option>
                        <option value="legal">Legal</option>
                        <option value="cleaning">Cleaning</option>
                        <option value="insurance">Insurance</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-sm font-medium text-foreground">
                        Active For
                      </label>
                      <select
                        value={partnerForm.durationMonths}
                        onChange={(e) =>
                          setPartnerForm({
                            ...partnerForm,
                            durationMonths: Number(e.target.value) as PartnerDurationMonths,
                          })
                        }
                        className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                      >
                        {PARTNER_DURATION_OPTIONS.map((m) => (
                          <option key={m} value={m}>
                            {m} {m === 1 ? "month" : "months"}
                          </option>
                        ))}
                      </select>
                      <p className="text-xs text-muted-foreground">
                        Auto-inactivates after this period.
                      </p>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium text-foreground">
                      Contact Person
                    </label>
                    <input
                      type="text"
                      value={partnerForm.contactName}
                      onChange={(e) =>
                        setPartnerForm({ ...partnerForm, contactName: e.target.value })
                      }
                      placeholder="e.g. John Smith"
                      className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="block text-sm font-medium text-foreground">Email</label>
                      <input
                        type="email"
                        value={partnerForm.email}
                        onChange={(e) => setPartnerForm({ ...partnerForm, email: e.target.value })}
                        placeholder="contact@partner.com"
                        className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-sm font-medium text-foreground">Phone</label>
                      <input
                        type="text"
                        value={partnerForm.phone}
                        onChange={(e) => setPartnerForm({ ...partnerForm, phone: e.target.value })}
                        placeholder="+30 210 1234567"
                        className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                      />
                    </div>
                  </div>
                  <div className="flex gap-3 pt-2">
                    <button
                      type="button"
                      onClick={() => setCreateView("menu")}
                      className="flex-1 px-4 py-2.5 border border-border rounded-lg text-sm font-medium hover:bg-muted transition"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={!partnerForm.name || !partnerForm.type || createPartner.isPending}
                      className="flex-1 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {createPartner.isPending ? "Saving…" : "Save Changes"}
                    </button>
                  </div>
                </form>
              )}

              {(createView === "comp-advance" || createView === "comp-pro") && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleGrantComp(createView === "comp-advance" ? "advance" : "pro");
                  }}
                  className="space-y-4"
                >
                  <p className="text-sm text-muted-foreground">
                    Grant a user complimentary access to the{" "}
                    {createView === "comp-advance" ? "Advance" : "PRO"} plan for 12 months.
                  </p>
                  <div className="space-y-1.5 relative">
                    <label className="block text-sm font-medium text-foreground">User</label>
                    {selectedUser ? (
                      <div className="flex items-center justify-between w-full bg-background border border-input rounded-lg px-3 py-2 text-sm">
                        <div>
                          <span className="font-medium text-foreground">{selectedUser.name}</span>
                          <span className="text-muted-foreground ml-2">{selectedUser.email}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedUser(null);
                            setUserSearch("");
                          }}
                          className="text-muted-foreground hover:text-foreground ml-2"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <>
                        <input
                          type="text"
                          value={userSearch}
                          onChange={(e) => setUserSearch(e.target.value)}
                          placeholder="Search by name or email..."
                          className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                        />
                        {userSearch.length >= 2 && (
                          <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-lg z-20 overflow-hidden">
                            {filteredUsers.length > 0 ? (
                              filteredUsers.map((user) => (
                                <button
                                  key={user.id}
                                  type="button"
                                  onClick={() => {
                                    setSelectedUser({
                                      id: user.id,
                                      name: user.name,
                                      email: user.email,
                                    });
                                    setUserSearch(user.name);
                                  }}
                                  className="flex flex-col w-full px-3 py-2 text-left hover:bg-secondary transition-colors"
                                >
                                  <span className="text-sm font-medium text-foreground">
                                    {user.name}
                                  </span>
                                  <span className="text-xs text-muted-foreground">
                                    {user.email}
                                  </span>
                                </button>
                              ))
                            ) : (
                              <div className="px-3 py-2 text-sm text-muted-foreground">
                                No matching users found.
                              </div>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium text-foreground">Duration</label>
                    <div className="w-full bg-muted/50 border border-input rounded-lg px-3 py-2 text-sm text-foreground">
                      12 Months
                    </div>
                  </div>
                  <div className="flex gap-3 pt-2">
                    <button
                      type="button"
                      onClick={() => {
                        setCreateView("menu");
                        setUserSearch("");
                        setSelectedUser(null);
                      }}
                      className="flex-1 px-4 py-2.5 border border-border rounded-lg text-sm font-medium hover:bg-muted transition"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={!selectedUser || grantCompPlan.isPending}
                      className="flex-1 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {grantCompPlan.isPending
                        ? "Granting…"
                        : `Grant ${createView === "comp-advance" ? "Advance" : "PRO"}`}
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground/70 text-center">
                    Only applies to users without an active subscription.
                  </p>
                </form>
              )}
            </div>
          </div>
        </div>
      )}

      <AdminAddUnitDrawer open={isAdminAddUnitOpen} onOpenChange={setIsAdminAddUnitOpen} />
      <AdminAddListingDrawer open={isAdminAddListingOpen} onOpenChange={setIsAdminAddListingOpen} />
    </>
  );
}
