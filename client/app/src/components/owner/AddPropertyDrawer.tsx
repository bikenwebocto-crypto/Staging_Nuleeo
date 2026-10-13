import { useState, useEffect, useRef } from "react";
import {
  Upload,
  Home,
  Euro,
  MapPin,
  Zap,
  Activity,
  FileText,
  Construction,
  CheckCircle2,
  Building2,
  Building,
  Store,
  Map,
  Key,
  DoorOpen,
  TrendingUp,
  Banknote,
  Gift,
  Briefcase,
  Users,
  Flame,
  Snowflake,
  Car,
  X,
  Lock,
  Maximize,
} from "lucide-react";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";
import { AddressAutocomplete } from "@ui/components/common/AddressAutocomplete";
import { AddressMapPicker } from "@ui/components/common/AddressMapPicker";
import { YearSelect } from "@ui/components/common/YearSelect";
import { CountSelect } from "@ui/components/common/CountSelect";
import { CountrySelect } from "@ui/components/common/CountrySelect";
import { CityAutocomplete } from "@ui/components/common/CityAutocomplete";
import { getCountryCode, validatePostalCode } from "@ui/data/countries";

interface AddPropertyDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

import { PricingModal } from "@ui/components/common/PricingModal"; // Import PricingModal
import { AddTenantDrawer } from "@ui/components/owner/AddTenantDrawer"; // Import AddTenantDrawer
import { useToast } from "@ui/hooks/use-toast";
import { useAuth } from "@ui/lib/useAuth";
import { usePlan } from "@ui/lib/usePlan";
import { apiRequest, parseApiError } from "@ui/lib/queryClient";
import {
  uploadPropertyPhoto,
  ALLOWED_PROPERTY_PHOTO_TYPES,
  MAX_PROPERTY_PHOTO_BYTES,
} from "@ui/lib/uploadPropertyPhoto";
import { uploadPropertyDocument, DOCUMENT_ACCEPT } from "@ui/lib/uploadPropertyDocument";
import { formatBytes } from "@ui/lib/format";
import { useActivePortfolioPlan } from "@/lib/useActivePortfolioPlan";
import { useCanOwnerPlan } from "@ui/lib/usePrivileges";
import { useQueryClient } from "@tanstack/react-query";

const formatThousands = (raw: string) => {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  return Number(digits).toLocaleString("en-US");
};
const stripThousands = (val: string) => val.replace(/\D/g, "");

// Room counts (bedrooms/bathrooms) come from text inputs as strings. The old
// `Number(x) || undefined` silently turned a real 0 (studio / no separate
// bath) into "not set" because 0 is falsy. Distinguish "blank" (-> undefined,
// omit the field) from a genuine numeric 0 (-> 0, send it). Non-numeric input
// also maps to undefined so we never POST NaN.
const countOrUndefined = (val: string): number | undefined => {
  const trimmed = val.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
};

// Year fields are dropdowns (YearSelect) bounded to the ranges below, so the
// value is always valid. stageMissing still range-checks defensively for the
// one cross-field case: a future built year that becomes invalid after the
// development status flips to "fully developed".
const CURRENT_YEAR = new Date().getFullYear();
const MIN_YEAR = 1800;
// "Bought" can't be in the future. "Developed" / off-plan can be a few
// years out (planned completion). Built year follows the development
// status — already-built must be in the past, otherwise allow slack.
const MAX_ACQUISITION_YEAR = CURRENT_YEAR;
const MAX_DEVELOPMENT_YEAR = CURRENT_YEAR + 3;
const MAX_FUTURE_BUILT_YEAR = CURRENT_YEAR + 5;
const isYearInRange = (val: string, min: number, max: number): boolean => {
  if (!val) return false;
  const n = Number(val);
  return Number.isInteger(n) && n >= min && n <= max;
};

// A plot is bare land: no interior specs, building amenities, safety equipment,
// onboarding documents, or occupancy/tenant use. Per the onboarding spec a plot
// keeps only photo + location + acquisition + financials + ownership, so these
// stage ids drop out of the wizard when the type is "Plot".
const PLOT_SKIPPED_STAGES: readonly number[] = [5, 6, 9, 11];

// A plot still needs its one headline spec: the land area. It gets a dedicated
// single-field step (id 14) that ONLY appears for plots — buildings capture
// their size inside the regular "Specs" step (5) instead. The value is stored
// in the same `sqm` field, so it flows through the payload, draft autosave, the
// edit form and the property page unchanged (no backend/display rewiring).
const PLOT_ONLY_STAGES: readonly number[] = [14];

