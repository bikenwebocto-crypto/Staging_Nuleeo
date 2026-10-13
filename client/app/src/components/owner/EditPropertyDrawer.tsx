// Single-page property editor. Unlike AddPropertyDrawer (an 11-step wizard
// tuned for first-time capture — drafts, unit-cap gating, assign-tenant
// finish), editing shows every field at once on one scrollable page so an
// owner can jump straight to the thing they want to change.
//
// The PATCH payload below is kept faithful to AddPropertyDrawer.handleSave /
// the server's PATCH /api/properties/:id field list — if you add a property
// field there, mirror it here.

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import {
  Upload,
  Home,
  MapPin,
  Activity,
  Building,
  Building2,
  Store,
  Map,
  Hotel,
  Zap,
  Flame,
  Snowflake,
  Users,
  Briefcase,
  CheckCircle2,
  FileText,
  Construction,
  Banknote,
  TrendingUp,
  Key,
  DoorOpen,
  Car,
} from "lucide-react";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";
import { AddressAutocomplete } from "@ui/components/common/AddressAutocomplete";
import { AddressMapPicker } from "@ui/components/common/AddressMapPicker";
import { YearSelect } from "@ui/components/common/YearSelect";
import { CountSelect } from "@ui/components/common/CountSelect";
import { CountrySelect } from "@ui/components/common/CountrySelect";
import { CityAutocomplete } from "@ui/components/common/CityAutocomplete";
import { getCountryCode, validatePostalCode } from "@ui/data/countries";
import { useToast } from "@ui/hooks/use-toast";
import { apiRequest } from "@ui/lib/queryClient";
import { uploadPropertyPhoto } from "@ui/lib/uploadPropertyPhoto";
import { useQueryClient } from "@tanstack/react-query";

interface EditPropertyDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  property: any;
}

const formatThousands = (raw: string) => {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  return Number(digits).toLocaleString("en-US");
};
const stripThousands = (val: string) => val.replace(/\D/g, "");

// Room counts come from text inputs as strings. `Number(x) || undefined`
// silently dropped a real 0 (studio / no separate bath) because 0 is falsy.
// Blank -> undefined (omit the field); genuine numeric 0 -> 0 (send it).
const countOrUndefined = (val: string): number | undefined => {
  const trimmed = val.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
};

const CURRENT_YEAR = new Date().getFullYear();
const MIN_YEAR = 1800;
const MAX_FUTURE_BUILT_YEAR = CURRENT_YEAR + 5;
const MAX_ACQUISITION_YEAR = CURRENT_YEAR;
const isYearInRange = (val: string, min: number, max: number): boolean => {
  if (!val) return false;
  const n = Number(val);
  return Number.isInteger(n) && n >= min && n <= max;
};

const inputCls =
  "w-full bg-background border-none rounded-xl px-4 py-3.5 text-foreground font-medium placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/20 transition";
// Year <select> styled to match inputCls height (the YearSelect adds the left
// icon padding + chevron itself).
const yearSelectCls =
  "w-full appearance-none bg-background border-none rounded-xl pr-9 py-3.5 text-foreground font-medium focus:outline-none focus:ring-2 focus:ring-primary/20 transition";

const PROPERTY_TYPES = [
  { id: "Apartment", icon: Building2, label: "Apartment" },
  { id: "House", icon: Home, label: "House" },
  { id: "Villa", icon: Hotel, label: "Villa" },
  { id: "Commercial", icon: Store, label: "Commercial" },
  { id: "Plot", icon: Map, label: "Plot" },
] as const;

// Mirrors AddPropertyDrawer: F and G are merged into one "F-G" low class, plus
// "N/A" for an unknown rating. Legacy single-letter "F"/"G"/"A+" values on older
// properties stay stored as-is (they just won't pre-highlight a button here).
const ENERGY_GRADES = ["A+", "A", "B", "C", "D", "E", "F-G", "N/A"] as const;
const energyClasses = (grade: string, active: boolean) => {
  if (!active)
    return "bg-card border-border text-muted-foreground/70 hover:border-border hover:bg-background hover:text-muted-foreground";
  switch (grade) {
    case "A+":
      return "bg-emerald-600 text-white border-emerald-600 shadow-md shadow-emerald-600/30";
    case "A":
      return "bg-emerald-500 text-white border-emerald-500 shadow-md shadow-emerald-500/30";
    case "B":
      return "bg-emerald-400 text-white border-emerald-400 shadow-md shadow-emerald-400/30";
    case "C":
      return "bg-lime-500 text-white border-lime-500 shadow-md shadow-lime-500/30";
    case "D":
      return "bg-yellow-400 text-white border-yellow-400 shadow-md shadow-yellow-400/30";
    case "E":
      return "bg-orange-400 text-white border-orange-400 shadow-md shadow-orange-400/30";
    case "F-G":
      return "bg-red-500 text-white border-red-500 shadow-md shadow-red-500/30";
    default:
      return "bg-slate-400 text-white border-slate-400 shadow-md shadow-slate-400/30";
  }
};

