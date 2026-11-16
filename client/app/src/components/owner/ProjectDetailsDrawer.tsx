import { useMemo } from "react";
import { Link } from "wouter";
import { Building2, ChevronRight, FolderKanban, Pencil, Trash2 } from "lucide-react";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";
import { PropertyImage } from "@ui/components/common/PropertyImage";
import { PALETTE } from "@/components/owner/dashboard/tokens";
import { formatDay } from "@/components/owner/property/ui";
import type { Project } from "@shared/firestore-schema";
import type { OwnerProperty } from "@/lib/ownerQueries";

function propertyLabel(property: OwnerProperty): string {
  return property.name?.trim() || property.address?.trim() || "Untitled property";
}

export function ProjectDetailsDrawer({
  open,
  onOpenChange,
  project,
  properties,
  onEdit,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  properties: OwnerProperty[];
  onEdit: () => void;
  onDelete: () => void;
}) {
  const assigned = useMemo(
    () =>
      properties
        .filter((property) => property.projectId === project.id && !property.parentPropertyId)
        .sort((a, b) => propertyLabel(a).localeCompare(propertyLabel(b))),
    [properties, project.id],
  );

  return (
    <ResponsiveDrawer
      open={open}
      onOpenChange={onOpenChange}
      title={project.name}
      subtitle={`Project · ${assigned.length} ${
        assigned.length === 1 ? "property" : "properties"
      } assigned`}
      desktopMaxWidth="max-w-[560px]"
      footer={
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-[#FF7A7A]/10 px-5 text-sm font-semibold text-[#FF7A7A] transition hover:bg-[#FF7A7A]/15"
          >
            <Trash2 size={16} aria-hidden="true" /> Delete project
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-[#F4F4F2] px-5 text-sm font-semibold text-[#060A0B] transition hover:brightness-95"
          >
            <Pencil size={16} aria-hidden="true" /> Edit project
          </button>
        </div>
      }
    >
      <div className="space-y-5 pb-2">
        <dl className="grid grid-cols-2 gap-3 rounded-2xl bg-[#1C2325] p-4 text-sm">
          <div>
            <dt className="text-xs" style={{ color: PALETTE.muted }}>
              Created
            </dt>
            <dd className="mt-1 font-medium">{formatDay(project.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-xs" style={{ color: PALETTE.muted }}>
              Assigned properties
            </dt>
            <dd className="mt-1 font-medium tabular-nums">{assigned.length}</dd>
          </div>
          {project.updatedAt ? (
            <div className="col-span-2">
              <dt className="text-xs" style={{ color: PALETTE.muted }}>
                Last updated
              </dt>
              <dd className="mt-1 font-medium">{formatDay(project.updatedAt)}</dd>
            </div>
          ) : null}
        </dl>

        <section className="space-y-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <FolderKanban size={16} aria-hidden="true" /> Assigned properties
          </h3>

          {assigned.length === 0 ? (
            <div className="rounded-2xl bg-[#1C2325] px-4 py-6 text-center">
              <Building2
                size={28}
                className="mx-auto mb-3 opacity-50"
                style={{ color: PALETTE.muted }}
                aria-hidden="true"
              />
              <p className="text-sm font-medium">No properties assigned yet</p>
              <p className="mt-1 text-xs" style={{ color: PALETTE.muted }}>
                Use “Assign to project” on a property row to add one.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-white/[0.06] rounded-2xl bg-[#1C2325]">
              {assigned.map((property) => {
                const type = property.propertyType ?? "Property";
                return (
                  <li key={property.id}>
                    <Link
                      href={`/properties/${property.id}`}
                      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-white/[0.04] focus-visible:bg-white/[0.06] focus-visible:outline-none"
                    >
                      <div className="h-10 w-12 shrink-0 overflow-hidden rounded-xl bg-[#111618]">
                        <PropertyImage src={property.image} alt="" iconSize={16} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{propertyLabel(property)}</p>
                        <p className="truncate text-xs" style={{ color: PALETTE.muted }}>
                          {[type, property.city].filter(Boolean).join(" · ")}
                        </p>
                      </div>
                      <ChevronRight size={16} aria-hidden="true" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </ResponsiveDrawer>
  );
}