export function AddPropertyDrawer({ open, onOpenChange }: AddPropertyDrawerProps) {
  const { toast } = useToast();
  const { profile } = useAuth();
  const { plan } = usePlan();
  const queryClient = useQueryClient();
  const [isSaving, setIsSaving] = useState(false);
  const [addStage, setAddStage] = useState(1);
  // Pending "advance to step 2" timer from the type picker — cleared on close so
  // it can't fire after the drawer is dismissed (leaving step 2 on reopen).
  const stageAdvanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Remembers the built year while it's hidden for an "inherited" property, so
  // switching back to acquired/developed restores it instead of losing it.
  const prevBuiltYearRef = useRef("");
  const [isAddTenantOpen, setIsAddTenantOpen] = useState(false);
  const [assignTenant, setAssignTenant] = useState(true);

  const addStageMeta = [
    { id: 1, title: "Type", hint: "What kind of property?" },
    { id: 2, title: "Address", hint: "Where is it located?" },
    // Flows right after Address (the order here drives the wizard, not the id).
    // Keeps a high id so the existing 3–12 render blocks don't have to renumber.
    { id: 13, title: "Location", hint: "Drop the pin on the exact spot" },
    { id: 3, title: "Basics", hint: "Name + photo" },
    { id: 4, title: "Acquisition", hint: "Bought or developed?" },
    // Plot-only — sits between Acquisition and Specs in the flow. Filtered out
    // for every non-plot type (see PLOT_ONLY_STAGES / activeStages below).
    { id: 14, title: "Plot size", hint: "How big is the land?" },
    { id: 5, title: "Specs", hint: "Size, year, energy" },
    { id: 6, title: "Building", hint: "Parking, elevator, solar" },
    { id: 7, title: "Cost", hint: "Price/cost + year" },
    { id: 8, title: "Ownership", hint: "Title deeds + owner type" },
    { id: 9, title: "Documents", hint: "Optional uploads" },
    { id: 11, title: "Use & status", hint: "How is it used?" },
    { id: 12, title: "Finish", hint: "Assign tenant?" },
  ] as const;

  // Stage 1: Photo + Name. `photoFile` is the actual file to upload on save;
  // `photoPreview` is a local blob: URL (or remote https URL when editing).
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);

  // Revoke blob: URLs on swap/unmount so the browser releases the underlying
  // file. Remote https URLs are left alone.
  useEffect(() => {
    return () => {
      if (photoPreview && photoPreview.startsWith("blob:")) {
        URL.revokeObjectURL(photoPreview);
      }
    };
  }, [photoPreview]);

  // Stage 3: Address details
  const [city, setCity] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [country, setCountry] = useState("Cyprus");
  const [floor, setFloor] = useState("");
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);

  // Stage 4: Development
  const [acquisitionMode, setAcquisitionMode] = useState<"acquired" | "developed" | "inherited">(
    "acquired",
  );

  // Stage 5: Specs basics
  const [sqm, setSqm] = useState("");
  const [bedrooms, setBedrooms] = useState("");
  const [baths, setBaths] = useState("");
  const [builtYear, setBuiltYear] = useState("");

  // Stage 6: Building specs
  const [heatingSystem, setHeatingSystem] = useState(false);
  const [coolingSystem, setCoolingSystem] = useState(false);
  const [hasSolarPanels, setHasSolarPanels] = useState(false);
  const [hasElevator, setHasElevator] = useState(false);
  const [parkingSpaces, setParkingSpaces] = useState(0);
  const [hasStorageUnit, setHasStorageUnit] = useState(false);

  // Stage 7: Cost + year
  const [developmentCost, setDevelopmentCost] = useState("");
  const [developmentYear, setDevelopmentYear] = useState("");

  // Stage 8: Ownership
  const [ownershipType, setOwnershipType] = useState<"individual" | "company">("individual");
  const [companyName, setCompanyName] = useState("");
  const [titleDeedsStatus, setTitleDeedsStatus] = useState<"issued" | "pending">("issued");

  // Stage 9: Documents — picked here, uploaded AFTER the property is created.
  // The document endpoints need the new property's id (they verify ownership),
  // so we defer the upload exactly like the photo above. File objects can't be
  // serialized into the localStorage draft, so these don't survive a resume —
  // same trade-off as `photoFile`.
  const [documentFiles, setDocumentFiles] = useState<File[]>([]);
  const [isUploadingDocs, setIsUploadingDocs] = useState(false);
  // Document storage is an owner-plan feature (server gates `documents.upload`
  // with a 402). Use the active portfolio's plan — same hook the property
  // page's Documents card uses — so granted contacts inherit the owner's plan.
  const { plan: portfolioPlan } = useActivePortfolioPlan();
  const canUploadDocuments = useCanOwnerPlan(portfolioPlan)("documents.upload");

  // Add Form State
  const [activeType, setActiveType] = useState<string>("");
  const [buildingName, setBuildingName] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [addressNumber, setAddressNumber] = useState("");

  // Financials
  const [acquisitionPrice, setAcquisitionPrice] = useState("");
  const [currentValue, setCurrentValue] = useState("");
  const [acquisitionYear, setAcquisitionYear] = useState("");
  const [propertyUse, setPropertyUse] = useState<"hold" | "rent" | "owner_occupied">("rent");
  // Owner-declared current status. Empty until the owner picks one in the
  // "Use & status" step (required to advance). Separate from the auto-derived
  // occupancy the server computes from tenant assignment.
  const [occupancyStatus, setOccupancyStatus] = useState<
    "rented" | "vacant" | "owner_occupied" | ""
  >("");

  // Details
  const [developmentStatus, setDevelopmentStatus] = useState("fully_developed");
  const [energyClass, setEnergyClass] = useState("");
  const [rentPrice, setRentPrice] = useState("");

  const [hasDraft, setHasDraft] = useState(false);

  // Plot flow: filter the building-only steps out of the wizard and renumber
  // the progress bar around what's left, so a plot reads "Step 3 of 7" rather
  // than "Step 3 of 12" with gaps. All the `addStage === N` render blocks below
  // stay keyed off the original ids — we just never navigate onto a skipped one.
  const isPlot = activeType === "Plot";
  const activeStages: number[] = addStageMeta
    .map((s) => s.id)
    // A plot drops the building-only steps but keeps its plot-only size step;
    // every other type does the reverse.
    .filter((id) => (isPlot ? !PLOT_SKIPPED_STAGES.includes(id) : !PLOT_ONLY_STAGES.includes(id)));
  const totalAddStages = activeStages.length;
  const stageIndex = activeStages.indexOf(addStage); // 0-based position in the flow
  const stepPosition = stageIndex >= 0 ? stageIndex + 1 : 1; // 1-based, for display
  const isLastStage = stageIndex >= 0 && stageIndex === activeStages.length - 1;
  // Find by id (not array position) — the meta order no longer matches the ids
  // 1:1 now that "Location" (id 13) sits between Address (2) and Basics (3).
  const currentMeta = addStageMeta.find((s) => s.id === addStage);

  // Only a rented-out property gets a tenant. Hold/invest, owner-occupied, and
  // plots have nobody to assign, so the Finish step drops the tenant question —
  // including its "Assign tenant?" header subtitle.
  const tenantEligible = !isPlot && propertyUse === "rent";

  // Switching to a type with fewer steps (e.g. picking Plot after starting as an
  // apartment) can leave us parked on a step that no longer exists. Snap back to
  // the nearest earlier active step so we never render a hidden one.
  useEffect(() => {
    if (!activeStages.includes(addStage)) {
      const earlier = activeStages.filter((id) => id < addStage);
      setAddStage(earlier.length ? earlier[earlier.length - 1] : activeStages[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlot, addStage]);

  // "Developed" is hidden for plots (bare land can't have been built/renovated).
  // If the owner picked it on another type and then switched to Plot, snap back
  // to "Bought" so the hidden option can't survive in the payload or drive the
  // Cost step's development-cost/-year variant.
  useEffect(() => {
    if (isPlot && acquisitionMode === "developed") {
      setAcquisitionMode("acquired");
    }
  }, [isPlot, acquisitionMode]);

  const loadDraft = () => {
    const draftStr = localStorage.getItem("olio_property_draft");
    if (draftStr) {
      try {
        const draft = JSON.parse(draftStr);
        if (draft.addStage) setAddStage(draft.addStage);
        if (draft.assignTenant !== undefined) setAssignTenant(draft.assignTenant);
        // Only restore a REMOTE (https) preview. A persisted blob: URL is dead
        // after reload (and its File is gone), so it would render a broken
        // image and then save with no photo — drop it instead.
        if (draft.photoPreview && !draft.photoPreview.startsWith("blob:"))
          setPhotoPreview(draft.photoPreview);
        if (draft.city) setCity(draft.city);
        if (draft.postalCode) setPostalCode(draft.postalCode);
        if (draft.country) setCountry(draft.country);
        if (draft.floor) setFloor(draft.floor);
        if (draft.acquisitionMode) setAcquisitionMode(draft.acquisitionMode);
        if (draft.sqm) setSqm(draft.sqm);
        if (draft.bedrooms) setBedrooms(draft.bedrooms);
        if (draft.baths) setBaths(draft.baths);
        if (draft.builtYear) setBuiltYear(draft.builtYear);
        if (draft.heatingSystem !== undefined) setHeatingSystem(draft.heatingSystem);
        if (draft.coolingSystem !== undefined) setCoolingSystem(draft.coolingSystem);
        if (draft.hasSolarPanels !== undefined) setHasSolarPanels(draft.hasSolarPanels);
        if (draft.hasElevator !== undefined) setHasElevator(draft.hasElevator);
        if (draft.parkingSpaces !== undefined) setParkingSpaces(draft.parkingSpaces);
        if (draft.hasStorageUnit !== undefined) setHasStorageUnit(draft.hasStorageUnit);
        if (draft.developmentCost) setDevelopmentCost(draft.developmentCost);
        if (draft.developmentYear) setDevelopmentYear(draft.developmentYear);
        if (draft.ownershipType) setOwnershipType(draft.ownershipType);
        if (draft.companyName) setCompanyName(draft.companyName);
        if (draft.titleDeedsStatus) setTitleDeedsStatus(draft.titleDeedsStatus);
        if (draft.activeType) setActiveType(draft.activeType);
        if (draft.buildingName) setBuildingName(draft.buildingName);
        if (draft.name) setName(draft.name);
        if (draft.address) setAddress(draft.address);
        if (draft.addressNumber) setAddressNumber(draft.addressNumber);
        if (draft.acquisitionPrice) setAcquisitionPrice(draft.acquisitionPrice);
        if (draft.currentValue) setCurrentValue(draft.currentValue);
        if (draft.acquisitionYear) setAcquisitionYear(draft.acquisitionYear);
        if (draft.propertyUse) setPropertyUse(draft.propertyUse);
        if (draft.occupancyStatus) setOccupancyStatus(draft.occupancyStatus);
        if (draft.developmentStatus) setDevelopmentStatus(draft.developmentStatus);
        if (draft.energyClass) setEnergyClass(draft.energyClass);
        if (draft.rentPrice) setRentPrice(draft.rentPrice);

        toast({
          title: "Draft Resumed",
          description: "We've restored your progress from your previous session.",
        });
      } catch {
        // Saved draft is corrupted (e.g. partially written or schema drift) —
        // clear it so we don't keep tripping on the same bad blob, and let the
        // user know rather than silently failing.
        localStorage.removeItem("olio_property_draft");
        setHasDraft(false);
        toast({
          title: "Draft couldn't be restored",
          description: "Your saved draft was unreadable and has been cleared. Please start again.",
          variant: "destructive",
        });
      }
    }
  };

  // Autosave draft — but ONLY once the form holds real user input. The drawer
  // opens with an empty/default form, so saving unconditionally would write a
  // phantom "empty draft" on every open. That made Discard look broken: the
  // blank form re-saved itself the moment you cleared it (or reopened), so the
  // banner kept coming back. Gating on meaningful content means an empty form
  // never persists, while a genuine in-progress entry still does.
  useEffect(() => {
    if (open) {
      const hasMeaningfulData =
        addStage > 1 ||
        activeType !== "" ||
        name.trim() !== "" ||
        address.trim() !== "" ||
        city.trim() !== "" ||
        postalCode.trim() !== "" ||
        buildingName.trim() !== "" ||
        floor.trim() !== "" ||
        sqm.trim() !== "" ||
        bedrooms.trim() !== "" ||
        baths.trim() !== "" ||
        builtYear.trim() !== "" ||
        energyClass.trim() !== "" ||
        rentPrice.trim() !== "" ||
        acquisitionPrice.trim() !== "" ||
        currentValue.trim() !== "" ||
        acquisitionYear.trim() !== "" ||
        developmentCost.trim() !== "" ||
        developmentYear.trim() !== "" ||
        companyName.trim() !== "" ||
        photoPreview !== null;
      // Never overwrite/remove a saved draft from a blank form — that's what lets
      // Resume Draft survive a close/reopen. Just skip saving until there's content.
      if (!hasMeaningfulData) return;
      const draft = {
        addStage,
        assignTenant,
        // Persist only a REMOTE (https) preview. A blob: URL is session-only —
        // saving it to localStorage yields a dead link + no File on resume.
        photoPreview: photoPreview && !photoPreview.startsWith("blob:") ? photoPreview : null,
        city,
        postalCode,
        country,
        floor,
        acquisitionMode,
        sqm,
        bedrooms,
        baths,
        builtYear,
        heatingSystem,
        coolingSystem,
        hasSolarPanels,
        hasElevator,
        parkingSpaces,
        hasStorageUnit,
        developmentCost,
        developmentYear,
        ownershipType,
        companyName,
        titleDeedsStatus,
        activeType,
        buildingName,
        name,
        address,
        addressNumber,
        acquisitionPrice,
        currentValue,
        acquisitionYear,
        propertyUse,
        occupancyStatus,
        developmentStatus,
        energyClass,
        rentPrice,
      };
      localStorage.setItem("olio_property_draft", JSON.stringify(draft));
    }
  }, [
    open,
    addStage,
    assignTenant,
    photoPreview,
    city,
    postalCode,
    country,
    floor,
    acquisitionMode,
    sqm,
    bedrooms,
    baths,
    builtYear,
    heatingSystem,
    coolingSystem,
    hasSolarPanels,
    hasElevator,
    parkingSpaces,
    hasStorageUnit,
    developmentCost,
    developmentYear,
    ownershipType,
    companyName,
    titleDeedsStatus,
    activeType,
    buildingName,
    name,
    address,
    addressNumber,
    acquisitionPrice,
    currentValue,
    acquisitionYear,
    propertyUse,
    occupancyStatus,
    developmentStatus,
    energyClass,
    rentPrice,
  ]);

  // Reset the form when the drawer closes; refresh the draft banner when it opens.
  useEffect(() => {
    if (!open) {
      // Reset form on close
      if (stageAdvanceTimerRef.current) {
        clearTimeout(stageAdvanceTimerRef.current);
        stageAdvanceTimerRef.current = null;
      }
      setAddStage(1);

      setActiveType("");
      setBuildingName("");
      setName("");
      setAddress("");
      setAddressNumber("");
      setCity("");
      setPostalCode("");
      setCountry("Cyprus");
      setFloor("");
      setLat(null);
      setLng(null);

      if (photoPreview && photoPreview.startsWith("blob:")) {
        URL.revokeObjectURL(photoPreview);
      }
      setPhotoFile(null);
      setPhotoPreview(null);

      setDocumentFiles([]);
      setIsUploadingDocs(false);

      setAcquisitionMode("acquired");
      setDevelopmentStatus("fully_developed");

      setEnergyClass("");
      setSqm("");
      setBedrooms("");
      setBaths("");
      setBuiltYear("");

      setHeatingSystem(false);
      setCoolingSystem(false);
      setHasSolarPanels(false);
      setHasElevator(false);
      setParkingSpaces(0);
      setHasStorageUnit(false);

      setCurrentValue("");
      setAcquisitionPrice("");
      setDevelopmentCost("");
      setAcquisitionYear("");
      setDevelopmentYear("");

      setOwnershipType("individual");
      setCompanyName("");
      setTitleDeedsStatus("issued");

      setPropertyUse("rent");
      setOccupancyStatus("");
      setRentPrice("");
    } else {
      setHasDraft(!!localStorage.getItem("olio_property_draft"));
    }
  }, [open]);

  const propertyTypes = [
    { id: "Apartment", icon: Building2, label: "Apartment" },
    { id: "House", icon: Home, label: "House" },
    { id: "Building", icon: Building, label: "Building" },
    { id: "Commercial", icon: Store, label: "Commercial" },
    { id: "Plot", icon: Map, label: "Plot" },
  ];

  const [isPricingOpen, setIsPricingOpen] = useState(false);
  const [canAdd, setCanAdd] = useState(true);
  const [unitCapInfo, setUnitCapInfo] = useState<{ cap: number | null; used: number } | null>(null);

  // Plan caps are enforced server-side on POST /api/properties; we ALSO
  // fetch the current cap when the drawer opens so we can disable the
  // submit button + show a "X / Y units used" hint before the user fills
  // the whole form.
  const [unitCapFetchFailed, setUnitCapFetchFailed] = useState(false);
  useEffect(() => {
    if (!open) {
      setCanAdd(true);
      setUnitCapInfo(null);
      setUnitCapFetchFailed(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiRequest("GET", "/api/owner/unit-cap");
        const info = (await res.json()) as { cap: number | null; used: number };
        if (cancelled) return;
        setUnitCapInfo(info);
        setCanAdd(info.cap === null || info.used < info.cap);
        setUnitCapFetchFailed(false);
      } catch {
        // Fail closed: if we can't confirm the plan's unit cap we hold off on
        // letting the user submit. The server enforces the same gate with 402
        // either way, but failing open here would let people fill out the whole
        // 11-stage form before hitting a paywall on submit.
        if (cancelled) return;
        setCanAdd(false);
        setUnitCapInfo(null);
        setUnitCapFetchFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, plan]);

  // Intercept save/add action — POSTs to /api/properties so all the fields the
  // form collects (specs, features, ownership, safety, location) actually get
  // persisted; the tenant-side Agreements page reads them back via the join.
  const handleSave = async () => {
    if (!canAdd) {
      setIsPricingOpen(true);
      return;
    }

    // Upload the photo (if any) first so we save a real https URL, not a
    // blob: URL that dies as soon as the page reloads.
    let imageUrl: string | undefined;
    if (photoFile) {
      try {
        setIsUploadingPhoto(true);
        imageUrl = await uploadPropertyPhoto(photoFile);
      } catch (err: any) {
        setIsUploadingPhoto(false);
        toast({
          title: "Could not upload photo",
          description: err?.message ?? "Photo upload failed. Try again.",
          variant: "destructive",
        });
        return;
      }
      setIsUploadingPhoto(false);
    } else if (photoPreview && !photoPreview.startsWith("blob:")) {
      imageUrl = photoPreview;
    }

    const propertyValueNum = Number(currentValue);
    const acquisitionPriceNum = Number(
      // "Developed" captures a build cost; "Bought" and "Inherited" both
      // capture an acquisition price/value.
      acquisitionMode === "developed" ? developmentCost : acquisitionPrice,
    );

    const PROPERTY_TYPE_MAP: Record<string, string> = {
      Apartment: "Apartment",
      House: "House",
      Building: "Apartment", // owners create a building parent → tenants live in apartments
      Commercial: "Commercial",
      Plot: "Plot",
    };

    const rentPriceNum = Number(rentPrice);

    const payload: Record<string, unknown> = {
      address: address || name,
      ...(name.trim() ? { name: name.trim() } : {}),
      propertyValue: Number.isFinite(propertyValueNum) ? propertyValueNum : 0,
      acquisitionPrice: Number.isFinite(acquisitionPriceNum) ? acquisitionPriceNum : 0,
      propertyType: PROPERTY_TYPE_MAP[activeType] ?? activeType ?? undefined,
      // buildingName/floor are apartment-only in the data model (EditPropertyDrawer
      // gates them the same way) — don't carry stale values onto a House/Villa/Plot.
      buildingName: activeType === "Apartment" ? buildingName || undefined : undefined,
      floor: activeType === "Apartment" ? floor || undefined : undefined,
      sqm: sqm || undefined,
      bedrooms: countOrUndefined(bedrooms),
      baths: countOrUndefined(baths),
      builtYear: builtYear || undefined,
      energyClass: energyClass || undefined,
      addressNumber: addressNumber || undefined,
      city: city || undefined,
      postalCode: postalCode || undefined,
      country: country || undefined,
      ...(lat !== null ? { lat } : {}),
      ...(lng !== null ? { lng } : {}),
      parking: parkingSpaces,
      elevator: hasElevator,
      heating: heatingSystem,
      cooling: coolingSystem,
      solarPanels: hasSolarPanels,
      storageUnit: hasStorageUnit,
      ownershipType,
      companyName: ownershipType === "company" ? companyName || undefined : undefined,
      titleDeedsStatus,
      ...(imageUrl ? { image: imageUrl } : {}),
      // Plots have no development status (the picker is hidden for them).
      ...(!isPlot && developmentStatus ? { developmentStatus } : {}),
      // Plots skip the "Use & status" step, so they have no occupancy and no
      // tenant — persist them as held land rather than the "rent" default.
      propertyUse: isPlot ? "hold" : propertyUse,
      ...(occupancyStatus ? { occupancyStatus } : {}),
      ...(acquisitionYear ? { acquisitionYear } : {}),
      ...(acquisitionMode === "developed" && developmentYear ? { developmentYear } : {}),
      // rentPrice only meaningful when the owner intends to rent the unit.
      ...(propertyUse === "rent" && Number.isFinite(rentPriceNum) && rentPriceNum > 0
        ? { rentPrice: rentPriceNum }
        : {}),
    };

    // Target for any Stage-9 document uploads — read back from the POST response.
    let targetPropertyId: string | undefined;
    try {
      setIsSaving(true);
      const res = await apiRequest("POST", "/api/properties", payload);
      const created = (await res.json().catch(() => null)) as { id?: string } | null;
      targetPropertyId = created?.id;
      await queryClient.invalidateQueries({ queryKey: ["/api/owner/properties"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/tenant/agreements"] });
    } catch (err: any) {
      // 402 → server says "upgrade required" (unit cap reached). Surface the
      // pricing modal so the owner can act on it instead of re-reading a toast.
      const msg = err?.message ?? "";
      if (msg.startsWith("402") || /upgrade required/i.test(msg)) {
        setIsSaving(false);
        setIsPricingOpen(true);
        return;
      }
      toast({
        title: "Could not save property",
        description: parseApiError(err, "Something went wrong. Please try again."),
        variant: "destructive",
      });
      setIsSaving(false);
      return;
    }

    // Property is saved. Now push any documents the owner attached in Stage 9.
    // These run AFTER create because the upload endpoints verify ownership of the
    // property id — which only exists now. A failure here must NOT undo the
    // (already successful) save, so we collect failures and warn rather than
    // throwing the whole submit away.
    if (documentFiles.length > 0 && targetPropertyId && canUploadDocuments) {
      setIsUploadingDocs(true);
      const failed: string[] = [];
      for (const file of documentFiles) {
        try {
          await uploadPropertyDocument(file, targetPropertyId);
        } catch {
          failed.push(file.name);
        }
      }
      setIsUploadingDocs(false);
      await queryClient.invalidateQueries({
        queryKey: [`/api/owner/documents?propertyId=${targetPropertyId}`],
      });
      if (failed.length) {
        toast({
          title:
            failed.length === documentFiles.length
              ? "Documents not uploaded"
              : "Some documents not uploaded",
          description: `Couldn't upload: ${failed.join(", ")}. You can add them later from the property's Documents tab.`,
          variant: "destructive",
        });
      }
    } else if (documentFiles.length > 0 && canUploadDocuments && !targetPropertyId) {
      // Save succeeded but we never got an id back, so we can't target the upload.
      // Don't pretend the files were stored — tell the owner where to re-add them.
      toast({
        title: "Property saved — documents not attached",
        description:
          "We couldn't link your files to the new property. Add them from its Documents tab.",
        variant: "destructive",
      });
    }

    setIsSaving(false);

    localStorage.removeItem("olio_property_draft");
    setHasDraft(false);

    toast({
      title: "Property Added",
      description: "Your property has been successfully added to your portfolio.",
    });
    onOpenChange(false);

    // Only auto-open the tenant flow when the property is actually rentable and
    // not owner-occupied — a hold/invest or owner-occupied unit has no tenant to
    // add. Mirrors the gated choice shown on the Finish step (`tenantEligible`).
    if (assignTenant && tenantEligible) {
      setTimeout(() => {
        setIsAddTenantOpen(true);
      }, 500); // Wait for AddPropertyDrawer to close
    }
  };

  // While a save / photo / document upload is in flight, don't let the drawer
  // close (X / overlay / Escape / Back) — closing mid-write drops the form and
  // risks a duplicate property on reopen-and-retry.
  const isBusy = isSaving || isUploadingPhoto || isUploadingDocs;
  const handleDrawerOpenChange = (next: boolean) => {
    if (!next && isBusy) return;
    onOpenChange(next);
  };

  const handleAddPrimaryBack = () => {
    if (isBusy) return;
    if (addStage > 1) {
      prevStage();
      return;
    }
    onOpenChange(false);
  };

  // Returns null when the current stage is complete, or a specific message
  // naming the missing field(s) so the user knows what to fix.
  const stageMissing = (): string | null => {
    if (addStage === 1) {
      return activeType ? null : "Pick a property type to continue.";
    }
    if (addStage === 2) {
      const missing: string[] = [];
      if (!address.trim()) missing.push("address");
      if (!city.trim()) missing.push("city");
      if (!postalCode.trim()) missing.push("postal code");
      if (!country.trim()) missing.push("country");
      if (activeType === "Apartment") {
        if (!buildingName.trim()) missing.push("building name");
        if (!floor.trim()) missing.push("floor");
      }
      if (missing.length) return `Please add: ${missing.join(", ")}.`;
      const postal = validatePostalCode(country, postalCode);
      if (!postal.valid) return postal.message ?? "Check the postal code format.";
      return null;
    }
    if (addStage === 13) {
      // Dedicated Location step — require a pin so every property gets exact
      // coordinates. lat/lng are pre-filled when the address is picked from the
      // autocomplete, so this only blocks the typed-but-never-picked case.
      return lat === null || lng === null
        ? "Drop the pin on the map to set the exact location."
        : null;
    }
    if (addStage === 3) {
      // Plots have no name field (photo only, and that's optional) — nothing to
      // require here, so let them straight through.
      if (isPlot) return null;
      return name.trim() ? null : 'Add a property name (e.g. "Seaside Apartment").';
    }
    if (addStage === 4) {
      const missing: string[] = [];
      if (!developmentStatus) missing.push("development status");
      if (!acquisitionMode) missing.push("how you got it");
      return missing.length ? `Please pick: ${missing.join(", ")}.` : null;
    }
    if (addStage === 14) {
      // Plot's land area — the one spec a bare plot must carry. Stored in `sqm`.
      const n = Number(sqm);
      if (!sqm.trim() || !Number.isFinite(n) || n <= 0) {
        return "Add the plot size in square metres (e.g. 500).";
      }
      return null;
    }
    if (addStage === 5) {
      // Inherited properties hide the "Built Year" field, so don't require it
      // or range-check it for them.
      const inherited = acquisitionMode === "inherited";
      const missing: string[] = [];
      if (!sqm.trim()) missing.push("size (sqm)");
      if (!inherited && !builtYear.trim()) missing.push("built year");
      if (!energyClass.trim()) missing.push("energy class");
      if (missing.length) return `Please add: ${missing.join(", ")}.`;
      if (!inherited) {
        const maxBuilt =
          developmentStatus === "fully_developed" ? CURRENT_YEAR : MAX_FUTURE_BUILT_YEAR;
        if (!isYearInRange(builtYear, MIN_YEAR, maxBuilt)) {
          return `Built year must be between ${MIN_YEAR} and ${maxBuilt}.`;
        }
      }
      return null;
    }
    if (addStage === 6) return null;
    if (addStage === 7) {
      const missing: string[] = [];
      if (acquisitionMode === "developed") {
        if (!developmentCost.trim()) missing.push("development cost");
        if (!developmentYear.trim()) missing.push("development year");
      } else {
        // Inherited property has no purchase price — leave it optional.
        if (acquisitionMode !== "inherited" && !acquisitionPrice.trim())
          missing.push("acquisition price");
        if (!acquisitionYear.trim()) missing.push("acquisition year");
      }
      if (!currentValue.trim()) missing.push("current value");
      if (missing.length) return `Please add: ${missing.join(", ")}.`;
      // Current value must be positive — the server requires propertyValue > 0,
      // so block a 0 / non-numeric here instead of failing on the final submit.
      const cvNum = Number(currentValue);
      if (!Number.isFinite(cvNum) || cvNum <= 0) {
        return "Current value must be a number greater than 0.";
      }
      if (
        acquisitionMode !== "developed" &&
        !isYearInRange(acquisitionYear, MIN_YEAR, MAX_ACQUISITION_YEAR)
      ) {
        return `Acquisition year must be between ${MIN_YEAR} and ${MAX_ACQUISITION_YEAR} — can't be in the future.`;
      }
      if (
        acquisitionMode === "developed" &&
        !isYearInRange(developmentYear, MIN_YEAR, MAX_DEVELOPMENT_YEAR)
      ) {
        return `Development year must be between ${MIN_YEAR} and ${MAX_DEVELOPMENT_YEAR}.`;
      }
      return null;
    }
    if (addStage === 8) {
      const missing: string[] = [];
      if (!ownershipType) missing.push("ownership type");
      if (ownershipType === "company" && !companyName.trim()) missing.push("company name");
      if (!titleDeedsStatus) missing.push("title deeds status");
      return missing.length ? `Please add: ${missing.join(", ")}.` : null;
    }
    if (addStage === 11) {
      // The current-status picker only shows for a rented-out property; hold and
      // owner-occupied hide it, so don't block on a status the owner can't choose.
      if (propertyUse !== "rent") return null;
      return occupancyStatus ? null : "Pick the current status to continue.";
    }
    return null;
  };

  const nextStage = () => {
    const missing = stageMissing();
    if (missing) {
      toast({
        title: `Step ${stepPosition}: ${currentMeta?.title ?? ""}`.trim(),
        description: missing,
      });
      return;
    }
    if (stageIndex >= 0 && stageIndex < activeStages.length - 1) {
      setAddStage(activeStages[stageIndex + 1]);
    }
  };

  const prevStage = () => {
    if (stageIndex > 0) setAddStage(activeStages[stageIndex - 1]);
  };

  // Live postal-code check against the selected country's format. Drives the
  // inline error below the field; the same check hard-blocks Continue in
  // stageMissing(), so the owner can't advance with a malformed code.
  const postalCheck = validatePostalCode(country, postalCode);
  const postalInvalid = postalCode.trim().length > 0 && !postalCheck.valid;

  const drawerTitle = "Add Property";

  const drawerFooter = (
    <div className="flex gap-3">
      <button
        data-testid="button-back"
        onClick={handleAddPrimaryBack}
        className="px-6 py-4 rounded-2xl bg-secondary text-foreground font-bold border border-border hover:bg-background transition"
      >
        Back
      </button>

      {!isLastStage ? (
        addStage !== 1 && (
          <button
            data-testid="button-next"
            onClick={nextStage}
            className="flex-1 font-bold text-lg py-4 rounded-2xl shadow-lg transition active:scale-[0.98] bg-primary text-primary-foreground shadow-primary/30 hover:bg-primary/90"
          >
            Continue
          </button>
        )
      ) : (
        <div className="flex-1 flex flex-col gap-1.5">
          {unitCapInfo && unitCapInfo.cap !== null && (
            <div
              className={`text-xs text-center font-medium ${
                canAdd ? "text-muted-foreground" : "text-amber-700 dark:text-amber-300"
              }`}
            >
              {unitCapInfo.used} / {unitCapInfo.cap} units used on your plan
            </div>
          )}
          {unitCapFetchFailed && (
            <div className="text-xs text-center font-medium text-amber-700">
              Couldn't check your plan's unit cap. Try again in a moment.
            </div>
          )}
          <button
            data-testid="button-submit"
            onClick={handleSave}
            disabled={isSaving || isUploadingPhoto || isUploadingDocs}
            className={`flex-1 font-bold text-lg py-4 rounded-2xl shadow-lg transition active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed ${
              !canAdd
                ? "bg-primary text-primary-foreground hover:bg-card"
                : "bg-primary text-primary-foreground shadow-primary/30 hover:bg-primary/90"
            }`}
          >
            {isUploadingPhoto
              ? "Uploading photo…"
              : isUploadingDocs
                ? "Uploading documents…"
                : isSaving
                  ? "Saving…"
                  : !canAdd
                    ? "Upgrade to Add More Properties"
                    : "Add Property"}
          </button>
        </div>
      )}
    </div>
  );

  return (
    <>
      <PricingModal open={isPricingOpen} onOpenChange={setIsPricingOpen} />
      <ResponsiveDrawer
        open={open}
        onOpenChange={handleDrawerOpenChange}
        title={drawerTitle}
        footer={addStage === 1 ? undefined : drawerFooter}
        desktopMaxWidth="max-w-3xl"
      >
        <div className="max-w-2xl mx-auto">
          {hasDraft && addStage === 1 && (
            <div className="mb-6 w-full bg-primary/10 border border-primary/20 rounded-3xl p-5 flex flex-col sm:flex-row items-center justify-between gap-4 animate-in fade-in duration-300 slide-in-from-bottom-4">
              <div>
                <h4 className="font-bold text-primary text-center sm:text-left text-lg">
                  Unfinished Property Draft
                </h4>
                <p className="text-sm text-primary/80 text-center sm:text-left mt-1">
                  You have an unfinished property entry saved.
                </p>
              </div>
              <div className="flex gap-3 w-full sm:w-auto justify-center">
                <button
                  onClick={() => {
                    localStorage.removeItem("olio_property_draft");
                    setHasDraft(false);
                    toast({
                      title: "Draft Cleared",
                      description: "Your unfinished entry has been removed.",
                    });
                  }}
                  className="px-4 py-2.5 rounded-xl text-sm font-bold text-primary hover:bg-primary/10 transition border border-transparent hover:border-primary/20"
                >
                  Discard
                </button>
                <button
                  onClick={loadDraft}
                  className="px-6 py-2.5 rounded-xl text-sm font-bold bg-primary text-primary-foreground hover:bg-primary/90 shadow-md shadow-primary/20 transition active:scale-95"
                >
                  Resume Draft
                </button>
              </div>
            </div>
          )}
          {/* Stage Header */}
          <div className="mb-4">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-0.5">
                <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                  Step {stepPosition} of {totalAddStages}
                </p>
                <h3 className="text-xl font-bold text-foreground tracking-tight">
                  {currentMeta?.title}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {isPlot && addStage === 3
                    ? "Add a photo"
                    : addStage === 12 && !tenantEligible
                      ? null
                      : currentMeta?.hint}
                </p>
              </div>
              <div className="w-24 shrink-0 mt-1">
                <div className="h-2 bg-secondary rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-300"
                    style={{ width: `${Math.round((stepPosition / totalAddStages) * 100)}%` }}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* STAGE 1: Type */}
          {addStage === 1 && (
            <div className="space-y-5">
              <label className="block text-sm font-bold text-foreground ml-1">Property Type</label>
              <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-3 lg:grid-cols-5 gap-3">
                {propertyTypes.map((type) => (
                  <button
                    data-testid={`button-property-type-${type.id}`}
                    key={type.id}
                    onClick={() => {
                      setActiveType(type.id);
                      if (stageAdvanceTimerRef.current) clearTimeout(stageAdvanceTimerRef.current);
                      stageAdvanceTimerRef.current = setTimeout(() => setAddStage(2), 300);
                    }}
                    className={`flex flex-col items-center justify-center gap-2 p-3 rounded-2xl border transition-all duration-200 h-24
 ${
   activeType === type.id
     ? "bg-primary text-primary-foreground border-primary shadow-lg shadow-primary/20 scale-[1.02]"
     : "bg-card border-border text-muted-foreground hover:border-border hover:bg-background"
 }`}
                  >
                    <type.icon size={24} strokeWidth={activeType === type.id ? 2.5 : 2} />
                    <span className="text-xs font-semibold">{type.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* STAGE 2: Address */}
          {addStage === 2 && (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs font-semibold text-muted-foreground ml-1">Address</label>
                <AddressAutocomplete
                  testId="input-property-address"
                  value={address}
                  onChange={(v) => {
                    setAddress(v);
                    setLat(null);
                    setLng(null);
                  }}
                  onPick={(p) => {
                    setAddress(p.fullAddress);
                    if (p.city) setCity(p.city);
                    if (p.postalCode) setPostalCode(p.postalCode);
                    if (p.country) setCountry(p.country);
                    setLat(p.lat);
                    setLng(p.lng);
                  }}
                  placeholder="Search address (e.g. 12 Anexartisias, Limassol)"
                  countryCodes={getCountryCode(country)}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-xs font-semibold text-muted-foreground ml-1">
                    Address Number
                  </label>
                  <input
                    data-testid="input-property-address-number"
                    type="text"
                    value={addressNumber}
                    onChange={(e) => setAddressNumber(e.target.value)}
                    placeholder="e.g. 12"
                    className="w-full bg-background border-none rounded-xl px-4 py-2.5 text-foreground font-medium placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-semibold text-muted-foreground ml-1">City</label>
                  <CityAutocomplete
                    testId="input-property-city"
                    value={city}
                    onChange={setCity}
                    countryCode={getCountryCode(country)}
                    placeholder="e.g. Limassol"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground ml-1">
                    Postal Code
                  </label>
                  <input
                    data-testid="input-property-postal"
                    type="text"
                    value={postalCode}
                    onChange={(e) => setPostalCode(e.target.value)}
                    placeholder="e.g. 3036"
                    aria-invalid={postalInvalid}
                    className={`w-full bg-background border-none rounded-xl px-4 py-2.5 text-foreground font-medium placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 transition ${
                      postalInvalid ? "ring-2 ring-destructive/50" : "focus:ring-primary/20"
                    }`}
                  />
                  {postalInvalid && (
                    <p className="text-[11px] text-destructive ml-1">{postalCheck.message}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-semibold text-muted-foreground ml-1">
                    Country
                  </label>
                  <CountrySelect
                    testId="input-property-country"
                    value={country}
                    onChange={(name) => {
                      // City + postal are country-specific — clear them when the
                      // country actually changes so a stale Cyprus value can't
                      // survive under, say, France.
                      if (name !== country) {
                        setCity("");
                        setPostalCode("");
                      }
                      setCountry(name);
                    }}
                  />
                </div>
              </div>

              {activeType === "Apartment" && (
                <div className="grid grid-cols-2 gap-4 animate-in fade-in slide-in-from-top-2 duration-300">
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-muted-foreground ml-1">
                      Floor
                    </label>
                    <input
                      data-testid="input-property-floor"
                      type="text"
                      value={floor}
                      onChange={(e) => setFloor(e.target.value)}
                      placeholder="e.g. 4"
                      className="w-full bg-background border-none rounded-xl px-4 py-2.5 text-foreground font-medium placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-muted-foreground ml-1">
                      Building Name
                    </label>
                    <div className="relative">
                      <Building
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/70"
                        size={16}
                      />
                      <input
                        data-testid="input-property-building"
                        type="text"
                        value={buildingName}
                        onChange={(e) => setBuildingName(e.target.value)}
                        placeholder="e.g. Sunset Towers"
                        className="w-full bg-background border-none rounded-xl pl-10 pr-4 py-2.5 text-foreground font-medium placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* STAGE 13 (flows right after Address): pin the exact location. The
              lat/lng are pre-filled from the address pick on the previous step;
              this step is just to drag/drop the pin to the precise spot. */}
          {addStage === 13 && (
            <div className="space-y-3">
              <AddressMapPicker
                lat={lat}
                lng={lng}
                onChange={(la, ln) => {
                  setLat(la);
                  setLng(ln);
                }}
                heightClass="h-64 sm:h-80"
              />
            </div>
          )}

          {/* STAGE 3: Basics */}
          {addStage === 3 && (
            <div className="space-y-5">
              <div className="flex flex-col items-center gap-2">
                <input
                  data-testid="input-property-photo"
                  type="file"
                  accept="image/*"
                  className="hidden"
                  id="property-photo"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    // Validate at SELECTION so a bad file is rejected here, not
                    // after the whole wizard on the upload round-trip. Mirrors
                    // the uploadPropertyPhoto server-side constraints.
                    if (!ALLOWED_PROPERTY_PHOTO_TYPES.includes(file.type)) {
                      toast({
                        title: "Unsupported image",
                        description: "Use a JPEG, PNG, or WebP photo.",
                        variant: "destructive",
                      });
                      e.target.value = "";
                      return;
                    }
                    if (file.size > MAX_PROPERTY_PHOTO_BYTES) {
                      toast({
                        title: "Image too large",
                        description: "Photos must be under 8 MB.",
                        variant: "destructive",
                      });
                      e.target.value = "";
                      return;
                    }
                    if (photoPreview && photoPreview.startsWith("blob:")) {
                      URL.revokeObjectURL(photoPreview);
                    }
                    setPhotoFile(file);
                    setPhotoPreview(URL.createObjectURL(file));
                  }}
                />
                <label
                  htmlFor="property-photo"
                  className="w-full h-36 bg-background border-2 border-dashed border-border rounded-2xl flex flex-col items-center justify-center gap-2 cursor-pointer hover:bg-secondary transition group relative overflow-hidden"
                >
                  {photoPreview ? (
                    <img src={photoPreview} alt="Property" className="w-full h-full object-cover" />
                  ) : (
                    <>
                      <div className="w-12 h-12 bg-card rounded-full shadow-sm flex items-center justify-center text-primary group-hover:scale-110 transition">
                        <Upload size={24} />
                      </div>
                      <p className="text-xs text-muted-foreground/70 font-medium">
                        Tap to upload property photo
                      </p>
                    </>
                  )}
                </label>
                <label
                  data-testid="button-upload-photo"
                  htmlFor="property-photo"
                  className="mt-3 inline-flex items-center justify-center w-full px-4 py-2.5 rounded-xl bg-secondary text-foreground font-bold hover:bg-secondary transition cursor-pointer"
                >
                  {photoPreview ? "Replace photo" : "Upload photo"}
                </label>
              </div>

              {/* Plots are identified by their address — no name field (per spec). */}
              {!isPlot && (
                <div className="space-y-2">
                  <label className="text-xs font-semibold text-muted-foreground ml-1">
                    Property Name
                  </label>
                  <input
                    data-testid="input-property-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Seaside Apartment"
                    className="w-full bg-background border-none rounded-xl px-4 py-2.5 text-foreground font-medium placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
                  />
                </div>
              )}
            </div>
          )}

          {/* STAGE 4: Acquisition */}
          {addStage === 4 && (
            <div className="space-y-4">
              {/* Plots are raw land — there's no build to be off-plan or under
     construction, so the development-status picker doesn't apply. */}
              {!isPlot && (
                <div className="space-y-3">
                  <label className="text-xs font-semibold text-muted-foreground ml-1">
                    Development Status
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { id: "off_plan", label: "Off Plan", icon: Map },
                      { id: "under_construction", label: "Under Construction", icon: Construction },
                      { id: "fully_developed", label: "Completed", icon: CheckCircle2 },
                    ].map((status) => (
                      <button
                        data-testid={`button-development-status-${status.id}`}
                        key={status.id}
                        onClick={() => {
                          setDevelopmentStatus(status.id);
                          // "Completed" caps the built year at the current year.
                          // A future year picked while under-construction would
                          // otherwise sit in state but blank the (now out-of-range)
                          // YearSelect — clear it so the displayed + stored values agree.
                          if (
                            status.id === "fully_developed" &&
                            builtYear &&
                            Number(builtYear) > CURRENT_YEAR
                          ) {
                            setBuiltYear("");
                          }
                        }}
                        className={`flex flex-col items-center justify-center gap-2 p-3 rounded-xl border transition-all duration-200 h-20
 ${
   developmentStatus === status.id
     ? "bg-primary text-primary-foreground border-primary shadow-md shadow-primary/20"
     : "bg-card border-border text-muted-foreground hover:border-border hover:bg-background"
 }`}
                      >
                        <status.icon size={20} />
                        <span className="text-[10px] font-bold text-center leading-tight">
                          {status.label}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-3">
                <label className="text-xs font-semibold text-muted-foreground ml-1">
                  How did you get it?
                </label>
                {/* Plots drop "Developed" — bare land has no build to have been
                    built/renovated/completed — so the grid collapses to two. */}
                <div className={`grid ${isPlot ? "grid-cols-2" : "grid-cols-3"} gap-3`}>
                  <button
                    data-testid="button-acquisition-acquired"
                    onClick={() => {
                      setAcquisitionMode("acquired");
                      if (!builtYear && prevBuiltYearRef.current)
                        setBuiltYear(prevBuiltYearRef.current);
                    }}
                    className={`p-3 rounded-2xl border text-left transition ${
                      acquisitionMode === "acquired"
                        ? "bg-primary text-primary-foreground border-primary shadow-lg shadow-primary/20"
                        : "bg-card border-border text-foreground hover:bg-background"
                    }`}
                  >
                    <div className="flex items-center gap-2 font-bold">
                      <Banknote size={18} /> Bought
                    </div>
                    <p
                      className={`text-xs mt-1 ${acquisitionMode === "acquired" ? "text-primary-foreground/80" : "text-muted-foreground"}`}
                    >
                      Purchased on the market
                    </p>
                  </button>
                  {/* Not offered for plots — bare land can't have been
                      developed. Also reset off "developed" when switching to
                      Plot (see the acquisitionMode effect) so it can't linger. */}
                  {!isPlot && (
                    <button
                      data-testid="button-acquisition-developed"
                      onClick={() => {
                        setAcquisitionMode("developed");
                        if (!builtYear && prevBuiltYearRef.current)
                          setBuiltYear(prevBuiltYearRef.current);
                      }}
                      className={`p-3 rounded-2xl border text-left transition ${
                        acquisitionMode === "developed"
                          ? "bg-primary text-primary-foreground border-primary shadow-lg shadow-primary/20"
                          : "bg-card border-border text-foreground hover:bg-background"
                      }`}
                    >
                      <div className="flex items-center gap-2 font-bold">
                        <Construction size={18} /> Developed
                      </div>
                      <p
                        className={`text-xs mt-1 ${acquisitionMode === "developed" ? "text-primary-foreground/80" : "text-muted-foreground"}`}
                      >
                        Built / renovated / completed
                      </p>
                    </button>
                  )}
                  <button
                    data-testid="button-acquisition-inherited"
                    onClick={() => {
                      setAcquisitionMode("inherited");
                      // Built Year is hidden for inherited — stash the typed value
                      // (so switching back restores it) and clear it so it isn't
                      // submitted while invisible.
                      if (builtYear) prevBuiltYearRef.current = builtYear;
                      setBuiltYear("");
                    }}
                    className={`p-3 rounded-2xl border text-left transition ${
                      acquisitionMode === "inherited"
                        ? "bg-primary text-primary-foreground border-primary shadow-lg shadow-primary/20"
                        : "bg-card border-border text-foreground hover:bg-background"
                    }`}
                  >
                    <div className="flex items-center gap-2 font-bold">
                      <Gift size={18} /> Inherited
                    </div>
                    <p
                      className={`text-xs mt-1 ${acquisitionMode === "inherited" ? "text-primary-foreground/80" : "text-muted-foreground"}`}
                    >
                      Gifted or passed down
                    </p>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* STAGE 14: Plot size — a bare plot has no interior, so the only spec
              that matters is the land area. Reuses the `sqm` field. */}
          {addStage === 14 && (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs font-semibold text-muted-foreground ml-1">
                  Plot size (m²)
                </label>
                <div className="relative">
                  <Maximize
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/70"
                    size={16}
                  />
                  <input
                    data-testid="input-plot-size"
                    type="number"
                    min={1}
                    value={sqm}
                    onChange={(e) => setSqm(e.target.value)}
                    placeholder="e.g. 500"
                    className="w-full bg-background border-none rounded-xl pl-10 pr-4 py-2.5 text-foreground font-medium placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
                  />
                </div>
                <p className="text-xs text-muted-foreground ml-1">
                  The total land area of the plot, in square metres.
                </p>
              </div>
            </div>
          )}

          {/* STAGE 5: Specs */}
          {addStage === 5 && (
            <div className="space-y-4">
              {/* Inherited properties skip "Built Year" — the owner didn't build
                  or buy it and often won't know the construction year. Size then
                  spans the full row instead of sharing a 2-col grid. */}
              <div className={acquisitionMode === "inherited" ? "" : "grid grid-cols-2 gap-4"}>
                <div className="space-y-2">
                  <label className="text-xs font-semibold text-muted-foreground ml-1">
                    Size (sqm)
                  </label>
                  <div className="relative">
                    <Activity
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/70"
                      size={16}
                    />
                    <input
                      data-testid="input-property-sqm"
                      type="number"
                      value={sqm}
                      onChange={(e) => setSqm(e.target.value)}
                      placeholder="e.g. 85"
                      className="w-full bg-background border-none rounded-xl pl-10 pr-4 py-2.5 text-foreground font-medium placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
                    />
                  </div>
                </div>
                {acquisitionMode !== "inherited" && (
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-muted-foreground ml-1">
                      Built Year
                    </label>
                    <YearSelect
                      testId="input-property-built-year"
                      value={builtYear}
                      onChange={setBuiltYear}
                      min={MIN_YEAR}
                      max={
                        developmentStatus === "fully_developed"
                          ? CURRENT_YEAR
                          : MAX_FUTURE_BUILT_YEAR
                      }
                    />
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-xs font-semibold text-muted-foreground ml-1">
                    Bedrooms
                  </label>
                  <CountSelect
                    testId="input-property-bedrooms"
                    value={bedrooms}
                    onChange={setBedrooms}
                    icon={DoorOpen}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-semibold text-muted-foreground ml-1">
                    Bathrooms
                  </label>
                  <CountSelect
                    testId="input-property-baths"
                    value={baths}
                    onChange={setBaths}
                    icon={Home}
                  />
                </div>
              </div>

              <div className="space-y-3">
                <label className="text-xs font-semibold text-muted-foreground ml-1">
                  Energy Class
                </label>
                <div className="flex gap-2 overflow-x-auto pb-1 hide-scrollbar">
                  {["A", "B", "C", "D", "E", "F-G", "N/A"].map((grade) => (
                    <button
                      data-testid={`button-energy-class-${grade}`}
                      key={grade}
                      onClick={() => setEnergyClass(grade)}
                      className={`flex-shrink-0 min-w-11 h-11 px-3 rounded-xl border flex items-center justify-center font-bold text-base transition-all duration-200
 ${
   energyClass === grade
     ? grade === "A"
       ? "bg-emerald-500 text-white border-emerald-500 shadow-md shadow-emerald-500/30"
       : grade === "B"
         ? "bg-emerald-400 text-white border-emerald-400 shadow-md shadow-emerald-400/30"
         : grade === "C"
           ? "bg-lime-500 text-white border-lime-500 shadow-md shadow-lime-500/30"
           : grade === "D"
             ? "bg-yellow-400 text-white border-yellow-400 shadow-md shadow-yellow-400/30"
             : grade === "E"
               ? "bg-orange-400 text-white border-orange-400 shadow-md shadow-orange-400/30"
               : grade === "F-G"
                 ? "bg-red-500 text-white border-red-500 shadow-md shadow-red-500/30"
                 : "bg-slate-400 text-white border-slate-400 shadow-md shadow-slate-400/30"
     : "bg-card border-border text-muted-foreground/70 hover:border-border hover:bg-background hover:text-muted-foreground"
 }`}
                    >
                      {grade}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground ml-1">
                  Pick <span className="font-medium">F-G</span> for a low-efficiency rating, or{" "}
                  <span className="font-medium">N/A</span> if it's unknown.
                </p>
              </div>
            </div>
          )}

          {/* STAGE 6: Building */}
          {addStage === 6 && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <button
                  data-testid="toggle-heating"
                  onClick={() => setHeatingSystem((v) => !v)}
                  className={`p-3 rounded-2xl border text-left transition ${
                    heatingSystem
                      ? "bg-rose-500/10 border-rose-500/30 text-rose-700 dark:text-rose-300"
                      : "bg-card border-border text-foreground hover:bg-background"
                  }`}
                >
                  <div className="flex items-center gap-2 font-bold">
                    <Flame
                      size={18}
                      className={
                        heatingSystem
                          ? "text-rose-600 dark:text-rose-400"
                          : "text-muted-foreground/70"
                      }
                    />{" "}
                    Heating
                  </div>
                  <p
                    className={`text-xs mt-1 ${heatingSystem ? "text-rose-700 dark:text-rose-300" : "text-muted-foreground"}`}
                  >
                    System installed
                  </p>
                </button>

                <button
                  data-testid="toggle-cooling"
                  onClick={() => setCoolingSystem((v) => !v)}
                  className={`p-3 rounded-2xl border text-left transition ${
                    coolingSystem
                      ? "bg-cyan-500/10 border-cyan-500/30 text-cyan-700 dark:text-cyan-300"
                      : "bg-card border-border text-foreground hover:bg-background"
                  }`}
                >
                  <div className="flex items-center gap-2 font-bold">
                    <Snowflake
                      size={18}
                      className={
                        coolingSystem
                          ? "text-cyan-600 dark:text-cyan-400"
                          : "text-muted-foreground/70"
                      }
                    />{" "}
                    Cooling
                  </div>
                  <p
                    className={`text-xs mt-1 ${coolingSystem ? "text-cyan-700 dark:text-cyan-300" : "text-muted-foreground"}`}
                  >
                    A/C or similar
                  </p>
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <button
                  data-testid="toggle-solar"
                  onClick={() => setHasSolarPanels((v) => !v)}
                  className={`p-3 rounded-2xl border text-left transition ${
                    hasSolarPanels
                      ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300"
                      : "bg-card border-border text-foreground hover:bg-background"
                  }`}
                >
                  <div className="flex items-center gap-2 font-bold">
                    <Zap
                      size={18}
                      className={
                        hasSolarPanels
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-muted-foreground/70"
                      }
                    />{" "}
                    Solar panels
                  </div>
                  <p
                    className={`text-xs mt-1 ${hasSolarPanels ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground"}`}
                  >
                    Rooftop PV installed
                  </p>
                </button>

                <button
                  data-testid="toggle-elevator"
                  onClick={() => setHasElevator((v) => !v)}
                  className={`p-3 rounded-2xl border text-left transition ${
                    hasElevator
                      ? "bg-sky-500/10 border-sky-500/30 text-sky-700 dark:text-sky-300"
                      : "bg-card border-border text-foreground hover:bg-background"
                  }`}
                >
                  <div className="flex items-center gap-2 font-bold">
                    <Building2
                      size={18}
                      className={
                        hasElevator ? "text-sky-600 dark:text-sky-400" : "text-muted-foreground/70"
                      }
                    />{" "}
                    Elevator
                  </div>
                  <p
                    className={`text-xs mt-1 ${hasElevator ? "text-sky-700 dark:text-sky-300" : "text-muted-foreground"}`}
                  >
                    Lift access
                  </p>
                </button>

                <button
                  data-testid="toggle-storage"
                  onClick={() => setHasStorageUnit((v) => !v)}
                  className={`p-3 rounded-2xl border text-left transition ${
                    hasStorageUnit
                      ? "bg-purple-500/10 border-purple-500/30 text-purple-700 dark:text-purple-300"
                      : "bg-card border-border text-foreground hover:bg-background"
                  }`}
                >
                  <div className="flex items-center gap-2 font-bold">
                    <Store
                      size={18}
                      className={
                        hasStorageUnit
                          ? "text-purple-600 dark:text-purple-400"
                          : "text-muted-foreground/70"
                      }
                    />{" "}
                    Storage
                  </div>
                  <p
                    className={`text-xs mt-1 ${hasStorageUnit ? "text-purple-700 dark:text-purple-300" : "text-muted-foreground"}`}
                  >
                    Has storage unit
                  </p>
                </button>

                <div className="p-3 rounded-2xl border border-border bg-card">
                  <label className="text-xs font-semibold text-muted-foreground">
                    Parking spaces
                  </label>
                  <div className="mt-1.5">
                    <CountSelect
                      testId="select-parking"
                      value={String(parkingSpaces)}
                      onChange={(v) => setParkingSpaces(Number(v) || 0)}
                      icon={Car}
                      hidePlaceholder
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* STAGE 7: Cost */}
          {addStage === 7 && (
            <div className="space-y-4">
              {acquisitionMode !== "developed" ? (
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-muted-foreground ml-1">
                      Acquisition Price
                      {acquisitionMode === "inherited" && (
                        <span className="font-normal text-muted-foreground/60"> (optional)</span>
                      )}
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/70 text-sm font-bold">
                        €
                      </span>
                      <input
                        data-testid="input-acquisition-price"
                        type="text"
                        inputMode="numeric"
                        value={formatThousands(acquisitionPrice)}
                        onChange={(e) => setAcquisitionPrice(stripThousands(e.target.value))}
                        placeholder="0"
                        className="w-full bg-background border-none rounded-xl pl-8 pr-4 py-2.5 text-foreground font-medium placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-muted-foreground ml-1">
                      Acquisition Year
                    </label>
                    <YearSelect
                      testId="input-acquisition-year"
                      value={acquisitionYear}
                      onChange={setAcquisitionYear}
                      min={MIN_YEAR}
                      max={MAX_ACQUISITION_YEAR}
                    />
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-muted-foreground ml-1">
                      Development Cost
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/70 text-sm font-bold">
                        €
                      </span>
                      <input
                        data-testid="input-development-cost"
                        type="text"
                        inputMode="numeric"
                        value={formatThousands(developmentCost)}
                        onChange={(e) => setDevelopmentCost(stripThousands(e.target.value))}
                        placeholder="0"
                        className="w-full bg-background border-none rounded-xl pl-8 pr-4 py-2.5 text-foreground font-medium placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-muted-foreground ml-1">
                      Development Year
                    </label>
                    <YearSelect
                      testId="input-development-year"
                      value={developmentYear}
                      onChange={setDevelopmentYear}
                      min={MIN_YEAR}
                      max={MAX_DEVELOPMENT_YEAR}
                    />
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <label className="text-xs font-semibold text-muted-foreground ml-1">
                  Current Value
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/70 text-sm font-bold">
                    €
                  </span>
                  <input
                    data-testid="input-current-value"
                    type="text"
                    inputMode="numeric"
                    value={formatThousands(currentValue)}
                    onChange={(e) => setCurrentValue(stripThousands(e.target.value))}
                    placeholder="0"
                    className="w-full bg-background border-none rounded-xl pl-8 pr-4 py-2.5 text-foreground font-medium placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
                  />
                </div>
              </div>
            </div>
          )}

          {/* STAGE 8: Ownership */}
          {addStage === 8 && (
            <div className="space-y-4">
              <div className="space-y-3">
                <label className="text-xs font-semibold text-muted-foreground ml-1">
                  Ownership Type
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    data-testid="button-ownership-individual"
                    onClick={() => setOwnershipType("individual")}
                    className={`p-3 rounded-2xl border text-left transition ${
                      ownershipType === "individual"
                        ? "bg-primary text-primary-foreground border-gray-900"
                        : "bg-card border-border text-foreground hover:bg-background"
                    }`}
                  >
                    <div className="flex items-center gap-2 font-bold">
                      <Users size={18} /> Individual
                    </div>
                    <p
                      className={`text-xs mt-1 ${ownershipType === "individual" ? "text-primary-foreground/80" : "text-muted-foreground"}`}
                    >
                      Owned personally
                    </p>
                  </button>
                  <button
                    data-testid="button-ownership-company"
                    onClick={() => setOwnershipType("company")}
                    className={`p-3 rounded-2xl border text-left transition ${
                      ownershipType === "company"
                        ? "bg-primary text-primary-foreground border-gray-900"
                        : "bg-card border-border text-foreground hover:bg-background"
                    }`}
                  >
                    <div className="flex items-center gap-2 font-bold">
                      <Briefcase size={18} /> Company
                    </div>
                    <p
                      className={`text-xs mt-1 ${ownershipType === "company" ? "text-primary-foreground/80" : "text-muted-foreground"}`}
                    >
                      Owned via entity
                    </p>
                  </button>
                </div>
              </div>

              {ownershipType === "company" && (
                <div className="space-y-2">
                  <label className="text-xs font-semibold text-muted-foreground ml-1">
                    Company Name
                  </label>
                  <input
                    data-testid="input-company-name"
                    type="text"
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    placeholder="e.g. Olio Holdings Ltd"
                    className="w-full bg-background border-none rounded-xl px-4 py-2.5 text-foreground font-medium placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
                  />
                </div>
              )}

              <div className="space-y-3">
                <label className="text-xs font-semibold text-muted-foreground ml-1">
                  Title Deeds Status
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    data-testid="button-title-issued"
                    onClick={() => setTitleDeedsStatus("issued")}
                    className={`p-3 rounded-2xl border text-left transition ${
                      titleDeedsStatus === "issued"
                        ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300"
                        : "bg-card border-border text-foreground hover:bg-background"
                    }`}
                  >
                    <div className="flex items-center gap-2 font-bold">
                      <CheckCircle2
                        size={18}
                        className={
                          titleDeedsStatus === "issued"
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-muted-foreground/70"
                        }
                      />{" "}
                      Issued
                    </div>
                    <p
                      className={`text-xs mt-1 ${titleDeedsStatus === "issued" ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground"}`}
                    >
                      Deeds in hand
                    </p>
                  </button>
                  <button
                    data-testid="button-title-pending"
                    onClick={() => setTitleDeedsStatus("pending")}
                    className={`p-3 rounded-2xl border text-left transition ${
                      titleDeedsStatus === "pending"
                        ? "bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300"
                        : "bg-card border-border text-foreground hover:bg-background"
                    }`}
                  >
                    <div className="flex items-center gap-2 font-bold">
                      <FileText
                        size={18}
                        className={
                          titleDeedsStatus === "pending"
                            ? "text-amber-600 dark:text-amber-400"
                            : "text-muted-foreground/70"
                        }
                      />{" "}
                      Pending
                    </div>
                    <p
                      className={`text-xs mt-1 ${titleDeedsStatus === "pending" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}
                    >
                      In progress
                    </p>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* STAGE 9: Documents — files are picked here and uploaded right after the
     property is created (the signed-URL endpoints verify ownership of the new
     property id). Gated on the `documents.upload` owner-plan privilege, the
     same gate the property page's Documents card uses. */}
          {addStage === 9 && (
            <div className="space-y-4">
              {canUploadDocuments ? (
                <>
                  <input
                    data-testid="input-property-documents"
                    type="file"
                    multiple
                    accept={DOCUMENT_ACCEPT}
                    className="hidden"
                    id="property-documents"
                    onChange={(e) => {
                      const picked = Array.from(e.target.files ?? []);
                      if (picked.length) setDocumentFiles((prev) => [...prev, ...picked]);
                      // Reset so picking the same file again still fires onChange.
                      e.target.value = "";
                    }}
                  />
                  <label
                    htmlFor="property-documents"
                    data-testid="button-upload-documents"
                    className="w-full bg-background border-2 border-dashed border-border rounded-2xl flex flex-col items-center justify-center gap-2 cursor-pointer hover:bg-secondary transition py-6 px-6 text-center"
                  >
                    <div className="w-12 h-12 bg-card rounded-full shadow-sm flex items-center justify-center text-primary">
                      <Upload size={24} />
                    </div>
                    <p className="text-sm font-semibold text-foreground">Tap to attach documents</p>
                    <p className="text-xs text-muted-foreground max-w-sm">
                      Contracts, deeds, inspection reports. PDF, image, Word or Excel — up to
                      25&nbsp;MB each. They upload once your property is created.
                    </p>
                  </label>

                  {documentFiles.length > 0 && (
                    <ul className="space-y-2">
                      {documentFiles.map((file, i) => (
                        <li
                          key={`${file.name}-${i}`}
                          className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card"
                        >
                          <div className="w-9 h-9 bg-secondary rounded-lg flex items-center justify-center text-muted-foreground shrink-0">
                            <FileText size={16} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-foreground truncate">
                              {file.name}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {formatBytes(file.size)}
                            </p>
                          </div>
                          <button
                            type="button"
                            data-testid={`button-remove-document-${i}`}
                            onClick={() =>
                              setDocumentFiles((prev) => prev.filter((_, idx) => idx !== i))
                            }
                            className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition"
                            title="Remove"
                          >
                            <X size={16} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                /* Locked: document storage is a premium feature. Mirror the property
    page's paywall rather than showing a picker that 402s on finalize. */
                <button
                  type="button"
                  data-testid="button-documents-upgrade"
                  onClick={() => setIsPricingOpen(true)}
                  className="w-full bg-card border border-border rounded-2xl p-6 text-center space-y-3 hover:bg-background transition"
                >
                  <div className="w-12 h-12 mx-auto bg-primary/10 text-primary rounded-full flex items-center justify-center">
                    <Lock size={22} />
                  </div>
                  <p className="text-sm font-semibold text-foreground">
                    Document storage is a premium feature
                  </p>
                  <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                    Upgrade to attach contracts, deeds, and inspection reports — signed, stored, and
                    shareable with your tenant.
                  </p>
                </button>
              )}
            </div>
          )}

          {/* STAGE 11: Use & status */}
          {addStage === 11 && (
            <div className="space-y-5">
              {/* Intended use — drives whether the Finish step offers a tenant */}
              <div className="space-y-3">
                <label className="text-xs font-semibold text-muted-foreground ml-1">
                  Intended use
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    data-testid="button-use-rent"
                    onClick={() => setPropertyUse("rent")}
                    className={`p-3 rounded-2xl border text-left transition ${
                      propertyUse === "rent"
                        ? "bg-primary text-primary-foreground border-primary shadow-lg shadow-primary/20"
                        : "bg-card border-border text-foreground hover:bg-background"
                    }`}
                  >
                    <div className="flex items-center gap-2 font-bold">
                      <Banknote size={18} /> For rent
                    </div>
                    <p
                      className={`text-xs mt-1 ${propertyUse === "rent" ? "text-primary-foreground/80" : "text-muted-foreground"}`}
                    >
                      You rent this out — track tenants, leases &amp; rent income
                    </p>
                  </button>
                  <button
                    type="button"
                    data-testid="button-use-hold"
                    onClick={() => {
                      setPropertyUse("hold");
                      // Hold/invest tracks the asset, not tenancy — no current status.
                      setOccupancyStatus("");
                    }}
                    className={`p-3 rounded-2xl border text-left transition ${
                      propertyUse === "hold"
                        ? "bg-primary text-primary-foreground border-primary shadow-lg shadow-primary/20"
                        : "bg-card border-border text-foreground hover:bg-background"
                    }`}
                  >
                    <div className="flex items-center gap-2 font-bold">
                      <TrendingUp size={18} /> Hold / invest
                    </div>
                    <p
                      className={`text-xs mt-1 ${propertyUse === "hold" ? "text-primary-foreground/80" : "text-muted-foreground"}`}
                    >
                      Tracking asset value, capital gain &amp; portfolio weight
                    </p>
                  </button>
                  <button
                    type="button"
                    data-testid="button-use-owner_occupied"
                    onClick={() => {
                      setPropertyUse("owner_occupied");
                      // Owner-occupied is its own use — there's no separate
                      // current status to keep.
                      setOccupancyStatus("");
                    }}
                    className={`col-span-2 p-3 rounded-2xl border text-left transition ${
                      propertyUse === "owner_occupied"
                        ? "bg-primary text-primary-foreground border-primary shadow-lg shadow-primary/20"
                        : "bg-card border-border text-foreground hover:bg-background"
                    }`}
                  >
                    <div className="flex items-center gap-2 font-bold">
                      <Home size={18} /> Owner-occupied
                    </div>
                    <p
                      className={`text-xs mt-1 ${propertyUse === "owner_occupied" ? "text-primary-foreground/80" : "text-muted-foreground"}`}
                    >
                      You live here yourself — no tenant or rent tracking
                    </p>
                  </button>
                </div>
              </div>

              {/* Current status — only meaningful for a rented-out property. Hidden
                  for hold/invest and owner-occupied (no tenancy to track). */}
              {propertyUse === "rent" && (
                <div className="space-y-3">
                  <label className="text-xs font-semibold text-muted-foreground ml-1">
                    Current status
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { id: "rented" as const, label: "Rented", icon: Key },
                      { id: "vacant" as const, label: "Vacant", icon: DoorOpen },
                    ].map((s) => (
                      <button
                        type="button"
                        key={s.id}
                        data-testid={`button-occupancy-${s.id}`}
                        onClick={() => setOccupancyStatus(s.id)}
                        className={`flex flex-col items-center justify-center gap-2 p-3 rounded-2xl border transition h-24 ${
                          occupancyStatus === s.id
                            ? "bg-primary text-primary-foreground border-primary shadow-lg shadow-primary/20"
                            : "bg-card border-border text-muted-foreground hover:border-border hover:bg-background"
                        }`}
                      >
                        <s.icon size={22} strokeWidth={occupancyStatus === s.id ? 2.5 : 2} />
                        <span className="text-xs font-semibold text-center leading-tight">
                          {s.label}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* STAGE 12: Finish */}
          {addStage === 12 &&
            (() => {
              // A hold/invest or owner-occupied property has no tenant to assign, so we
              // skip the tenant question entirely (per onboarding spec). `tenantEligible`
              // is derived once at component scope (also drives the header subtitle).
              return (
                <div className="space-y-4 text-center py-4">
                  <div className="w-16 h-16 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 rounded-full flex items-center justify-center mx-auto mb-2 animate-in zoom-in duration-300">
                    <CheckCircle2 size={32} />
                  </div>
                  <h3 className="text-xl font-bold text-foreground">Property Details Ready!</h3>
                  {tenantEligible ? (
                    <>
                      <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                        Would you like to assign a tenant and create a rental agreement now?
                      </p>

                      <div className="grid grid-cols-2 gap-3 mt-6">
                        <button
                          data-testid="button-skip-tenant"
                          onClick={() => setAssignTenant(false)}
                          className={`p-4 rounded-2xl border transition flex flex-col items-center justify-center gap-2 h-24 ${
                            !assignTenant
                              ? "bg-primary text-primary-foreground border-gray-900 shadow-md scale-[1.02]"
                              : "bg-card border-border text-muted-foreground hover:border-border hover:bg-background"
                          }`}
                        >
                          <span className="font-bold text-sm">No, maybe later</span>
                        </button>
                        <button
                          data-testid="button-assign-tenant"
                          onClick={() => setAssignTenant(true)}
                          className={`p-4 rounded-2xl border transition flex flex-col items-center justify-center gap-2 h-24 ${
                            assignTenant
                              ? "bg-primary text-primary-foreground border-primary shadow-lg shadow-primary/20 scale-[1.02]"
                              : "bg-card border-border text-muted-foreground hover:border-border hover:bg-background"
                          }`}
                        >
                          <span className="font-bold text-sm">Yes, add tenant</span>
                        </button>
                      </div>
                    </>
                  ) : null}
                </div>
              );
            })()}
        </div>
      </ResponsiveDrawer>

      <AddTenantDrawer
        open={isAddTenantOpen}
        onOpenChange={setIsAddTenantOpen}
        propertyAddress={address || name}
      />
    </>
  );
}