// Section wrapper — icon + heading, then the section's fields.
function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: ComponentType<{ size?: number; className?: string }>;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <Icon size={16} />
        </div>
        <h3 className="text-sm font-bold uppercase tracking-wide text-foreground">{title}</h3>
      </div>
      {children}
    </section>
  );
}

// A coloured on/off feature toggle (heating, solar, etc.).
function FeatureToggle({
  active,
  onClick,
  icon: Icon,
  label,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  icon: ComponentType<{ size?: number; className?: string }>;
  label: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={`p-4 rounded-2xl border text-left transition flex items-center gap-2 font-bold ${
        active
          ? "bg-primary/10 border-primary/30 text-foreground"
          : "bg-card border-border text-muted-foreground hover:bg-background"
      }`}
    >
      <Icon size={18} className={active ? "text-primary" : "text-muted-foreground/70"} />
      {label}
    </button>
  );
}

export function EditPropertyDrawer({ open, onOpenChange, property }: EditPropertyDrawerProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // When the property has an ACTIVE tenant (server-derived `occupied`), the
  // charged rent lives on the lease (Tenant/Agreement) and must be changed
  // there via applyRentChange — editing the property's rentPrice here would
  // NOT reach the tenant and would silently disagree with what they're charged.
  // So the field is shown read-only and rentPrice is excluded from the PATCH.
  const isOccupied = Boolean(property?.occupied);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);

  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);

  const [activeType, setActiveType] = useState("Apartment");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [addressNumber, setAddressNumber] = useState("");
  const [city, setCity] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [country, setCountry] = useState("Cyprus");
  const [floor, setFloor] = useState("");
  const [buildingName, setBuildingName] = useState("");
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);

  const [sqm, setSqm] = useState("");
  const [bedrooms, setBedrooms] = useState("");
  const [baths, setBaths] = useState("");
  const [builtYear, setBuiltYear] = useState("");
  const [energyClass, setEnergyClass] = useState("");
  const [developmentStatus, setDevelopmentStatus] = useState("fully_developed");

  const [heatingSystem, setHeatingSystem] = useState(false);
  const [coolingSystem, setCoolingSystem] = useState(false);
  const [hasSolarPanels, setHasSolarPanels] = useState(false);
  const [hasElevator, setHasElevator] = useState(false);
  const [hasStorageUnit, setHasStorageUnit] = useState(false);
  const [parkingSpaces, setParkingSpaces] = useState(0);

  const [currentValue, setCurrentValue] = useState("");
  const [acquisitionPrice, setAcquisitionPrice] = useState("");
  const [acquisitionYear, setAcquisitionYear] = useState("");
  const [developmentYear, setDevelopmentYear] = useState("");
  const [propertyUse, setPropertyUse] = useState<"hold" | "rent" | "owner_occupied">("rent");
  const [occupancyStatus, setOccupancyStatus] = useState<
    "rented" | "vacant" | "owner_occupied" | ""
  >("");
  const [rentPrice, setRentPrice] = useState("");

  const [ownershipType, setOwnershipType] = useState<"individual" | "company">("individual");
  const [companyName, setCompanyName] = useState("");
  const [titleDeedsStatus, setTitleDeedsStatus] = useState<"issued" | "pending">("issued");

  // Revoke local blob: previews on swap/unmount; leave remote https URLs alone.
  useEffect(() => {
    return () => {
      if (photoPreview && photoPreview.startsWith("blob:")) {
        URL.revokeObjectURL(photoPreview);
      }
    };
  }, [photoPreview]);

  // Hydrate from the property each time the drawer opens.
  useEffect(() => {
    if (!open || !property) return;
    setActiveType(property.propertyType ?? "Apartment");
    setName(property.name ?? "");
    setAddress(property.address ?? "");
    setAddressNumber(property.addressNumber ?? "");
    setCity(property.city ?? "");
    setPostalCode(property.postalCode ?? "");
    setCountry(property.country ?? "Cyprus");
    setFloor(property.floor ?? "");
    setBuildingName(property.buildingName ?? "");
    setLat(typeof property.lat === "number" ? property.lat : null);
    setLng(typeof property.lng === "number" ? property.lng : null);
    setSqm(property.sqm ?? "");
    setBedrooms(property.bedrooms != null ? String(property.bedrooms) : "");
    setBaths(property.baths != null ? String(property.baths) : "");
    setBuiltYear(property.builtYear ?? "");
    setEnergyClass(property.energyClass ?? "");
    setDevelopmentStatus(property.developmentStatus ?? "fully_developed");
    setHeatingSystem(!!property.heating);
    setCoolingSystem(!!property.cooling);
    setHasSolarPanels(!!property.solarPanels);
    setHasElevator(!!property.elevator);
    setHasStorageUnit(!!property.storageUnit);
    setParkingSpaces(typeof property.parking === "number" ? property.parking : 0);
    setCurrentValue(property.propertyValue ? String(property.propertyValue) : "");
    setAcquisitionPrice(property.acquisitionPrice ? String(property.acquisitionPrice) : "");
    setAcquisitionYear(property.acquisitionYear ?? "");
    setDevelopmentYear(property.developmentYear ?? "");
    // Owner-occupancy is a use now. Legacy props stored it as a status, so lift
    // that into the use and clear the (now-redundant) status.
    setPropertyUse(
      property.propertyUse === "hold"
        ? "hold"
        : property.propertyUse === "owner_occupied" || property.occupancyStatus === "owner_occupied"
          ? "owner_occupied"
          : "rent",
    );
    setOccupancyStatus(
      property.occupancyStatus && property.occupancyStatus !== "owner_occupied"
        ? property.occupancyStatus
        : "",
    );
    setRentPrice(
      property.rentPrice
        ? String(property.rentPrice)
        : property.rentAmount
          ? String(property.rentAmount)
          : "",
    );
    setOwnershipType(property.ownershipType === "company" ? "company" : "individual");
    setCompanyName(property.companyName ?? "");
    setTitleDeedsStatus(property.titleDeedsStatus === "pending" ? "pending" : "issued");
    // Reset any pending photo selection from a previous open.
    setPhotoFile(null);
    setPhotoPreview(null);
  }, [open, property]);

  const isApartment = activeType === "Apartment";
  const isPlot = activeType === "Plot";

  // Postal-code format check against the selected country (drives the inline
  // error; handleSave also hard-blocks an invalid code).
  const postalCheck = validatePostalCode(country, postalCode);
  const postalInvalid = postalCode.trim().length > 0 && !postalCheck.valid;

  const handleSave = async () => {
    const propertyValueNum = Number(stripThousands(currentValue));
    if (!Number.isFinite(propertyValueNum) || propertyValueNum <= 0) {
      toast({
        title: "Current value required",
        description: "Enter a positive current value before saving.",
        variant: "destructive",
      });
      return;
    }
    if (builtYear && !isYearInRange(builtYear, MIN_YEAR, MAX_FUTURE_BUILT_YEAR)) {
      toast({
        title: "Check built year",
        description: `Built year must be between ${MIN_YEAR} and ${MAX_FUTURE_BUILT_YEAR}.`,
        variant: "destructive",
      });
      return;
    }
    if (acquisitionYear && !isYearInRange(acquisitionYear, MIN_YEAR, MAX_ACQUISITION_YEAR)) {
      toast({
        title: "Check acquisition year",
        description: `Acquisition year must be between ${MIN_YEAR} and ${MAX_ACQUISITION_YEAR} — can't be in the future.`,
        variant: "destructive",
      });
      return;
    }
    if (developmentYear && !isYearInRange(developmentYear, MIN_YEAR, MAX_FUTURE_BUILT_YEAR)) {
      toast({
        title: "Check development year",
        description: `Development year must be between ${MIN_YEAR} and ${MAX_FUTURE_BUILT_YEAR}.`,
        variant: "destructive",
      });
      return;
    }
    if (!postalCheck.valid) {
      toast({
        title: "Check postal code",
        description: postalCheck.message ?? "The postal code doesn't match the country format.",
        variant: "destructive",
      });
      return;
    }

    // Upload a freshly-picked photo first so we persist a real https URL, not
    // a blob: URL. Otherwise keep whatever the property already had.
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
    } else if (property?.image) {
      imageUrl = property.image;
    }

    const acquisitionPriceNum = Number(stripThousands(acquisitionPrice));
    const rentPriceNum = Number(stripThousands(rentPrice));

    const payload: Record<string, unknown> = {
      address: address || name,
      ...(name.trim() ? { name: name.trim() } : {}),
      propertyValue: propertyValueNum,
      acquisitionPrice: Number.isFinite(acquisitionPriceNum) ? acquisitionPriceNum : 0,
      propertyType: activeType || undefined,
      buildingName: isApartment ? buildingName || undefined : undefined,
      floor: isApartment ? floor || undefined : undefined,
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
      ...(isPlot ? {} : { developmentStatus }),
      propertyUse,
      ...(occupancyStatus ? { occupancyStatus } : {}),
      ...(acquisitionYear ? { acquisitionYear } : {}),
      ...(!isPlot && developmentYear ? { developmentYear } : {}),
      // Never send rentPrice for an occupied property — the field is locked in
      // the UI and the charged rent is owned by the lease (see isOccupied).
      ...(propertyUse === "rent" && !isOccupied && Number.isFinite(rentPriceNum) && rentPriceNum > 0
        ? { rentPrice: rentPriceNum }
        : {}),
    };

    try {
      setIsSaving(true);
      await apiRequest("PATCH", `/api/properties/${property.id}`, payload);
      await queryClient.invalidateQueries({ queryKey: ["/api/owner/properties"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/tenant/agreements"] });
      await queryClient.invalidateQueries({ queryKey: [`/api/properties/${property.id}`] });
    } catch (err: any) {
      toast({
        title: "Could not update property",
        description: err?.message ?? "Something went wrong. Please try again.",
        variant: "destructive",
      });
      setIsSaving(false);
      return;
    }
    setIsSaving(false);
    toast({ title: "Property Updated", description: "Your changes have been saved." });
    onOpenChange(false);
  };

  const footer = (
    <div className="flex gap-3">
      <button
        type="button"
        data-testid="button-edit-save"
        onClick={handleSave}
        disabled={isSaving || isUploadingPhoto}
        className="flex-1 font-bold text-lg py-4 rounded-2xl shadow-lg transition active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed bg-primary text-primary-foreground shadow-primary/30 hover:bg-primary/90"
      >
        {isUploadingPhoto ? "Uploading photo…" : isSaving ? "Saving…" : "Save Changes"}
      </button>
    </div>
  );

  return (
    <ResponsiveDrawer
      open={open}
      onOpenChange={onOpenChange}
      title="Edit Property"
      footer={footer}
      desktopMaxWidth="max-w-3xl"
    >
      <div className="max-w-2xl mx-auto space-y-10 pb-2">
        {/* BASICS — photo, name, type */}
        <Section icon={Home} title="Basics">
          <input
            data-testid="input-edit-photo"
            type="file"
            accept="image/*"
            className="hidden"
            id="edit-property-photo"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (photoPreview && photoPreview.startsWith("blob:")) {
                URL.revokeObjectURL(photoPreview);
              }
              setPhotoFile(file);
              setPhotoPreview(URL.createObjectURL(file));
            }}
          />
          <label
            htmlFor="edit-property-photo"
            className="w-full h-48 bg-background border-2 border-dashed border-border rounded-2xl flex flex-col items-center justify-center gap-3 cursor-pointer hover:bg-secondary transition group relative overflow-hidden"
          >
            {photoPreview || property?.image ? (
              <img
                src={photoPreview || property.image}
                alt="Property"
                className="w-full h-full object-cover"
              />
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
            htmlFor="edit-property-photo"
            className="inline-flex items-center justify-center w-full px-4 py-3 rounded-xl bg-secondary text-foreground font-bold hover:bg-background transition cursor-pointer"
          >
            {photoPreview || property?.image ? "Replace photo" : "Upload photo"}
          </label>

          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground ml-1">
              Property Name
            </label>
            <input
              data-testid="input-edit-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Seaside Apartment"
              className={inputCls}
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground ml-1">
              Property Type
            </label>
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
              {PROPERTY_TYPES.map((type) => (
                <button
                  type="button"
                  key={type.id}
                  data-testid={`button-edit-type-${type.id}`}
                  onClick={() => setActiveType(type.id)}
                  className={`flex flex-col items-center justify-center gap-2 p-3 rounded-2xl border transition-all duration-200 h-24 ${
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
        </Section>

        {/* LOCATION */}
        <Section icon={MapPin} title="Location">
          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground ml-1">Address</label>
            <AddressAutocomplete
              testId="input-edit-address"
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
            <AddressMapPicker
              lat={lat}
              lng={lng}
              onChange={(la, ln) => {
                setLat(la);
                setLng(ln);
              }}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-xs font-semibold text-muted-foreground ml-1">
                Address Number
              </label>
              <input
                data-testid="input-edit-address-number"
                type="text"
                value={addressNumber}
                onChange={(e) => setAddressNumber(e.target.value)}
                placeholder="e.g. 12"
                className={inputCls}
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-semibold text-muted-foreground ml-1">City</label>
              <CityAutocomplete
                testId="input-edit-city"
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
                data-testid="input-edit-postal"
                type="text"
                value={postalCode}
                onChange={(e) => setPostalCode(e.target.value)}
                placeholder="e.g. 3036"
                aria-invalid={postalInvalid}
                className={postalInvalid ? `${inputCls} ring-2 ring-destructive/50` : inputCls}
              />
              {postalInvalid && (
                <p className="text-[11px] text-destructive ml-1">{postalCheck.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <label className="text-xs font-semibold text-muted-foreground ml-1">Country</label>
              <CountrySelect
                testId="input-edit-country"
                value={country}
                onChange={(name) => {
                  if (name !== country) {
                    setCity("");
                    setPostalCode("");
                  }
                  setCountry(name);
                }}
              />
            </div>
          </div>

          {isApartment && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-xs font-semibold text-muted-foreground ml-1">Floor</label>
                <input
                  data-testid="input-edit-floor"
                  type="text"
                  value={floor}
                  onChange={(e) => setFloor(e.target.value)}
                  placeholder="e.g. 4"
                  className={inputCls}
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-semibold text-muted-foreground ml-1">
                  Building Name
                </label>
                <div className="relative">
                  <Building
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/70"
                    size={16}
                  />
                  <input
                    data-testid="input-edit-building"
                    type="text"
                    value={buildingName}
                    onChange={(e) => setBuildingName(e.target.value)}
                    placeholder="e.g. Sunset Towers"
                    className={`${inputCls} pl-10`}
                  />
                </div>
              </div>
            </div>
          )}
        </Section>

        {/* SPECS */}
        <Section icon={Activity} title="Specs">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-xs font-semibold text-muted-foreground ml-1">Size (sqm)</label>
              <input
                data-testid="input-edit-sqm"
                type="number"
                value={sqm}
                onChange={(e) => setSqm(e.target.value)}
                placeholder="e.g. 85"
                className={inputCls}
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-semibold text-muted-foreground ml-1">Built Year</label>
              <YearSelect
                testId="input-edit-built-year"
                value={builtYear}
                onChange={setBuiltYear}
                min={MIN_YEAR}
                max={MAX_FUTURE_BUILT_YEAR}
                className={yearSelectCls}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-xs font-semibold text-muted-foreground ml-1">Bedrooms</label>
              <CountSelect
                testId="input-edit-bedrooms"
                value={bedrooms}
                onChange={setBedrooms}
                icon={DoorOpen}
                className={yearSelectCls}
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-semibold text-muted-foreground ml-1">Bathrooms</label>
              <CountSelect
                testId="input-edit-baths"
                value={baths}
                onChange={setBaths}
                icon={Home}
                className={yearSelectCls}
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground ml-1">Energy Class</label>
            <div className="flex gap-2 overflow-x-auto pb-2 hide-scrollbar">
              {ENERGY_GRADES.map((grade) => (
                <button
                  type="button"
                  key={grade}
                  data-testid={`button-edit-energy-${grade}`}
                  onClick={() => setEnergyClass(grade)}
                  className={`flex-shrink-0 min-w-12 h-12 px-2 rounded-xl border flex items-center justify-center font-bold text-lg transition-all duration-200 ${energyClasses(
                    grade,
                    energyClass === grade,
                  )}`}
                >
                  {grade}
                </button>
              ))}
            </div>
          </div>

          {/* Plots are raw land — no build to be off-plan or under
              construction, so the development-status picker doesn't apply. */}
          {!isPlot && (
            <div className="space-y-2">
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
                    type="button"
                    key={status.id}
                    data-testid={`button-edit-dev-${status.id}`}
                    onClick={() => setDevelopmentStatus(status.id)}
                    className={`flex flex-col items-center justify-center gap-2 p-3 rounded-xl border transition-all duration-200 h-20 ${
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
        </Section>

        {/* FEATURES */}
        <Section icon={Zap} title="Features">
          <div className="grid grid-cols-2 gap-3">
            <FeatureToggle
              testId="toggle-edit-heating"
              active={heatingSystem}
              onClick={() => setHeatingSystem((v) => !v)}
              icon={Flame}
              label="Heating"
            />
            <FeatureToggle
              testId="toggle-edit-cooling"
              active={coolingSystem}
              onClick={() => setCoolingSystem((v) => !v)}
              icon={Snowflake}
              label="Cooling"
            />
            <FeatureToggle
              testId="toggle-edit-solar"
              active={hasSolarPanels}
              onClick={() => setHasSolarPanels((v) => !v)}
              icon={Zap}
              label="Solar panels"
            />
            <FeatureToggle
              testId="toggle-edit-elevator"
              active={hasElevator}
              onClick={() => setHasElevator((v) => !v)}
              icon={Building2}
              label="Elevator"
            />
            <FeatureToggle
              testId="toggle-edit-storage"
              active={hasStorageUnit}
              onClick={() => setHasStorageUnit((v) => !v)}
              icon={Store}
              label="Storage"
            />
            <div className="p-4 rounded-2xl border border-border bg-card">
              <label className="text-xs font-semibold text-muted-foreground">Parking spaces</label>
              <div className="mt-2">
                <CountSelect
                  testId="select-edit-parking"
                  value={String(parkingSpaces)}
                  onChange={(v) => setParkingSpaces(Number(v) || 0)}
                  icon={Car}
                  hidePlaceholder
                  className={yearSelectCls}
                />
              </div>
            </div>
          </div>
        </Section>

        {/* FINANCIALS */}
        <Section icon={TrendingUp} title="Financials">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-xs font-semibold text-muted-foreground ml-1">
                Current Value
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/70 text-sm font-bold">
                  €
                </span>
                <input
                  data-testid="input-edit-current-value"
                  type="text"
                  inputMode="numeric"
                  value={formatThousands(currentValue)}
                  onChange={(e) => setCurrentValue(stripThousands(e.target.value))}
                  placeholder="0"
                  className={`${inputCls} pl-8`}
                />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-semibold text-muted-foreground ml-1">
                Acquisition Price
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/70 text-sm font-bold">
                  €
                </span>
                <input
                  data-testid="input-edit-acquisition-price"
                  type="text"
                  inputMode="numeric"
                  value={formatThousands(acquisitionPrice)}
                  onChange={(e) => setAcquisitionPrice(stripThousands(e.target.value))}
                  placeholder="0"
                  className={`${inputCls} pl-8`}
                />
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground ml-1">
              Acquisition Year
            </label>
            <YearSelect
              testId="input-edit-acquisition-year"
              value={acquisitionYear}
              onChange={setAcquisitionYear}
              min={MIN_YEAR}
              max={MAX_ACQUISITION_YEAR}
              className={yearSelectCls}
            />
          </div>

          {!isPlot && (
            <div className="space-y-2">
              <label className="text-xs font-semibold text-muted-foreground ml-1">
                Development Year
                <span className="ml-1 font-normal text-muted-foreground/70">(if self-built)</span>
              </label>
              <YearSelect
                testId="input-edit-development-year"
                value={developmentYear}
                onChange={setDevelopmentYear}
                min={MIN_YEAR}
                max={MAX_FUTURE_BUILT_YEAR}
                className={yearSelectCls}
              />
            </div>
          )}

          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground ml-1">Use</label>
            <div className="grid grid-cols-3 gap-3">
              {[
                { id: "rent" as const, label: "Rented out", icon: Banknote },
                { id: "hold" as const, label: "Held", icon: TrendingUp },
                { id: "owner_occupied" as const, label: "Owner-occupied", icon: Home },
              ].map((u) => (
                <button
                  type="button"
                  key={u.id}
                  data-testid={`button-edit-use-${u.id}`}
                  onClick={() => {
                    setPropertyUse(u.id);
                    // Current status only applies to a rented-out property — clear it
                    // for hold/invest and owner-occupied so we never persist a
                    // contradictory status.
                    if (u.id !== "rent") setOccupancyStatus("");
                  }}
                  className={`flex flex-col items-center justify-center gap-2 p-3 rounded-2xl border transition h-24 ${
                    propertyUse === u.id
                      ? "bg-primary text-primary-foreground border-primary shadow-lg shadow-primary/20"
                      : "bg-card border-border text-muted-foreground hover:border-border hover:bg-background"
                  }`}
                >
                  <u.icon size={22} strokeWidth={propertyUse === u.id ? 2.5 : 2} />
                  <span className="text-xs font-semibold text-center leading-tight">{u.label}</span>
                </button>
              ))}
            </div>
          </div>

          {propertyUse === "rent" && (
            <div className="space-y-2">
              <label className="text-xs font-semibold text-muted-foreground ml-1">
                Monthly Rent
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/70 text-sm font-bold">
                  €
                </span>
                <input
                  data-testid="input-edit-rent"
                  type="text"
                  inputMode="numeric"
                  value={formatThousands(rentPrice)}
                  onChange={(e) => setRentPrice(stripThousands(e.target.value))}
                  placeholder="0"
                  disabled={isOccupied}
                  readOnly={isOccupied}
                  className={`${inputCls} pl-8 ${isOccupied ? "opacity-60 cursor-not-allowed" : ""}`}
                />
              </div>
              {isOccupied && (
                <p className="text-xs text-muted-foreground ml-1">
                  Set on the active lease. Change the rent from the lease so the tenant charges, the
                  agreement, and your records all stay in sync.
                </p>
              )}
            </div>
          )}

          {propertyUse === "rent" && (
            <div className="space-y-2">
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
                    data-testid={`button-edit-occupancy-${s.id}`}
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
        </Section>

        {/* OWNERSHIP */}
        <Section icon={Briefcase} title="Ownership">
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              data-testid="button-edit-owner-individual"
              onClick={() => setOwnershipType("individual")}
              className={`p-4 rounded-2xl border text-left transition flex items-center gap-2 font-bold ${
                ownershipType === "individual"
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card border-border text-foreground hover:bg-background"
              }`}
            >
              <Users size={18} /> Individual
            </button>
            <button
              type="button"
              data-testid="button-edit-owner-company"
              onClick={() => setOwnershipType("company")}
              className={`p-4 rounded-2xl border text-left transition flex items-center gap-2 font-bold ${
                ownershipType === "company"
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card border-border text-foreground hover:bg-background"
              }`}
            >
              <Briefcase size={18} /> Company
            </button>
          </div>

          {ownershipType === "company" && (
            <div className="space-y-2">
              <label className="text-xs font-semibold text-muted-foreground ml-1">
                Company Name
              </label>
              <input
                data-testid="input-edit-company"
                type="text"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="e.g. Olio Holdings Ltd"
                className={inputCls}
              />
            </div>
          )}

          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground ml-1">
              Title Deeds Status
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                data-testid="button-edit-title-issued"
                onClick={() => setTitleDeedsStatus("issued")}
                className={`p-4 rounded-2xl border text-left transition flex items-center gap-2 font-bold ${
                  titleDeedsStatus === "issued"
                    ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300"
                    : "bg-card border-border text-foreground hover:bg-background"
                }`}
              >
                <CheckCircle2 size={18} /> Issued
              </button>
              <button
                type="button"
                data-testid="button-edit-title-pending"
                onClick={() => setTitleDeedsStatus("pending")}
                className={`p-4 rounded-2xl border text-left transition flex items-center gap-2 font-bold ${
                  titleDeedsStatus === "pending"
                    ? "bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300"
                    : "bg-card border-border text-foreground hover:bg-background"
                }`}
              >
                <FileText size={18} /> Pending
              </button>
            </div>
          </div>
        </Section>
      </div>
    </ResponsiveDrawer>
  );
}
