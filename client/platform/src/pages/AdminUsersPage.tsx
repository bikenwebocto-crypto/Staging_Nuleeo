import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AdminLayout";
import { Search, Edit, Eye, EyeOff, AlertTriangle, Users as UsersIcon } from "lucide-react";
import { Avatar } from "@ui/components/common/Avatar";
import { EmailAuthProvider, reauthenticateWithCredential, type AuthError } from "firebase/auth";
import { useAuth } from "@ui/lib/useAuth";
import {
  TableSortIcon,
  TableFiltersCard,
  TableShellCard,
  FilterPills,
  TableEmptyState,
} from "@ui/components/ui/data-table";
import { useState, useEffect } from "react";
import { Drawer } from "vaul";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@ui/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@ui/components/ui/dialog";
import { Input } from "@ui/components/ui/input";
import { Label } from "@ui/components/ui/label";
import { Checkbox } from "@ui/components/ui/checkbox";
import { useToast } from "@ui/hooks/use-toast";
import { apiRequest, parseApiError } from "@ui/lib/queryClient";
import { useLocation } from "wouter";
import {
  useAdminUsers,
  useUpdateUser,
  useDeleteUser,
  useInviteUser,
  type AdminUserRow,
  type UserUpdate,
} from "@/lib/adminQueries";
import { Copy } from "lucide-react";
import { PLATFORM_ROLES, type PlatformRoleKey } from "@shared/firestore-schema";
import { usePrivileges } from "@ui/lib/usePrivileges";
import { ForbiddenView } from "@ui/components/ForbiddenView";
import {
  AdminListLoading,
  AdminListError,
  sortableThProps,
} from "@/components/common/AdminListStates";
import { formatDateNumeric } from "@ui/lib/format";

// Schema "Pending" (= invited but no link sent, or otherwise not yet active)
// is shown to admins as "Inactive". Keep the schema value untouched on the
// wire — only the label changes.
function displayStatus(status: AdminUserRow["status"]): string {
  return status === "Pending" ? "Inactive" : status;
}

// "Currently in the app" = heartbeat within the last 2 minutes. The user app
// pings /api/heartbeat every 60s while its tab is visible, so a 2-minute
// window tolerates one missed beat (network blip, brief tab switch) without
// flipping the dot to grey.
const ONLINE_WINDOW_MS = 2 * 60 * 1000;
function isUserOnline(lastSeenAt: string | null | undefined): boolean {
  if (!lastSeenAt) return false;
  const t = Date.parse(lastSeenAt);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < ONLINE_WINDOW_MS;
}

