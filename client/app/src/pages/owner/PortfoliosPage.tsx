import { useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import {
  AlertCircle,
  Building2,
  ChevronRight,
  Eye,
  FolderKanban,
  Link2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";

import { HeaderActions, PAGE_CONTAINER_CLASSNAME } from "@/components/common/AppLayout";
import { useConfirm } from "@ui/components/common/ConfirmDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@ui/components/ui/dropdown-menu";
import { PALETTE } from "@/components/owner/dashboard/tokens";
import { DashSkeleton } from "@/components/owner/dashboard/ui";
import { AssignProjectDialog } from "@/components/owner/AssignProjectDialog";
import { DeletePropertyDialog } from "@/components/owner/DeletePropertyDialog";
import { EditPropertyDrawer } from "@/components/owner/EditPropertyDrawer";
import { ProjectDetailsDrawer } from "@/components/owner/ProjectDetailsDrawer";
import { ProjectDialog } from "@/components/owner/ProjectDialog";
import { PortfolioOverview } from "@/components/owner/portfolio/PortfolioOverview";
import { DARK_CARD, StatusChip, money, pct } from "@/components/owner/property/ui";
import { useActivePortfolio } from "@/lib/activePortfolio";
import { useOwnerProperties, type OwnerProperty } from "@/lib/ownerQueries";
import { useDeleteProject, useProjects } from "@/lib/projects";
import type { Project } from "@shared/firestore-schema";
import { useToast } from "@ui/hooks/use-toast";
import { parseApiError } from "@ui/lib/queryClient";
import { cn } from "@ui/lib/utils";

type Ownership = "all" | "company" | "personal";
type Lifecycle = "active" | "archived";
type TypeTab = "all" | "Apartment" | "House" | "Commercial" | "Building" | "Other";
// "all" | "none" (unassigned) | Project.id
type ProjectFilter = string;

const TYPE_TABS: { id: TypeTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "Apartment", label: "Apartment" },
  { id: "House", label: "House" },
  { id: "Commercial", label: "Commercial" },
  { id: "Building", label: "Building" },
  { id: "Other", label: "Other" },
];

const GRID =
  "md:grid md:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)_minmax(0,1fr)_90px_90px_70px_minmax(0,1fr)_64px] md:items-center md:gap-4";

function label(property: OwnerProperty): string {
  return property.name?.trim() || property.address?.trim() || "Untitled property";
}

function ownerLabel(property: OwnerProperty): string {
  if (property.ownershipType === "company" && property.companyName) return property.companyName;
  return "Personal";
}

function unitCount(property: OwnerProperty): number {
  return Math.max(1, property.unitCount ?? 0);
}

function typeLabel(property: OwnerProperty): string {
  if (unitCount(property) > 1 || property.propertyType === "Building") return "Building";
  return property.propertyType ?? "Other";
}

// Villa / Plot / unspecified fall under "Other" in the tab strip.
function typeTab(property: OwnerProperty): Exclude<TypeTab, "all"> {
  const t = typeLabel(property);
  return t === "Apartment" || t === "House" || t === "Commercial" || t === "Building" ? t : "Other";
}

function owns(property: OwnerProperty, ownership: Ownership): boolean {
  if (ownership === "all") return true;
  return ownership === "company"
    ? property.ownershipType === "company"
    : property.ownershipType !== "company";
}

interface Row {
  property: OwnerProperty;
  name: string;
  type: string;
  monthly: number;
  yieldPct: number | null;
  totalUnits: number;
  letUnits: number;
  status: { tone: "green" | "amber" | "coral" | "muted"; text: string };
  searchText: string;
}

const MENU_ITEM = "flex cursor-pointer items-center gap-2 text-sm";

export default function PortfoliosPage() {
  const propertiesQuery = useOwnerProperties();
  const { isSelf } = useActivePortfolio();
  const projectsQuery = useProjects(isSelf);
  const deleteProject = useDeleteProject();
  const { confirm, dialog } = useConfirm();
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeTab>("all");
  const [projectFilter, setProjectFilter] = useState<ProjectFilter>("all");
  const [lifecycle, setLifecycle] = useState<Lifecycle>("active");
  const search = useSearch();
  const [, navigate] = useLocation();

  const [editingProperty, setEditingProperty] = useState<OwnerProperty | null>(null);
  const [deletingProperty, setDeletingProperty] = useState<OwnerProperty | null>(null);
  const [assigningProperty, setAssigningProperty] = useState<OwnerProperty | null>(null);
  const [viewingProject, setViewingProject] = useState<Project | null>(null);
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);

  // Ownership filter lives in the URL (?ownership=company|personal) so the
  // property-page breadcrumb ("Company-owned") can link back to it.
  const ownership: Ownership = useMemo(() => {
    const value = new URLSearchParams(search).get("ownership");
    return value === "company" || value === "personal" ? value : "all";
  }, [search]);
  // Bare /portfolios shows the overview dashboard; ?view=all or an ownership
  // filter shows the full asset list.
  const showOverview = ownership === "all" && new URLSearchParams(search).get("view") !== "all";
  const setOwnership = (value: Ownership) =>
    navigate(value === "all" ? "/portfolios?view=all" : `/portfolios?ownership=${value}`, {
      replace: true,
    });

  const properties = useMemo(() => propertiesQuery.data ?? [], [propertiesQuery.data]);
  const projects = useMemo(
    () => (isSelf ? (projectsQuery.data?.projects ?? []) : []),
    [isSelf, projectsQuery.data?.projects],
  );
  const selectedProject =
    projectFilter !== "all" && projectFilter !== "none"
      ? (projects.find((project) => project.id === projectFilter) ?? null)
      : null;

  // Units are full Property docs; the table lists top-level assets and rolls
  // unit rent/occupancy up into their building.
  const topLevelProperties = useMemo(
    () => properties.filter((property) => !property.parentPropertyId),
    [properties],
  );
  const unitsByParent = useMemo(() => {
    const map = new Map<string, OwnerProperty[]>();
    for (const property of properties) {
      if (!property.parentPropertyId) continue;
      const list = map.get(property.parentPropertyId) ?? [];
      list.push(property);
      map.set(property.parentPropertyId, list);
    }
    return map;
  }, [properties]);

  const records = useMemo<Row[]>(
    () =>
      topLevelProperties.map((property) => {
        const units = unitsByParent.get(property.id) ?? [];
        const isBuilding = typeLabel(property) === "Building";
        const monthly =
          units.length > 0
            ? units.reduce((sum, unit) => sum + (unit.rentAmount ?? 0), 0)
            : (property.rentAmount ?? 0);
        const value = property.propertyValue ?? 0;
        const yieldPct = value > 0 && monthly > 0 ? ((monthly * 12) / value) * 100 : null;

        const totalUnits =
          units.length > 0 ? Math.max(unitCount(property), units.length) : unitCount(property);
        const letUnits =
          units.length > 0
            ? units.filter((unit) => unit.occupied).length
            : property.tenancyState === "occupied"
              ? 1
              : 0;

        let status: Row["status"];
        if (property.status === "inactive") status = { tone: "muted", text: "Archived" };
        else if (isBuilding && units.length > 0) {
          const total = Math.max(unitCount(property), units.length);
          const let_ = units.filter((unit) => unit.occupied).length;
          status =
            let_ === total
              ? { tone: "green", text: "Occupied" }
              : { tone: let_ === 0 ? "coral" : "amber", text: `${let_}/${total} let` };
        } else if (property.tenancyState === "occupied")
          status = { tone: "green", text: "Occupied" };
        else if (property.tenancyState === "pending") status = { tone: "amber", text: "Pending" };
        else status = { tone: "coral", text: "Vacant" };

        const projectName = property.projectId
          ? projects.find((project) => project.id === property.projectId)?.name
          : undefined;
        const searchText = [
          label(property),
          property.address,
          property.city,
          property.companyName,
          property.tenantName,
          typeLabel(property),
          projectName,
          ...units.map((unit) => unit.tenantName),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return {
          property,
          name: label(property),
          type: typeLabel(property),
          monthly,
          yieldPct,
          totalUnits,
          letUnits,
          status,
          searchText,
        };
      }),
    [topLevelProperties, unitsByParent, projects],
  );

  // Filters other than lifecycle — used for the Active/Archived counts too.
  const matchesFilters = (row: Row) => {
    const p = row.property;
    if (!owns(p, ownership)) return false;
    if (projectFilter === "none" && p.projectId) return false;
    if (projectFilter !== "all" && projectFilter !== "none" && p.projectId !== projectFilter)
      return false;
    if (typeFilter !== "all" && typeTab(p) !== typeFilter) return false;
    const q = query.trim().toLowerCase();
    if (q && !row.searchText.includes(q)) return false;
    return true;
  };

  const filtered = records.filter(matchesFilters);
  const activeCount = filtered.filter((row) => row.property.status !== "inactive").length;
  const archivedCount = filtered.length - activeCount;
  const rows = filtered
    .filter((row) => (lifecycle === "archived") === (row.property.status === "inactive"))
    .sort((a, b) => a.name.localeCompare(b.name));

  const isLoading = propertiesQuery.isLoading || (isSelf && projectsQuery.isLoading);
  const isError = propertiesQuery.isError || (isSelf && projectsQuery.isError);
  const hasAnyRecord = topLevelProperties.length > 0;

  const refetch = () => {
    void propertiesQuery.refetch();
    if (isSelf) void projectsQuery.refetch();
  };

  const openCreateProject = () => {
    setEditingProject(null);
    setProjectFormOpen(true);
  };

  const openEditProject = (project: Project) => {
    setViewingProject(null);
    setEditingProject(project);
    setProjectFormOpen(true);
  };

  const handleDeleteProject = async (project: Project) => {
    const propertyCount = topLevelProperties.filter(
      (property) => property.projectId === project.id,
    ).length;
    const confirmed = await confirm({
      title: "Delete project?",
      description: (
        <>
          <strong>{project.name}</strong> will be removed.{" "}
          {propertyCount > 0 ? (
            <>
              Its {propertyCount} {propertyCount === 1 ? "property stays" : "properties stay"} in
              your portfolio; only the project assignment is removed.
            </>
          ) : (
            <>No properties are currently assigned to it.</>
          )}
        </>
      ),
      confirmLabel: "Delete project",
      tone: "destructive",
    });
    if (!confirmed) return;

    try {
      const result = await deleteProject.mutateAsync(project.id);
      if (viewingProject?.id === project.id) setViewingProject(null);
      if (projectFilter === project.id) setProjectFilter("all");
      toast({
        title: "Project deleted",
        description:
          result.unassigned > 0
            ? "The project was removed. Its properties are still in your portfolio."
            : "The project has been removed.",
      });
    } catch (error) {
      toast({
        title: "Couldn't delete the project",
        description: parseApiError(error, "Check your connection and try again."),
        variant: "destructive",
      });
    }
  };

  const pillBase =
    "rounded-full px-4 py-2 text-sm transition focus-visible:outline-2 focus-visible:outline-[#A78C68]";
  const selectClass =
    "h-10 cursor-pointer rounded-full bg-[#1C2325] px-4 text-sm text-[#F4F4F2] outline-none [color-scheme:dark] focus-visible:ring-2 focus-visible:ring-[#A78C68]";
  const selectedProjectCount = selectedProject
    ? topLevelProperties.filter((property) => property.projectId === selectedProject.id).length
    : 0;

  return (
    <>
      {isSelf ? (
        <HeaderActions>
          <button
            type="button"
            onClick={() => navigate("/portfolios/new")}
            className="inline-flex items-center gap-1.5 rounded-full bg-[#F4F4F2] px-4 py-2 text-sm font-medium text-[#060A0B] transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78C68]"
          >
            <Plus size={16} aria-hidden="true" /> Add asset
          </button>
        </HeaderActions>
      ) : null}

      <div className={PAGE_CONTAINER_CLASSNAME}>
        <div className="mx-auto w-full max-w-[1440px] space-y-6">
          <h1 className="sr-only">Portfolio</h1>

          {showOverview ? (
            <>
              {isError ? (
                <div
                  role="alert"
                  className="flex items-center justify-between gap-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-amber-200"
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <AlertCircle size={16} aria-hidden="true" /> We couldn't load your portfolio.
                  </span>
                  <button
                    type="button"
                    onClick={refetch}
                    className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
                  >
                    Retry
                  </button>
                </div>
              ) : null}
              <PortfolioOverview
                assets={records
                  .filter((row) => row.property.status !== "inactive")
                  .map((row) => ({
                    property: row.property,
                    name: row.name,
                    type: row.type,
                    value: row.property.propertyValue ?? 0,
                    monthly: row.monthly,
                    totalUnits: row.totalUnits,
                    letUnits: row.letUnits,
                  }))}
                loading={propertiesQuery.isLoading}
                canAdd={isSelf}
                onAdd={() => navigate("/portfolios/new")}
              />
            </>
          ) : (
            <>
              <Link
                href="/portfolios"
                className="inline-flex items-center gap-1 text-sm hover:underline"
                style={{ color: PALETTE.muted }}
              >
                <ChevronRight size={14} className="rotate-180" aria-hidden="true" /> Overview
              </Link>

              {isSelf ? (
                <button
                  type="button"
                  onClick={() => navigate("/portfolios/new")}
                  className="inline-flex items-center gap-2 rounded-full bg-[#F4F4F2] px-4 py-2.5 text-sm font-semibold text-[#060A0B] md:hidden"
                >
                  <Plus size={16} aria-hidden="true" /> Add asset
                </button>
              ) : null}

              {/* Filters */}
              <section className={cn(DARK_CARD, "space-y-4 p-4")}>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex h-10 min-w-[220px] flex-1 items-center gap-2 rounded-full bg-[#1C2325] px-4">
                    <Search size={16} style={{ color: PALETTE.muted }} aria-hidden="true" />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Search by name, city, structure or tenant…"
                      aria-label="Search portfolio"
                      className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[#7D8287]"
                    />
                  </label>
                  <select
                    value={ownership}
                    onChange={(event) => setOwnership(event.target.value as Ownership)}
                    aria-label="Ownership"
                    className={selectClass}
                  >
                    <option value="all">All ownership</option>
                    <option value="company">Company-owned</option>
                    <option value="personal">Personally owned</option>
                  </select>
                  {isSelf ? (
                    <>
                      <select
                        value={projectFilter}
                        onChange={(event) => setProjectFilter(event.target.value)}
                        aria-label="Project"
                        className={selectClass}
                      >
                        <option value="all">All projects</option>
                        {projects.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.name}
                          </option>
                        ))}
                        <option value="none">Not in a project</option>
                      </select>
                      <button
                        type="button"
                        onClick={openCreateProject}
                        className="inline-flex h-10 items-center gap-1.5 rounded-full bg-[#1C2325] px-4 text-sm text-[#F4F4F2] transition hover:bg-[#2A3134] focus-visible:outline-2 focus-visible:outline-[#A78C68]"
                      >
                        <Plus size={14} aria-hidden="true" /> Add to project
                      </button>
                    </>
                  ) : null}
                  <div
                    className="flex rounded-full bg-[#1C2325] p-1"
                    role="tablist"
                    aria-label="Status"
                  >
                    {(["active", "archived"] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        role="tab"
                        aria-selected={lifecycle === value}
                        onClick={() => setLifecycle(value)}
                        className={cn(pillBase, "py-1.5")}
                        style={{ color: lifecycle === value ? PALETTE.text : PALETTE.muted }}
                      >
                        {value === "active" ? "Active" : "Archived"}
                        <span className="ml-2 text-xs" style={{ color: PALETTE.muted }}>
                          {value === "active" ? activeCount : archivedCount}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap gap-1" role="tablist" aria-label="Property type">
                  {TYPE_TABS.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={typeFilter === tab.id}
                      onClick={() => setTypeFilter(tab.id)}
                      className={cn(
                        pillBase,
                        typeFilter === tab.id ? "bg-[#F4F4F2] text-[#060A0B]" : "",
                      )}
                      style={typeFilter === tab.id ? undefined : { color: PALETTE.text }}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {selectedProject ? (
                  <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-[#1C2325] px-4 py-3 text-sm">
                    <FolderKanban size={16} style={{ color: PALETTE.cyan }} aria-hidden="true" />
                    <span className="font-semibold">{selectedProject.name}</span>
                    <span style={{ color: PALETTE.muted }}>
                      {selectedProjectCount}{" "}
                      {selectedProjectCount === 1 ? "property" : "properties"} assigned
                    </span>
                    <div className="ml-auto flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setViewingProject(selectedProject)}
                        className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium hover:bg-white/[0.08]"
                      >
                        <Eye size={14} aria-hidden="true" /> View
                      </button>
                      <button
                        type="button"
                        onClick={() => openEditProject(selectedProject)}
                        className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium hover:bg-white/[0.08]"
                      >
                        <Pencil size={14} aria-hidden="true" /> Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteProject(selectedProject)}
                        className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-[#FF7A7A] hover:bg-[#FF7A7A]/10"
                      >
                        <Trash2 size={14} aria-hidden="true" /> Delete
                      </button>
                    </div>
                  </div>
                ) : null}
              </section>

              {isError ? (
                <div
                  role="alert"
                  className="flex items-center justify-between gap-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-amber-900 dark:text-amber-200"
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <AlertCircle size={16} aria-hidden="true" /> We couldn't load your portfolio.
                  </span>
                  <button
                    type="button"
                    onClick={refetch}
                    className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
                  >
                    Retry
                  </button>
                </div>
              ) : null}

              {/* Asset table */}
              <section className={cn(DARK_CARD, "overflow-hidden")}>
                <div
                  className={cn("hidden bg-[#1C2325] px-5 py-3 text-xs", GRID)}
                  style={{ color: PALETTE.muted }}
                >
                  <span>Asset</span>
                  <span>Type</span>
                  <span>City</span>
                  <span className="text-right">Value</span>
                  <span className="text-right">Monthly</span>
                  <span className="text-right">Yield</span>
                  <span>Status</span>
                  <span className="sr-only">Actions</span>
                </div>

                {isLoading ? (
                  <div className="space-y-2 p-4">
                    {Array.from({ length: 3 }).map((_, index) => (
                      <div key={index} className="flex items-center gap-4 py-2">
                        <DashSkeleton className="h-12 w-14 rounded-xl" />
                        <div className="flex-1">
                          <DashSkeleton className="h-3.5 w-40" />
                          <DashSkeleton className="mt-2 h-2.5 w-24" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : rows.length === 0 ? (
                  <div className="flex flex-col items-center px-6 py-14 text-center">
                    {hasAnyRecord ? (
                      <Search
                        size={32}
                        className="mb-3 opacity-40"
                        style={{ color: PALETTE.muted }}
                      />
                    ) : (
                      <Building2
                        size={32}
                        className="mb-3 opacity-40"
                        style={{ color: PALETTE.muted }}
                      />
                    )}
                    <p className="text-sm font-medium">
                      {hasAnyRecord ? "No assets match these filters" : "No assets yet"}
                    </p>
                    {!hasAnyRecord && isSelf ? (
                      <button
                        type="button"
                        onClick={() => navigate("/portfolios/new")}
                        className="mt-4 inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold"
                        style={{ backgroundColor: PALETTE.lime, color: PALETTE.bg }}
                      >
                        <Plus size={16} aria-hidden="true" /> Add your first asset
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <ul>
                    {rows.map((row) => {
                      const property = row.property;
                      const units = unitCount(property);
                      const href = `/properties/${property.id}`;
                      return (
                        <li
                          key={property.id}
                          className="border-b border-white/[0.06] transition-colors last:border-0 hover:bg-white/[0.02]"
                        >
                          <div
                            className={cn("flex flex-col gap-3 px-4 py-4 md:px-5 md:py-4", GRID)}
                          >
                            <Link
                              href={href}
                              className="flex min-w-0 items-center gap-4 focus-visible:outline-none"
                            >
                              <div className="flex h-10 w-14 shrink-0 items-center justify-center rounded-xl bg-[#1C2325]">
                                <Building2
                                  size={16}
                                  style={{ color: PALETTE.muted }}
                                  aria-hidden="true"
                                />
                              </div>
                              <div className="min-w-0">
                                <p className="truncate text-sm font-semibold">{row.name}</p>
                                <p className="truncate text-xs" style={{ color: PALETTE.muted }}>
                                  {ownerLabel(property)} · {units} {units === 1 ? "unit" : "units"}
                                  <span className="md:hidden">
                                    {" "}
                                    · {row.type} · {property.city || "—"}
                                  </span>
                                </p>
                              </div>
                            </Link>

                            <span className="hidden truncate text-sm md:block">{row.type}</span>
                            <span className="hidden truncate text-sm md:block">
                              {property.city || "—"}
                            </span>
                            <span className="text-sm font-semibold tabular-nums md:text-right">
                              <span
                                className="mr-1 text-xs font-normal md:hidden"
                                style={{ color: PALETTE.muted }}
                              >
                                Value
                              </span>
                              {money(property.propertyValue)}
                            </span>
                            <span className="text-sm tabular-nums md:text-right">
                              <span
                                className="mr-1 text-xs md:hidden"
                                style={{ color: PALETTE.muted }}
                              >
                                Monthly
                              </span>
                              {row.monthly > 0 ? money(row.monthly) : "—"}
                            </span>
                            <span className="text-sm tabular-nums md:text-right">
                              <span
                                className="mr-1 text-xs md:hidden"
                                style={{ color: PALETTE.muted }}
                              >
                                Yield
                              </span>
                              {pct(row.yieldPct)}
                            </span>
                            <span>
                              <StatusChip tone={row.status.tone}>{row.status.text}</StatusChip>
                            </span>

                            <div className="flex items-center justify-end gap-1">
                              {isSelf ? (
                                <DropdownMenu>
                                  <DropdownMenuTrigger
                                    aria-label={`Actions for ${row.name}`}
                                    className="rounded-full p-1.5 text-[#A3A7AB] transition hover:bg-white/[0.08] hover:text-[#F4F4F2] focus-visible:outline-2 focus-visible:outline-[#A78C68]"
                                  >
                                    <MoreHorizontal size={16} aria-hidden="true" />
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="min-w-[180px]">
                                    <DropdownMenuItem
                                      className={MENU_ITEM}
                                      onSelect={() => navigate(href)}
                                    >
                                      <Eye size={14} aria-hidden="true" /> View property
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      className={MENU_ITEM}
                                      onSelect={() => setEditingProperty(property)}
                                    >
                                      <Pencil size={14} aria-hidden="true" /> Edit
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      className={MENU_ITEM}
                                      onSelect={() => setAssigningProperty(property)}
                                    >
                                      <Link2 size={14} aria-hidden="true" /> Assign to project
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      className={cn(
                                        MENU_ITEM,
                                        "text-[#FF7A7A] focus:text-[#FF7A7A]",
                                      )}
                                      onSelect={() => setDeletingProperty(property)}
                                    >
                                      <Trash2 size={14} aria-hidden="true" /> Delete
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              ) : null}
                              <Link
                                href={href}
                                aria-label={`Open ${row.name}`}
                                className="rounded-full p-1.5 text-[#A3A7AB] transition hover:bg-white/[0.08] hover:text-[#F4F4F2]"
                              >
                                <ChevronRight size={16} aria-hidden="true" />
                              </Link>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </div>

      {editingProperty ? (
        <EditPropertyDrawer
          open
          onOpenChange={(open) => {
            if (!open) setEditingProperty(null);
          }}
          property={editingProperty}
        />
      ) : null}
      {deletingProperty ? (
        <DeletePropertyDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeletingProperty(null);
          }}
          propertyId={deletingProperty.id}
          propertyAddress={label(deletingProperty)}
        />
      ) : null}
      <AssignProjectDialog
        open={!!assigningProperty}
        onOpenChange={(open) => {
          if (!open) setAssigningProperty(null);
        }}
        property={assigningProperty}
        projects={projects}
      />
      {viewingProject ? (
        <ProjectDetailsDrawer
          open
          onOpenChange={(open) => {
            if (!open) setViewingProject(null);
          }}
          project={viewingProject}
          properties={topLevelProperties}
          onEdit={() => openEditProject(viewingProject)}
          onDelete={() => {
            const project = viewingProject;
            setViewingProject(null);
            void handleDeleteProject(project);
          }}
        />
      ) : null}
      <ProjectDialog
        open={projectFormOpen}
        onOpenChange={(open) => {
          setProjectFormOpen(open);
          if (!open) setEditingProject(null);
        }}
        project={editingProject}
      />
      {dialog}
    </>
  );
}
