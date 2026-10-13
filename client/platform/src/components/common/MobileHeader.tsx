import { Link, useLocation } from "wouter";
import {
  Search,
  Calculator,
  Plus,
  UserPlus,
  Building2,
  Handshake,
  ArrowLeft,
  FileText,
  Gift,
  Crown,
  X,
  Home,
  Store,
} from "lucide-react";
import {
  useAdminUsers,
  useInviteUser,
  useCreatePartner,
  useGrantCompPlan,
} from "@/lib/adminQueries";
import { useEffect, useState } from "react";
import { Drawer } from "vaul";
import { ProfileDrawer } from "@ui/components/common/ProfileDrawer";
import { AdminAddUnitDrawer } from "@/components/admin/AdminAddUnitDrawer";
import { AdminAddListingDrawer } from "@/components/admin/AdminAddListingDrawer";
import { useToast } from "@ui/hooks/use-toast";
import { parseApiError } from "@ui/lib/queryClient";
import { usePrivileges } from "@ui/lib/usePrivileges";
import { useAuth } from "@ui/lib/useAuth";
import type { PlatformPrivilegeKey } from "@shared/firestore-schema";

type CreateView = "menu" | "user" | "partner" | "comp-advance" | "comp-pro";

const createOptions: {
  icon: typeof UserPlus;
  label: string;
  view: CreateView | "unit" | "listing";
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

export function MobileHeader() {
  const { profile } = useAuth();
  const initial = (profile?.firstName?.[0] ?? profile?.email?.[0] ?? "?").toUpperCase();
  // Remembers an avatar URL that failed to load (e.g. a stale Google photo
  // URL) so we render initials instead of a broken-image icon. Keyed on the
  // URL, so a later upload of a new photo is retried automatically.
  const [photoFailedSrc, setPhotoFailedSrc] = useState<string | null>(null);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
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
    role: "owner" as "owner" | "tenant" | "admin",
  });
  const [partnerForm, setPartnerForm] = useState({
    name: "",
    type: "",
    contactName: "",
    email: "",
    phone: "",
    status: "active" as "active" | "inactive",
  });
  const { toast } = useToast();
  const { data: allUsers = [] } = useAdminUsers();
  const inviteUser = useInviteUser();
  const createPartner = useCreatePartner();
  const grantCompPlan = useGrantCompPlan();
  const { canPlatform } = usePrivileges();
  const visibleCreateOptions = createOptions.filter(
    (o) => !o.privilege || canPlatform(o.privilege),
  );

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

  // Auto-select when the typed value uniquely identifies a user (exact
  // email or name match). Lets admins paste an email and tap Grant
  // without an extra dropdown tap.
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
  const [location] = useLocation();

  const openCreate = () => {
    setCreateView("menu");
    setUserSearch("");
    setSelectedUser(null);
    setUserForm({ fullName: "", email: "", role: "owner" });
    setPartnerForm({ name: "", type: "", contactName: "", email: "", phone: "", status: "active" });
    setIsCreateOpen(true);
  };
  const closeCreate = () => {
    setIsCreateOpen(false);
    setCreateView("menu");
    setUserSearch("");
    setSelectedUser(null);
  };

  const handleCreateUser = async () => {
    const [firstName, ...rest] = userForm.fullName.trim().split(/\s+/);
    try {
      const result = await inviteUser.mutateAsync({
        email: userForm.email.trim().toLowerCase(),
        firstName: firstName || "",
        lastName: rest.join(" "),
        roles: [userForm.role],
      });
      try {
        await navigator.clipboard.writeText(result.inviteLink);
      } catch {}
      toast({
        title: "User created",
        description: "Password-setup link copied to clipboard — share it with the user.",
      });
      closeCreate();
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
        type: partnerForm.type as any,
        contactName: partnerForm.contactName,
        email: partnerForm.email,
        phone: partnerForm.phone,
        status: partnerForm.status,
      });
      toast({ title: "Partner created", description: `${partnerForm.name} has been added.` });
      closeCreate();
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
      closeCreate();
    } catch (err: any) {
      toast({
        title: "Failed to grant plan",
        description: parseApiError(err),
        variant: "destructive",
      });
    }
  };

  const isTenantView = location === "/tenant" || location.startsWith("/tenant/");
  const isAdminView = location === "/admin" || location.startsWith("/admin/");

  let role = "owner";
  if (isTenantView) role = "tenant";
  if (isAdminView) role = "admin";

  return (
    <>
      <ProfileDrawer
        open={isProfileOpen}
        onOpenChange={setIsProfileOpen}
        role={role as any}
        signOutRedirect="/login"
      />
      <AdminAddUnitDrawer open={isAdminAddUnitOpen} onOpenChange={setIsAdminAddUnitOpen} />
      <AdminAddListingDrawer open={isAdminAddListingOpen} onOpenChange={setIsAdminAddListingOpen} />

      {/* Create New Drawer */}
      <Drawer.Root
        open={isCreateOpen}
        onOpenChange={(open) => {
          if (!open) closeCreate();
          else setIsCreateOpen(true);
        }}
      >
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[100]" />
          <Drawer.Content
            className="fixed bottom-0 left-0 right-0 z-[101] outline-none"
            style={{ maxHeight: "75vh" }}
          >
            <div
              className="bg-card rounded-t-2xl border-t border-border overflow-y-auto overscroll-contain"
              style={{ maxHeight: "75vh" }}
            >
              <div className="mx-auto w-10 h-1 flex-shrink-0 rounded-full bg-muted-foreground/30 mt-3 mb-2" />

              {/* Header */}
              <div className="px-6 pb-2 flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {createView !== "menu" && (
                    <button
                      onClick={() => setCreateView("menu")}
                      className="p-1 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground -ml-1"
                    >
                      <ArrowLeft size={18} />
                    </button>
                  )}
                  <div>
                    <Drawer.Title className="text-lg font-semibold text-foreground">
                      {createView === "menu" && "Create New"}
                      {createView === "user" && "New User"}
                      {createView === "partner" && "New Partner"}
                      {createView === "comp-advance" && "Complimentary Advance"}
                      {createView === "comp-pro" && "Complimentary PRO"}
                    </Drawer.Title>
                    {createView === "menu" && (
                      <p className="text-sm text-muted-foreground mt-0.5">
                        What would you like to create?
                      </p>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={closeCreate}
                  aria-label="Close"
                  className="p-1 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground -mr-1"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="px-6 pb-8 pt-2">
                {/* Menu View */}
                {createView === "menu" && (
                  <div className="space-y-1 -mx-2">
                    {visibleCreateOptions.map((option) => (
                      <button
                        key={option.label}
                        onClick={() => {
                          if (option.view === "unit") {
                            closeCreate();
                            setIsAdminAddUnitOpen(true);
                          } else if (option.view === "listing") {
                            closeCreate();
                            setIsAdminAddListingOpen(true);
                          } else {
                            setCreateView(option.view);
                          }
                        }}
                        className="flex items-center gap-3 w-full px-3 py-3 rounded-xl hover:bg-secondary active:bg-secondary transition-all duration-200"
                      >
                        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                          <option.icon size={20} className="text-primary" />
                        </div>
                        <span className="font-medium text-sm text-foreground">{option.label}</span>
                      </button>
                    ))}
                  </div>
                )}

                {/* User Form */}
                {createView === "user" && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleCreateUser();
                    }}
                    className="space-y-4"
                  >
                    <p className="text-sm text-muted-foreground">
                      A password-setup link will be copied to your clipboard so you can share it
                      with them.
                    </p>
                    <div className="space-y-1.5">
                      <label className="block text-sm font-medium text-foreground">Full Name</label>
                      <input
                        type="text"
                        value={userForm.fullName}
                        onChange={(e) => setUserForm({ ...userForm, fullName: e.target.value })}
                        placeholder="e.g. Jane Doe"
                        required
                        className="w-full bg-background border border-input rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
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
                        className="w-full bg-background border border-input rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
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
                        className="w-full bg-background border border-input rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                      >
                        <option value="owner">Owner</option>
                        <option value="tenant">Tenant</option>
                        <option value="admin">Admin</option>
                      </select>
                    </div>
                    <div className="flex gap-3 pt-2">
                      <button
                        type="button"
                        onClick={closeCreate}
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

                {/* Partner Form */}
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
                        className="w-full bg-background border border-input rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="block text-sm font-medium text-foreground">Type</label>
                        <select
                          value={partnerForm.type}
                          onChange={(e) => setPartnerForm({ ...partnerForm, type: e.target.value })}
                          required
                          className="w-full bg-background border border-input rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                        >
                          <option value="">Select...</option>
                          <option value="broker">Broker</option>
                          <option value="contractor">Contractor</option>
                          <option value="legal">Legal</option>
                          <option value="cleaning">Cleaning</option>
                          <option value="insurance">Insurance</option>
                        </select>
                      </div>
                      <div className="space-y-1.5">
                        <label className="block text-sm font-medium text-foreground">Status</label>
                        <select
                          value={partnerForm.status}
                          onChange={(e) =>
                            setPartnerForm({
                              ...partnerForm,
                              status: e.target.value as "active" | "inactive",
                            })
                          }
                          className="w-full bg-background border border-input rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                        >
                          <option value="active">Active</option>
                          <option value="inactive">Inactive</option>
                        </select>
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
                        className="w-full bg-background border border-input rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="block text-sm font-medium text-foreground">Email</label>
                        <input
                          type="email"
                          value={partnerForm.email}
                          onChange={(e) =>
                            setPartnerForm({ ...partnerForm, email: e.target.value })
                          }
                          placeholder="contact@partner.com"
                          className="w-full bg-background border border-input rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="block text-sm font-medium text-foreground">Phone</label>
                        <input
                          type="text"
                          value={partnerForm.phone}
                          onChange={(e) =>
                            setPartnerForm({ ...partnerForm, phone: e.target.value })
                          }
                          placeholder="+30 210 1234567"
                          className="w-full bg-background border border-input rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                        />
                      </div>
                    </div>
                    <div className="flex gap-3 pt-2">
                      <button
                        type="button"
                        onClick={closeCreate}
                        className="flex-1 px-4 py-2.5 border border-border rounded-lg text-sm font-medium hover:bg-muted transition"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={!partnerForm.name || !partnerForm.type || createPartner.isPending}
                        className="flex-1 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {createPartner.isPending ? "Creating…" : "Create Partner"}
                      </button>
                    </div>
                  </form>
                )}

                {/* Complimentary Advance Form */}
                {createView === "comp-advance" && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleGrantComp("advance");
                    }}
                    className="space-y-4"
                  >
                    <p className="text-sm text-muted-foreground">
                      Grant a user complimentary access to the Advance plan for 12 months.
                    </p>
                    <div className="space-y-1.5 relative">
                      <label className="block text-sm font-medium text-foreground">User</label>
                      {selectedUser ? (
                        <div className="flex items-center justify-between w-full bg-background border border-input rounded-lg px-3 py-2.5 text-sm">
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
                            className="w-full bg-background border border-input rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
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
                      <div className="w-full bg-muted/50 border border-input rounded-lg px-3 py-2.5 text-sm text-foreground">
                        12 Months
                      </div>
                    </div>
                    <div className="flex gap-3 pt-2">
                      <button
                        type="button"
                        onClick={() => {
                          closeCreate();
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
                        {grantCompPlan.isPending ? "Granting…" : "Grant Advance"}
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground/70 text-center">
                      Only applies to users without an active subscription.
                    </p>
                  </form>
                )}

                {/* Complimentary PRO Form */}
                {createView === "comp-pro" && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleGrantComp("pro");
                    }}
                    className="space-y-4"
                  >
                    <p className="text-sm text-muted-foreground">
                      Grant a user complimentary access to the PRO plan for 12 months.
                    </p>
                    <div className="space-y-1.5 relative">
                      <label className="block text-sm font-medium text-foreground">User</label>
                      {selectedUser ? (
                        <div className="flex items-center justify-between w-full bg-background border border-input rounded-lg px-3 py-2.5 text-sm">
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
                            className="w-full bg-background border border-input rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
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
                      <div className="w-full bg-muted/50 border border-input rounded-lg px-3 py-2.5 text-sm text-foreground">
                        12 Months
                      </div>
                    </div>
                    <div className="flex gap-3 pt-2">
                      <button
                        type="button"
                        onClick={() => {
                          closeCreate();
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
                        {grantCompPlan.isPending ? "Granting…" : "Grant PRO"}
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground/70 text-center">
                      Only applies to users without an active subscription.
                    </p>
                  </form>
                )}
              </div>
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>

      <div
        className={`md:hidden fixed top-0 left-0 right-0 z-40 transition-all duration-300 pt-[calc(env(safe-area-inset-top)+1rem)] pb-2 px-6 ${
          isAdminView
            ? "bg-card/80 backdrop-blur-xl border-b border-border/50 shadow-sm"
            : "bg-transparent"
        }`}
      >
        {/* Subtle gradient overlay for readability against dark hero backgrounds */}
        {!isAdminView && (
          <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/20 to-transparent pointer-events-none -z-10" />
        )}

        <div className="flex items-center gap-3 relative z-50">
          <div
            onClick={() => setIsProfileOpen(true)}
            className={`w-10 h-10 rounded-full overflow-hidden flex-shrink-0 cursor-pointer shadow-sm border flex items-center justify-center ${
              isAdminView
                ? "border-border bg-muted text-foreground"
                : "border-white/20 bg-white/10 text-white"
            }`}
          >
            {profile?.photoURL && profile.photoURL !== photoFailedSrc ? (
              <img
                src={profile.photoURL}
                alt="Profile"
                className="w-full h-full object-cover"
                referrerPolicy="no-referrer"
                onError={() => setPhotoFailedSrc(profile?.photoURL ?? null)}
              />
            ) : (
              <span className="text-sm font-semibold">{initial}</span>
            )}
          </div>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event("command-palette:open"))}
            aria-label="Open search"
            className={`flex-1 h-10 backdrop-blur-xl rounded-full flex items-center px-4 border text-left ${
              isAdminView
                ? "bg-muted/80 border-border/50 text-foreground"
                : "bg-white/10 border-white/10 text-white"
            }`}
          >
            <Search
              size={16}
              className={`mr-2 ${isAdminView ? "text-muted-foreground" : "text-white/50"}`}
            />
            <span
              className={`bg-transparent text-sm font-medium w-full ${
                isAdminView ? "text-muted-foreground" : "text-white/50"
              }`}
            >
              Search
            </span>
          </button>

          <div className="flex gap-2">
            {isAdminView && (
              <button
                type="button"
                onClick={openCreate}
                aria-label="Create new"
                className="w-10 h-10 rounded-full backdrop-blur-xl flex items-center justify-center transition-all active:scale-95 border bg-muted/80 border-border/50 text-foreground"
              >
                <Plus size={17} strokeWidth={2} />
              </button>
            )}
            <Link
              href={
                isTenantView
                  ? location === "/tenant/agreements"
                    ? "/tenant"
                    : "/tenant/agreements"
                  : isAdminView
                    ? "/admin/calculator"
                    : "/calculator"
              }
            >
              <button
                className={`w-10 h-10 rounded-full backdrop-blur-xl flex items-center justify-center transition-all active:scale-95 border ${
                  isAdminView
                    ? "bg-muted/80 border-border/50 text-foreground"
                    : "bg-white/10 border-white/10 text-white"
                }`}
              >
                {isTenantView ? (
                  location === "/tenant/agreements" ? (
                    <Home size={17} strokeWidth={2} />
                  ) : (
                    <FileText size={17} strokeWidth={2} />
                  )
                ) : (
                  <Calculator size={17} strokeWidth={2} />
                )}
              </button>
            </Link>
          </div>
        </div>
      </div>

      {/* Spacer for non-dashboard pages to prevent content hidden behind header */}
      {/* Spacer removed - padding handled in individual pages */}
      {/* {!isDashboard && <div className="h-20 md:hidden" />} */}
    </>
  );
}