export default function AdminUsersPage() {
  const { data: users = [], isLoading, isError, refetch } = useAdminUsers();
  const [searchTerm, setSearchTerm] = useState("");
  const [activeFilter, setActiveFilter] = useState("All");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [viewUser, setViewUser] = useState<AdminUserRow | null>(null);
  const [editUser, setEditUser] = useState<AdminUserRow | null>(null);
  // Impersonation gate: we collect the target's typed name before opening the
  // session. Every confirmed impersonation writes an audit row server-side, so
  // we want the click to be deliberate, not an accident.
  const [impersonateTarget, setImpersonateTarget] = useState<AdminUserRow | null>(null);
  const [impersonateNameConfirm, setImpersonateNameConfirm] = useState("");
  const [impersonateBusy, setImpersonateBusy] = useState(false);
  const [resettingPassword, setResettingPassword] = useState(false);
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [isMobile, setIsMobile] = useState(false);
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();
  const inviteUser = useInviteUser();
  const { firebaseUser } = useAuth();
  const { canPlatform } = usePrivileges();
  const canSuspend = canPlatform("users.suspend");
  // The edit form PATCHes /api/admin/users/:id — server-gated to users.manage,
  // with role/platformRole changes additionally requiring users.assignRoles.
  // Mirror both client-side so a viewAll-only role (support/sales) sees a
  // read-only form instead of editable fields + a Save that always 403s.
  const canManageUsers = canPlatform("users.manage");
  const canAssignRoles = canPlatform("users.assignRoles");
  const rolesDisabled = !canManageUsers || !canAssignRoles;
  const hasPassword = (firebaseUser?.providerData ?? []).some((p) => p.providerId === "password");
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [suspendNameConfirm, setSuspendNameConfirm] = useState("");
  const [suspendPassword, setSuspendPassword] = useState("");
  const [showSuspendPassword, setShowSuspendPassword] = useState(false);
  const [suspendError, setSuspendError] = useState("");
  const [suspendBusy, setSuspendBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteNameConfirm, setDeleteNameConfirm] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [showDeletePassword, setShowDeletePassword] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [createDraft, setCreateDraft] = useState<{
    name: string;
    email: string;
    asOwner: boolean;
    asTenant: boolean;
    asAdmin: boolean;
    platformRole: PlatformRoleKey | "";
  }>({ name: "", email: "", asOwner: true, asTenant: false, asAdmin: false, platformRole: "" });
  const [inviteResult, setInviteResult] = useState<{
    name: string;
    email: string;
    link: string;
  } | null>(null);

  const handleSaveUser = () => {
    if (!editUser) return;
    const isAdmin = editUser.roles.includes("Admin") || editUser.roles.includes("Superadmin");
    const patch: UserUpdate = {
      firstName: editUser.firstName,
      lastName: editUser.lastName,
      phone: editUser.phone,
      address: editUser.address,
      status: (editUser.status?.toLowerCase() as any) ?? undefined,
      roles: editUser.roles?.map((r) => r.toLowerCase() as any),
      platformRole: isAdmin ? (editUser.platformRole ?? null) : null,
    };
    updateUser.mutate(
      { id: editUser.id, patch },
      {
        onSuccess: () => {
          const name = editUser.name;
          setEditUser(null);
          toast({ title: "User updated", description: `${name}'s profile has been saved.` });
        },
        onError: (err: any) =>
          toast({ title: "Update failed", description: err.message, variant: "destructive" }),
      },
    );
  };

  const openSuspendDialog = () => {
    if (!editUser) return;
    setSuspendNameConfirm("");
    setSuspendPassword("");
    setShowSuspendPassword(false);
    setSuspendError("");
    setSuspendOpen(true);
  };

  const openDeleteDialog = () => {
    if (!editUser) return;
    setDeleteNameConfirm("");
    setDeletePassword("");
    setShowDeletePassword(false);
    setDeleteError("");
    setDeleteOpen(true);
  };

  const handleReactivate = () => {
    if (!editUser || updateUser.isPending) return;
    const name = editUser.name;
    updateUser.mutate(
      { id: editUser.id, patch: { status: "active" } },
      {
        onSuccess: () => {
          setEditUser(null);
          toast({ title: "User reactivated", description: `${name} can sign in again.` });
        },
        onError: (err: any) =>
          toast({ title: "Reactivation failed", description: err.message, variant: "destructive" }),
      },
    );
  };

  const suspendReauthError = (err: unknown) => {
    const code = (err as AuthError)?.code;
    switch (code) {
      case "auth/wrong-password":
      case "auth/invalid-credential":
        return "Incorrect password.";
      case "auth/too-many-requests":
        return "Too many attempts. Try again in a moment.";
      case "auth/network-request-failed":
        return "Network error. Check your connection and try again.";
      default:
        return (err as Error)?.message ?? "Something went wrong. Please try again.";
    }
  };

  const handleConfirmSuspend = async () => {
    if (!editUser || suspendBusy) return;
    if (suspendNameConfirm.trim().toLowerCase() !== editUser.name.trim().toLowerCase()) {
      setSuspendError("Name doesn't match.");
      return;
    }
    if (hasPassword && !suspendPassword) {
      setSuspendError("Enter your admin password.");
      return;
    }
    setSuspendError("");
    setSuspendBusy(true);
    try {
      if (hasPassword) {
        if (!firebaseUser?.email) throw new Error("No email on your admin account.");
        const cred = EmailAuthProvider.credential(firebaseUser.email, suspendPassword);
        await reauthenticateWithCredential(firebaseUser, cred);
      }
      await new Promise<void>((resolve, reject) => {
        deleteUser.mutate(
          { id: editUser.id },
          {
            onSuccess: () => {
              const name = editUser.name;
              setSuspendOpen(false);
              setEditUser(null);
              toast({
                title: "User suspended",
                description: `${name}'s status is now Suspended. Data is preserved.`,
              });
              resolve();
            },
            onError: (err: any) => {
              setSuspendError(err?.message ?? "Suspension failed.");
              reject(err);
            },
          },
        );
      });
    } catch (err) {
      if (!suspendError) setSuspendError(suspendReauthError(err));
    } finally {
      setSuspendBusy(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!editUser || deleteBusy) return;
    if (deleteNameConfirm.trim().toLowerCase() !== editUser.name.trim().toLowerCase()) {
      setDeleteError("Name doesn't match.");
      return;
    }
    if (hasPassword && !deletePassword) {
      setDeleteError("Enter your admin password.");
      return;
    }
    setDeleteError("");
    setDeleteBusy(true);
    try {
      if (hasPassword) {
        if (!firebaseUser?.email) throw new Error("No email on your admin account.");
        const cred = EmailAuthProvider.credential(firebaseUser.email, deletePassword);
        await reauthenticateWithCredential(firebaseUser, cred);
      }
      await new Promise<void>((resolve, reject) => {
        deleteUser.mutate(
          { id: editUser.id, hard: true },
          {
            onSuccess: () => {
              const name = editUser.name;
              setDeleteOpen(false);
              setEditUser(null);
              toast({
                title: "User deleted",
                description: `${name}'s account has been permanently removed.`,
              });
              resolve();
            },
            onError: (err: any) => {
              setDeleteError(err?.message ?? "Deletion failed.");
              reject(err);
            },
          },
        );
      });
    } catch (err) {
      if (!deleteError) setDeleteError(suspendReauthError(err));
    } finally {
      setDeleteBusy(false);
    }
  };

  const toggleRole = (role: "Owner" | "Tenant" | "Admin" | "Superadmin") => {
    if (!editUser) return;
    const has = editUser.roles.includes(role);
    const nextRoles = has ? editUser.roles.filter((r) => r !== role) : [...editUser.roles, role];
    setEditUser({ ...editUser, roles: nextRoles });
  };

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const renderEditUserForm = () => {
    if (!editUser) return null;
    return (
      <>
        {/* A disabled fieldset makes EVERY control inside non-interactive when
            the viewer can't manage users — so support/sales (viewAll only) get a
            read-only form. Role/platform-role controls are disabled on a tighter
            gate (users.assignRoles) below. */}
        <fieldset disabled={!canManageUsers} className="p-6 space-y-4 border-0 m-0 min-w-0">
          {!canManageUsers && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300">
              Read-only — you don&apos;t have permission to edit users.
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">First Name</label>
              <input
                type="text"
                value={editUser.firstName}
                onChange={(e) =>
                  setEditUser({
                    ...editUser,
                    firstName: e.target.value,
                    name: e.target.value + " " + editUser.lastName,
                  })
                }
                className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Last Name</label>
              <input
                type="text"
                value={editUser.lastName}
                onChange={(e) =>
                  setEditUser({
                    ...editUser,
                    lastName: e.target.value,
                    name: editUser.firstName + " " + e.target.value,
                  })
                }
                className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Email</label>
            <input
              type="email"
              value={editUser.email}
              onChange={(e) => setEditUser({ ...editUser, email: e.target.value })}
              className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Phone</label>
              <input
                type="text"
                value={editUser.phone}
                onChange={(e) => setEditUser({ ...editUser, phone: e.target.value })}
                className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Status</label>
              {editUser.status === "Suspended" ? (
                // Suspended is set only via the Suspend User flow and cleared
                // only via the Reactivate button — not a value an admin picks
                // from a dropdown.
                <div className="w-full bg-muted/40 border border-input rounded-lg px-3 py-2 text-sm font-medium text-destructive">
                  Suspended
                </div>
              ) : (
                <select
                  value={editUser.status}
                  onChange={(e) =>
                    setEditUser({ ...editUser, status: e.target.value as AdminUserRow["status"] })
                  }
                  className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                >
                  <option value="Active">Active</option>
                  <option value="Pending">Inactive</option>
                  <option value="Invited">Invited</option>
                </select>
              )}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Address</label>
            <input
              type="text"
              value={editUser.address}
              onChange={(e) => setEditUser({ ...editUser, address: e.target.value })}
              className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Plan</label>
              <div className="w-full bg-muted/40 border border-input rounded-lg px-3 py-2 text-sm text-muted-foreground">
                {editUser.plan} <span className="text-xs">(managed in Stripe)</span>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Roles</label>
              <div className="grid grid-cols-2 gap-x-3 gap-y-2 pt-1">
                {(["Owner", "Tenant", "Admin", "Superadmin"] as const)
                  .filter((role) => !(role === "Admin" && editUser.roles.includes("Superadmin")))
                  .map((role) => {
                    const id = `edit-role-${role.toLowerCase()}`;
                    return (
                      <div key={role} className="flex items-center gap-2">
                        <Checkbox
                          id={id}
                          checked={editUser.roles.includes(role)}
                          onCheckedChange={() => toggleRole(role)}
                          disabled={rolesDisabled}
                        />
                        <Label
                          htmlFor={id}
                          className="text-sm font-normal text-foreground cursor-pointer"
                        >
                          {role}
                        </Label>
                      </div>
                    );
                  })}
              </div>
            </div>
          </div>
          {(editUser.roles.includes("Admin") || editUser.roles.includes("Superadmin")) && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Platform role
              </label>
              <select
                value={editUser.platformRole ?? ""}
                disabled={rolesDisabled}
                onChange={(e) =>
                  setEditUser({
                    ...editUser,
                    platformRole: (e.target.value || null) as PlatformRoleKey | null,
                  })
                }
                className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <option value="">Full admin (no sub-role)</option>
                {PLATFORM_ROLES.filter((r) => r !== "admin").map((r) => (
                  <option key={r} value={r}>
                    {r[0].toUpperCase() + r.slice(1)}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                Drives the Platform Roles privilege matrix. Superadmin bypasses it.
              </p>
            </div>
          )}
        </fieldset>
        <div className="p-6 border-t border-border space-y-3">
          <button
            onClick={() => {
              handleViewAsUser(editUser);
              setEditUser(null);
            }}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition"
          >
            <Eye size={16} />
            View As {editUser.name}
          </button>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex gap-2">
              <button
                type="button"
                disabled={resettingPassword}
                onClick={async () => {
                  setResettingPassword(true);
                  try {
                    await apiRequest("POST", `/api/admin/users/${editUser.id}/send-reset-email`);
                    toast({
                      title: "Reset email sent",
                      description: `Branded reset link sent to ${editUser.email}.`,
                    });
                  } catch (err) {
                    toast({
                      title: "Could not send reset email",
                      description: (err as Error)?.message ?? "Try again.",
                      variant: "destructive",
                    });
                  } finally {
                    setResettingPassword(false);
                  }
                }}
                className="px-4 py-2 border border-border text-foreground rounded-lg text-sm font-medium hover:bg-muted transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {resettingPassword ? "Sending…" : "Reset Password"}
              </button>
              {canSuspend &&
                (editUser.status === "Suspended" ? (
                  <button
                    type="button"
                    disabled={updateUser.isPending}
                    onClick={handleReactivate}
                    className="px-4 py-2 bg-success text-success-foreground rounded-lg text-sm font-medium hover:bg-success/90 transition disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {updateUser.isPending ? "Reactivating…" : "Reactivate"}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={deleteUser.isPending}
                    onClick={openSuspendDialog}
                    className="px-4 py-2 bg-destructive text-destructive-foreground rounded-lg text-sm font-medium hover:bg-destructive/90 transition disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {deleteUser.isPending ? "Suspending…" : "Suspend User"}
                  </button>
                ))}
              {canSuspend && (
                <button
                  type="button"
                  disabled={deleteUser.isPending}
                  onClick={openDeleteDialog}
                  className="px-4 py-2 bg-destructive text-destructive-foreground rounded-lg text-sm font-medium hover:bg-destructive/90 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Delete User
                </button>
              )}
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setEditUser(null)}
                className="px-4 py-2 border border-border rounded-lg text-sm font-medium hover:bg-muted transition"
              >
                Cancel
              </button>
              {canManageUsers && (
                <button
                  type="button"
                  disabled={updateUser.isPending}
                  onClick={handleSaveUser}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {updateUser.isPending ? "Saving..." : "Save Changes"}
                </button>
              )}
            </div>
          </div>
        </div>
      </>
    );
  };

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const filteredUsers = users.filter((user) => {
    const matchesSearch =
      user.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      user.email.toLowerCase().includes(searchTerm.toLowerCase());
    let matchesFilter = true;
    if (activeFilter === "Active") matchesFilter = user.status === "Active";
    // "Inactive" in the UI is the schema's "pending" — a user who exists but
    // hasn't accepted an invite or activated their account yet.
    else if (activeFilter === "Inactive") matchesFilter = user.status === "Pending";
    else if (activeFilter === "Invited") matchesFilter = user.status === "Invited";
    else if (activeFilter === "Suspended") matchesFilter = user.status === "Suspended";
    else if (activeFilter === "Owner") matchesFilter = user.roles.includes("Owner");
    else if (activeFilter === "Tenant") matchesFilter = user.roles.includes("Tenant");
    else if (activeFilter === "Admin")
      matchesFilter = user.roles.includes("Admin") || user.roles.includes("Superadmin");
    return matchesSearch && matchesFilter;
  });

  const sortedUsers = [...filteredUsers].sort((a, b) => {
    if (!sortKey) return 0;
    const dir = sortDir === "asc" ? 1 : -1;
    const valA = (a as any)[sortKey];
    const valB = (b as any)[sortKey];
    if (typeof valA === "number" && typeof valB === "number") return (valA - valB) * dir;
    return String(valA).localeCompare(String(valB)) * dir;
  });

  const handleCreateUser = (e: React.FormEvent) => {
    e.preventDefault();
    const name = createDraft.name.trim();
    const email = createDraft.email.trim().toLowerCase();
    if (!name || !email) {
      toast({
        title: "Missing info",
        description: "Name and email are required.",
        variant: "destructive",
      });
      return;
    }
    const roles = [
      createDraft.asOwner ? "owner" : null,
      createDraft.asTenant ? "tenant" : null,
      createDraft.asAdmin ? "admin" : null,
    ].filter(Boolean) as Array<"owner" | "tenant" | "admin">;
    if (roles.length === 0) {
      toast({
        title: "Pick a role",
        description: "Select at least one role.",
        variant: "destructive",
      });
      return;
    }
    const [firstName, ...rest] = name.split(/\s+/);
    const lastName = rest.join(" ");
    inviteUser.mutate(
      {
        email,
        firstName,
        lastName,
        roles,
        platformRole:
          createDraft.asAdmin && createDraft.platformRole ? createDraft.platformRole : undefined,
      },
      {
        onSuccess: ({ user, inviteLink }) => {
          setIsCreateOpen(false);
          setCreateDraft({
            name: "",
            email: "",
            asOwner: true,
            asTenant: false,
            asAdmin: false,
            platformRole: "",
          });
          setInviteResult({
            name: `${user.firstName} ${user.lastName}`.trim() || user.email,
            email: user.email,
            link: inviteLink,
          });
        },
        onError: (err: any) =>
          toast({ title: "Invite failed", description: err.message, variant: "destructive" }),
      },
    );
  };

  const copyInviteLink = async () => {
    if (!inviteResult) return;
    try {
      await navigator.clipboard.writeText(inviteResult.link);
      toast({
        title: "Backup link copied",
        description:
          "Only needed if the invite email didn't arrive — send it to the user directly.",
      });
    } catch {
      toast({
        title: "Copy failed",
        description: "Select the link manually and copy.",
        variant: "destructive",
      });
    }
  };

  // Opens the typed-confirm dialog. The actual token mint happens in
  // performImpersonation only after the admin types the target's name.
  const handleViewAsUser = (user: AdminUserRow) => {
    setImpersonateTarget(user);
    setImpersonateNameConfirm("");
  };

  // Real impersonation: ask the server for a Firebase custom token, then open
  // the user app in a new tab with the token in the URL fragment. The new tab
  // signs into app.oliowallet.com as the target user; the admin's platform
  // session stays put (different origin = separate Firebase Auth state).
  // Every successful call writes an audit doc to COL.impersonations server-side.
  const performImpersonation = async (user: AdminUserRow) => {
    setImpersonateBusy(true);
    try {
      const res = await apiRequest("POST", `/api/admin/users/${user.id}/impersonate`);
      const { customToken } = (await res.json()) as { customToken: string };
      const host = window.location.hostname;
      const appOrigin =
        host === "localhost" || host === "127.0.0.1"
          ? "http://localhost:5102"
          : host.endsWith(".web.app")
            ? "https://oliowallet-app.web.app"
            : "https://app.oliowallet.com";
      const url = `${appOrigin}/auth/impersonate#token=${encodeURIComponent(customToken)}`;
      window.open(url, "_blank", "noopener,noreferrer");
      toast({
        title: `Opening session as ${user.name}`,
        description: "A new tab will sign in as this user. Your admin tab stays signed in.",
      });
      setImpersonateTarget(null);
      setImpersonateNameConfirm("");
    } catch (err) {
      toast({
        title: "Impersonation blocked",
        description: parseApiError(err, "Could not start impersonation"),
        variant: "destructive",
      });
    } finally {
      setImpersonateBusy(false);
    }
  };

  if (!canPlatform("users.viewAll")) {
    return (
      <div className={PAGE_CONTAINER_CLASSNAME}>
        <ForbiddenView
          title="Users locked"
          message="Your platform role doesn't include the 'View all users' privilege. An admin can grant it in Settings → Platform Roles."
        />
      </div>
    );
  }

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <div className="mb-8 md:mb-2 mt-4 md:mt-0">
        <div className="md:hidden">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Users</h1>
          <p className="text-muted-foreground mt-1 text-sm md:text-base">
            Manage platform users and roles
          </p>
        </div>
      </div>
      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Create New User</DialogTitle>
            <DialogDescription>
              Fill in the details to create a new user. They will receive an email to set up their
              password.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateUser} className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label htmlFor="name">Full Name</Label>
              <Input
                id="name"
                placeholder="e.g. Jane Doe"
                required
                value={createDraft.name}
                onChange={(e) => setCreateDraft({ ...createDraft, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email Address</Label>
              <Input
                id="email"
                type="email"
                placeholder="jane@example.com"
                required
                value={createDraft.email}
                onChange={(e) => setCreateDraft({ ...createDraft, email: e.target.value })}
              />
            </div>

            <div className="space-y-3 pt-2">
              <Label>User Roles (Select at least one)</Label>
              <div className="flex flex-col gap-2">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="role-owner"
                    checked={createDraft.asOwner}
                    onCheckedChange={(checked) =>
                      setCreateDraft({ ...createDraft, asOwner: checked === true })
                    }
                  />
                  <Label htmlFor="role-owner" className="font-normal cursor-pointer">
                    Owner
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="role-tenant"
                    checked={createDraft.asTenant}
                    onCheckedChange={(checked) =>
                      setCreateDraft({ ...createDraft, asTenant: checked === true })
                    }
                  />
                  <Label htmlFor="role-tenant" className="font-normal cursor-pointer">
                    Tenant
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="role-admin"
                    checked={createDraft.asAdmin}
                    onCheckedChange={(checked) =>
                      setCreateDraft({
                        ...createDraft,
                        asAdmin: checked === true,
                        platformRole: checked === true ? createDraft.platformRole : "",
                      })
                    }
                  />
                  <Label htmlFor="role-admin" className="font-normal cursor-pointer">
                    Admin (platform staff)
                  </Label>
                </div>
              </div>
              {createDraft.asAdmin && (
                <div className="space-y-2 pt-1 pl-6">
                  <Label htmlFor="platform-role" className="text-xs text-muted-foreground">
                    Platform role (drives the privilege matrix)
                  </Label>
                  <select
                    id="platform-role"
                    value={createDraft.platformRole}
                    onChange={(e) =>
                      setCreateDraft({
                        ...createDraft,
                        platformRole: e.target.value as PlatformRoleKey | "",
                      })
                    }
                    className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                  >
                    <option value="">Full admin (no sub-role)</option>
                    {PLATFORM_ROLES.filter((r) => r !== "admin").map((r) => (
                      <option key={r} value={r}>
                        {r[0].toUpperCase() + r.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <DialogFooter className="pt-4">
              <button
                type="button"
                onClick={() => setIsCreateOpen(false)}
                className="px-4 py-2 border border-border rounded-lg text-sm font-medium hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={inviteUser.isPending}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
              >
                {inviteUser.isPending ? "Creating…" : "Create & Invite"}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Invite-link Result Modal — shown after successful create */}
      <Dialog open={!!inviteResult} onOpenChange={(open) => !open && setInviteResult(null)}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Invite sent</DialogTitle>
            <DialogDescription>
              {inviteResult ? (
                <>
                  We've emailed the invite to{" "}
                  <span className="font-medium text-foreground">{inviteResult.name}</span> at{" "}
                  <span className="font-medium text-foreground">{inviteResult.email}</span> —
                  they'll click it to set their password and sign in. If it doesn't arrive, copy the
                  backup link below and send it directly.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          {inviteResult && (
            <div className="space-y-4 pt-2">
              <div className="rounded-lg bg-muted p-3 text-xs font-mono break-all border border-border">
                {inviteResult.link}
              </div>
              <p className="text-xs text-muted-foreground">
                ⚠ Backup link — only needed if the email doesn't arrive. It's shown only once, so
                save it before closing if you think you'll need it. It expires after the user uses
                it (or after Firebase's default expiry, typically 1 hour).
              </p>
            </div>
          )}
          <DialogFooter className="pt-4 gap-2">
            <button
              type="button"
              onClick={() => setInviteResult(null)}
              className="px-4 py-2 border border-border rounded-lg text-sm font-medium hover:bg-muted"
            >
              Close
            </button>
            <button
              type="button"
              onClick={copyInviteLink}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 inline-flex items-center gap-2"
            >
              <Copy size={14} /> Copy backup link
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View User Modal */}
      {/* View User Modal */}
      <Dialog open={!!viewUser} onOpenChange={(open) => !open && setViewUser(null)}>
        <DialogContent className="sm:max-w-[425px]">
          <div className="absolute right-12 top-4">
            <button
              className="rounded-sm opacity-70 hover:opacity-100 transition-opacity"
              onClick={() => {
                setEditUser(viewUser);
                setViewUser(null);
              }}
            >
              <Edit size={16} />
              <span className="sr-only">Edit</span>
            </button>
          </div>
          <DialogHeader>
            <DialogTitle>User Details</DialogTitle>
          </DialogHeader>
          {viewUser && (
            <div className="space-y-4 pt-2">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-muted-foreground">First Name</div>
                  <div className="font-medium text-foreground">{viewUser.firstName}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Last Name</div>
                  <div className="font-medium text-foreground">{viewUser.lastName}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Phone</div>
                  <div className="font-medium text-foreground">{viewUser.phone}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Address</div>
                  <div className="font-medium text-foreground">{viewUser.address}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Status</div>
                  <div
                    className={`font-medium ${viewUser.status === "Active" ? "text-emerald-500" : viewUser.status === "Suspended" ? "text-destructive" : "text-muted-foreground"}`}
                  >
                    {displayStatus(viewUser.status)}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">Plan</div>
                  <div className="font-medium text-foreground">{viewUser.plan}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Roles</div>
                  <div className="font-medium text-foreground">{viewUser.roles.join(", ")}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Joined</div>
                  <div className="font-medium text-foreground">
                    {formatDateNumeric(viewUser.joinDate)}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">Last Seen</div>
                  <div
                    className={`font-medium ${isUserOnline(viewUser.lastSeenAt) ? "text-emerald-500" : "text-foreground"}`}
                  >
                    {isUserOnline(viewUser.lastSeenAt) ? "Currently in the app" : viewUser.lastSeen}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">Last Login</div>
                  <div className="font-medium text-foreground">{viewUser.lastLogin}</div>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit User - Desktop Modal */}
      {editUser && (
        <div className="hidden md:flex fixed inset-0 bg-black/50 z-50 items-center justify-center p-4">
          <div className="bg-card rounded-xl border border-border shadow-xl w-full max-w-md overflow-hidden">
            <div className="p-6 border-b border-border flex justify-between items-center bg-muted/30">
              <h3 className="font-bold text-lg text-foreground">Edit User</h3>
              <button
                onClick={() => setEditUser(null)}
                className="text-muted-foreground hover:text-foreground p-1 rounded-md hover:bg-secondary transition"
              >
                ✕
              </button>
            </div>
            {renderEditUserForm()}
          </div>
        </div>
      )}

      {/* Suspend User Confirmation Dialog */}
      <Dialog
        open={suspendOpen}
        onOpenChange={(open) => {
          if (suspendBusy) return;
          setSuspendOpen(open);
          if (!open) {
            setSuspendNameConfirm("");
            setSuspendPassword("");
            setShowSuspendPassword(false);
            setSuspendError("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-foreground">
              <AlertTriangle size={20} className="text-destructive" />
              Suspend {editUser?.name}?
            </DialogTitle>
            <DialogDescription>
              This sets the user's status to{" "}
              <span className="font-medium text-foreground">Suspended</span>. They lose access
              immediately, but their data is preserved and they can be reactivated later.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 mt-2">
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-muted-foreground">
              <p>
                <span className="font-semibold text-destructive">Heads up:</span> active sessions,
                ongoing rentals, and pending payouts may be disrupted. Make sure this is the right
                call.
              </p>
            </div>

            <div>
              <label className="text-sm font-medium text-foreground mb-1.5 block">
                Type <span className="font-mono text-destructive">{editUser?.name}</span> to confirm
              </label>
              <input
                type="text"
                value={suspendNameConfirm}
                onChange={(e) => {
                  setSuspendNameConfirm(e.target.value);
                  setSuspendError("");
                }}
                placeholder={editUser?.name ?? ""}
                autoComplete="off"
                className="w-full px-4 py-2.5 rounded-lg border border-border bg-muted text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>

            {hasPassword && (
              <div>
                <label className="text-sm font-medium text-foreground mb-1.5 block">
                  Your admin password
                </label>
                <div className="relative">
                  <input
                    type={showSuspendPassword ? "text" : "password"}
                    value={suspendPassword}
                    onChange={(e) => {
                      setSuspendPassword(e.target.value);
                      setSuspendError("");
                    }}
                    placeholder="Enter your password"
                    className="w-full px-4 py-2.5 rounded-lg border border-border bg-muted text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 pr-10"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !suspendBusy) void handleConfirmSuspend();
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowSuspendPassword((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showSuspendPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
            )}

            {suspendError && <p className="text-xs text-destructive">{suspendError}</p>}
          </div>

          <div className="flex gap-3 mt-4">
            <button
              type="button"
              onClick={() => setSuspendOpen(false)}
              disabled={suspendBusy}
              className="flex-1 py-2.5 rounded-lg border border-border text-sm font-semibold text-foreground hover:bg-muted transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleConfirmSuspend()}
              disabled={
                suspendBusy ||
                !suspendNameConfirm ||
                suspendNameConfirm.trim().toLowerCase() !==
                  (editUser?.name ?? "").trim().toLowerCase() ||
                (hasPassword && !suspendPassword)
              }
              className="flex-1 py-2.5 rounded-lg bg-destructive text-destructive-foreground text-sm font-semibold hover:bg-destructive/90 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {suspendBusy ? "Suspending…" : "Suspend User"}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete User Confirmation Dialog */}
      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (deleteBusy) return;
          setDeleteOpen(open);
          if (!open) {
            setDeleteNameConfirm("");
            setDeletePassword("");
            setShowDeletePassword(false);
            setDeleteError("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-foreground">
              <AlertTriangle size={20} className="text-destructive" />
              Delete {editUser?.name}?
            </DialogTitle>
            <DialogDescription>
              This <span className="font-medium text-foreground">permanently removes</span> the
              account and sign-in credentials. The user must have no properties and no active
              agreements (as owner or tenant).
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 mt-2">
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-muted-foreground">
              <p>
                <span className="font-semibold text-destructive">Heads up:</span> this cannot be
                undone. If you might want to restore access later, use Suspend instead.
              </p>
            </div>

            <div>
              <label className="text-sm font-medium text-foreground mb-1.5 block">
                Type <span className="font-mono text-destructive">{editUser?.name}</span> to confirm
              </label>
              <input
                type="text"
                value={deleteNameConfirm}
                onChange={(e) => {
                  setDeleteNameConfirm(e.target.value);
                  setDeleteError("");
                }}
                placeholder={editUser?.name ?? ""}
                autoComplete="off"
                className="w-full px-4 py-2.5 rounded-lg border border-border bg-muted text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>

            {hasPassword && (
              <div>
                <label className="text-sm font-medium text-foreground mb-1.5 block">
                  Your admin password
                </label>
                <div className="relative">
                  <input
                    type={showDeletePassword ? "text" : "password"}
                    value={deletePassword}
                    onChange={(e) => {
                      setDeletePassword(e.target.value);
                      setDeleteError("");
                    }}
                    placeholder="Enter your password"
                    className="w-full px-4 py-2.5 rounded-lg border border-border bg-muted text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 pr-10"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !deleteBusy) void handleConfirmDelete();
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowDeletePassword((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showDeletePassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
            )}

            {deleteError && <p className="text-xs text-destructive">{deleteError}</p>}
          </div>

          <div className="flex gap-3 mt-4">
            <button
              type="button"
              onClick={() => setDeleteOpen(false)}
              disabled={deleteBusy}
              className="flex-1 py-2.5 rounded-lg border border-border text-sm font-semibold text-foreground hover:bg-muted transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleConfirmDelete()}
              disabled={
                deleteBusy ||
                !deleteNameConfirm ||
                deleteNameConfirm.trim().toLowerCase() !==
                  (editUser?.name ?? "").trim().toLowerCase() ||
                (hasPassword && !deletePassword)
              }
              className="flex-1 py-2.5 rounded-lg bg-destructive text-destructive-foreground text-sm font-semibold hover:bg-destructive/90 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {deleteBusy ? "Deleting…" : "Delete User"}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Impersonation confirmation */}
      <Dialog
        open={!!impersonateTarget}
        onOpenChange={(open) => {
          if (open || impersonateBusy) return;
          setImpersonateTarget(null);
          setImpersonateNameConfirm("");
        }}
      >
        <DialogContent className="sm:max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-foreground">
              <Eye size={20} />
              View as {impersonateTarget?.name}?
            </DialogTitle>
            <DialogDescription>
              You're about to open a session as this user. The action is logged to the impersonation
              audit trail with your name and timestamp.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 mt-2">
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
              <p>
                <span className="font-semibold">Heads up:</span> a new tab will sign in as{" "}
                {impersonateTarget?.name}. Your admin tab stays signed in. Close the impersonated
                tab when you're done.
              </p>
            </div>

            <div>
              <label className="text-sm font-medium text-foreground mb-1.5 block">
                Type <span className="font-mono text-foreground">{impersonateTarget?.name}</span> to
                confirm
              </label>
              <input
                type="text"
                value={impersonateNameConfirm}
                onChange={(e) => setImpersonateNameConfirm(e.target.value)}
                placeholder={impersonateTarget?.name ?? ""}
                autoComplete="off"
                className="w-full px-4 py-2.5 rounded-lg border border-border bg-muted text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !impersonateBusy &&
                    impersonateTarget &&
                    impersonateNameConfirm.trim().toLowerCase() ===
                      impersonateTarget.name.trim().toLowerCase()
                  ) {
                    void performImpersonation(impersonateTarget);
                  }
                }}
              />
            </div>
          </div>

          <div className="flex gap-3 mt-4">
            <button
              type="button"
              onClick={() => {
                setImpersonateTarget(null);
                setImpersonateNameConfirm("");
              }}
              disabled={impersonateBusy}
              className="flex-1 py-2.5 rounded-lg border border-border text-sm font-semibold text-foreground hover:bg-muted transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => impersonateTarget && void performImpersonation(impersonateTarget)}
              disabled={
                impersonateBusy ||
                !impersonateTarget ||
                impersonateNameConfirm.trim().toLowerCase() !==
                  (impersonateTarget?.name ?? "").trim().toLowerCase()
              }
              className="flex-1 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {impersonateBusy ? "Opening…" : "View As User"}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit User - Mobile Drawer */}
      <Drawer.Root
        open={!!editUser && isMobile}
        onOpenChange={(open) => {
          if (!open) setEditUser(null);
        }}
      >
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 bg-black/40 z-50 md:hidden" />
          <Drawer.Content
            className="fixed bottom-0 left-0 right-0 z-50 md:hidden"
            style={{ maxHeight: "75vh" }}
          >
            <div
              className="bg-card rounded-t-2xl border-t border-border overflow-y-auto overscroll-contain"
              style={{ maxHeight: "75vh" }}
            >
              <div className="w-10 h-1 bg-muted-foreground/30 rounded-full mx-auto mt-3 mb-1" />
              <div className="p-5 pb-2 flex justify-between items-center">
                <h3 className="font-bold text-lg text-foreground">Edit User</h3>
                <button
                  onClick={() => setEditUser(null)}
                  className="text-muted-foreground hover:text-foreground p-1 rounded-md hover:bg-secondary transition"
                >
                  ✕
                </button>
              </div>
              {editUser && renderEditUserForm()}
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>

      {/* Filters & Search */}
      <TableFiltersCard>
        <div className="flex flex-col md:flex-row gap-4 items-center">
          <div className="relative flex-1 w-full">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="text"
              placeholder="Search users..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-muted border-none rounded-lg pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
            />
          </div>
        </div>
        <FilterPills
          options={[
            "All",
            "Active",
            "Inactive",
            "Invited",
            "Suspended",
            "Owner",
            "Tenant",
            "Admin",
          ].map((t) => ({ id: t, label: t }))}
          value={activeFilter}
          onChange={setActiveFilter}
        />
      </TableFiltersCard>

      {isError ? (
        <AdminListError onRetry={() => refetch()} message="We couldn't load users." />
      ) : isLoading ? (
        <AdminListLoading />
      ) : (
        <>
          {/* Mobile List */}
          <div className="md:hidden bg-card border border-border rounded-xl shadow-sm overflow-hidden divide-y divide-border">
            {sortedUsers.map((user) => {
              const online = isUserOnline(user.lastSeenAt);
              return (
                <button
                  key={user.id}
                  type="button"
                  className="w-full text-left flex items-center gap-3 px-4 py-3 active:bg-muted/50 transition cursor-pointer"
                  onClick={() => setEditUser(user)}
                >
                  <div className="relative shrink-0">
                    <Avatar src={user.photoURL} name={user.name} email={user.email} size="md" />
                    <span
                      className={`absolute -bottom-0.5 -right-0.5 block w-3 h-3 rounded-full ring-2 ring-card ${
                        online ? "bg-emerald-500" : "bg-muted-foreground/40"
                      }`}
                      aria-label={online ? "Online" : "Offline"}
                    />
                  </div>
                  <span className="font-medium text-foreground text-sm truncate">{user.name}</span>
                </button>
              );
            })}
          </div>

          {/* Desktop Table */}
          <div className="hidden md:block">
            <TableShellCard>
              <div className="overflow-x-auto">
                <div className="inline-block min-w-full align-middle">
                  <table className="w-full text-left text-sm whitespace-nowrap table-fixed">
                    <thead className="bg-muted border-b border-border">
                      <tr>
                        <th
                          className="px-3 py-3 font-semibold text-foreground w-[20%] cursor-pointer select-none hover:bg-secondary/50 transition"
                          {...sortableThProps(handleSort, "name")}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            User <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="name" />
                          </span>
                        </th>
                        <th
                          className="px-2 py-3 font-semibold text-foreground w-[8%] cursor-pointer select-none hover:bg-secondary/50 transition"
                          {...sortableThProps(handleSort, "status")}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            Status{" "}
                            <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="status" />
                          </span>
                        </th>
                        <th
                          className="px-2 py-3 font-semibold text-foreground w-[7%] cursor-pointer select-none hover:bg-secondary/50 transition"
                          {...sortableThProps(handleSort, "plan")}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            Plan <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="plan" />
                          </span>
                        </th>
                        <th
                          className="px-2 py-3 font-semibold text-foreground hidden lg:table-cell w-[11%] cursor-pointer select-none hover:bg-secondary/50 transition"
                          {...sortableThProps(handleSort, "lastSeenAt")}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            Last Seen{" "}
                            <TableSortIcon
                              sortKey={sortKey}
                              sortDir={sortDir}
                              column="lastSeenAt"
                            />
                          </span>
                        </th>
                        <th
                          className="px-2 py-3 font-semibold text-foreground hidden lg:table-cell w-[11%] cursor-pointer select-none hover:bg-secondary/50 transition"
                          {...sortableThProps(handleSort, "lastLoginAt")}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            Last Login{" "}
                            <TableSortIcon
                              sortKey={sortKey}
                              sortDir={sortDir}
                              column="lastLoginAt"
                            />
                          </span>
                        </th>
                        <th
                          className="px-2 py-3 font-semibold text-foreground hidden xl:table-cell w-[10%] cursor-pointer select-none hover:bg-secondary/50 transition"
                          {...sortableThProps(handleSort, "joinDate")}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            Joined{" "}
                            <TableSortIcon sortKey={sortKey} sortDir={sortDir} column="joinDate" />
                          </span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {sortedUsers.map((user) => {
                        const online = isUserOnline(user.lastSeenAt);
                        return (
                          <tr
                            key={user.id}
                            className="hover:bg-muted/50 transition cursor-pointer"
                            onClick={() => setEditUser(user)}
                          >
                            <td className="px-3 py-3">
                              <div className="flex items-center gap-2">
                                <div className="relative shrink-0">
                                  <Avatar
                                    src={user.photoURL}
                                    name={user.name}
                                    email={user.email}
                                    size="xs"
                                  />
                                  <span
                                    className={`absolute -bottom-0.5 -right-0.5 block w-2.5 h-2.5 rounded-full ring-2 ring-card ${
                                      online ? "bg-emerald-500" : "bg-muted-foreground/40"
                                    }`}
                                    title={
                                      online ? "Currently in the app" : "Not currently in the app"
                                    }
                                    aria-label={online ? "Online" : "Offline"}
                                  />
                                </div>
                                <div className="truncate">
                                  <div className="font-medium text-foreground truncate">
                                    {user.name}
                                  </div>
                                  <div className="text-xs text-muted-foreground truncate">
                                    {user.email}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td className="px-2 py-3">
                              <span
                                className={`text-sm font-medium ${
                                  user.status === "Active"
                                    ? "text-emerald-500"
                                    : user.status === "Suspended"
                                      ? "text-destructive"
                                      : "text-muted-foreground"
                                }`}
                              >
                                {displayStatus(user.status)}
                              </span>
                            </td>
                            <td className="px-2 py-3">
                              <span className="text-muted-foreground font-medium">{user.plan}</span>
                            </td>
                            <td className="px-2 py-3 hidden lg:table-cell">
                              <span
                                className={
                                  online ? "text-emerald-500 font-medium" : "text-muted-foreground"
                                }
                              >
                                {online ? "Now" : user.lastSeen}
                              </span>
                            </td>
                            <td className="px-2 py-3 text-muted-foreground hidden lg:table-cell">
                              {user.lastLogin}
                            </td>
                            <td className="px-2 py-3 text-muted-foreground hidden xl:table-cell">
                              {formatDateNumeric(user.joinDate)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </TableShellCard>
            {sortedUsers.length === 0 && (
              <TableEmptyState
                icon={<UsersIcon size={24} className="opacity-50" />}
                title="No users found"
                description="Try adjusting your filters"
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
