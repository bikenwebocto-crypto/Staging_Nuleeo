import { useEffect, useState } from "react";
import {
  Upload,
  Building2,
  Home,
  Store,
  Map,
  Mountain,
  Euro,
  Ruler,
  Zap,
  Users,
  CheckCircle2,
  X,
} from "lucide-react";
import { useToast } from "@ui/hooks/use-toast";
import { parseApiError } from "@ui/lib/queryClient";
import { usePrivileges } from "@ui/lib/usePrivileges";
import { useAuth } from "@ui/lib/useAuth";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";
import { YearSelect } from "@ui/components/common/YearSelect";
import { CountSelect } from "@ui/components/common/CountSelect";
import { AddressAutocomplete } from "@ui/components/common/AddressAutocomplete";
import {
  uploadPropertyPhoto,
  ALLOWED_PROPERTY_PHOTO_TYPES,
  MAX_PROPERTY_PHOTO_BYTES,
} from "@ui/lib/uploadPropertyPhoto";
import { useAdminUsers, useCreateUnit } from "@/lib/adminQueries";

interface AdminAddUnitDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const propertyTypes = [
  { id: "Apartment", icon: Building2, label: "Apartment" },
  { id: "House", icon: Home, label: "House" },
  { id: "Villa", icon: Mountain, label: "Villa" },
  { id: "Commercial", icon: Store, label: "Commercial" },
  { id: "Plot", icon: Map, label: "Plot" },
];

// Datalist suggestions; the field is free-text so admins can type any country.
const COUNTRY_SUGGESTIONS = [
  "Cyprus",
  "Greece",
  "Ireland",
  "United Kingdom",
  "Germany",
  "France",
  "Spain",
  "Italy",
  "Portugal",
  "Netherlands",
  "Belgium",
  "Switzerland",
  "Austria",
  "Sweden",
  "Norway",
  "Denmark",
  "Finland",
  "Poland",
  "Czech Republic",
  "Hungary",
  "Romania",
  "Bulgaria",
  "Croatia",
  "Slovenia",
  "Malta",
  "Luxembourg",
  "United States",
  "Canada",
  "Australia",
  "UAE",
];

export function AdminAddUnitDrawer({ open, onOpenChange }: AdminAddUnitDrawerProps) {
  const { toast } = useToast();
  const { canPlatform } = usePrivileges();
  const { profile } = useAuth();
  // Server rejects financial fields on POST when the caller lacks
  // finance.viewAll (mirrors PATCH); hide the inputs to match.
  const canSeeFinancials = canPlatform("finance.viewAll");
  // Only a superadmin may override the owner's plan unit cap (the server
  // re-checks this regardless of the flag we send).
  const isSuperadmin = Boolean(profile?.roles?.includes("superadmin"));
  const [step, setStep] = useState(1);
  const totalSteps = 3;

  // Step 1: Basic Info
  const [propertyType, setPropertyType] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [country, setCountry] = useState("Cyprus");
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);

  // Step 2: Details
  const [sqm, setSqm] = useState("");
  const [bedrooms, setBedrooms] = useState("");
  const [bathrooms, setBathrooms] = useState("");
  const [builtYear, setBuiltYear] = useState("");
  const [energyClass, setEnergyClass] = useState("");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  // Step 3: Financials & Assignment
  const [estimatedValue, setEstimatedValue] = useState("");
  const [acquisitionPrice, setAcquisitionPrice] = useState("");
  const [overrideCap, setOverrideCap] = useState(false);
  const [ownerSearch, setOwnerSearch] = useState("");
  const [selectedOwner, setSelectedOwner] = useState<{
    id: string;
    name: string;
    email: string;
  } | null>(null);

  const { data: allUsers = [] } = useAdminUsers();
  const createUnit = useCreateUnit();
  const ownerCandidates = allUsers.filter((u) => u.rawRoles.includes("owner"));
  const filteredOwners =
    ownerSearch.length >= 2 && !selectedOwner
      ? ownerCandidates
          .filter(
            (u) =>
              u.name.toLowerCase().includes(ownerSearch.toLowerCase()) ||
              u.email.toLowerCase().includes(ownerSearch.toLowerCase()),
          )
          .slice(0, 5)
      : [];

  const resetForm = () => {
    setStep(1);
    setPropertyType("");
    setAddress("");
    setCity("");
    setPostalCode("");
    setCountry("Cyprus");
    setLat(null);
    setLng(null);
    setSqm("");
    setBedrooms("");
    setBathrooms("");
    setBuiltYear("");
    setEnergyClass("");
    setPhotoFile(null);
    setPhotoPreview(null);
    setIsUploading(false);
    setEstimatedValue("");
    setAcquisitionPrice("");
    setOverrideCap(false);
    setOwnerSearch("");
    setSelectedOwner(null);
  };

  // Revoke object URLs on swap/unmount so the browser releases the blob.
  useEffect(() => {
    return () => {
      if (photoPreview && photoPreview.startsWith("blob:")) {
        URL.revokeObjectURL(photoPreview);
      }
    };
  }, [photoPreview]);

  const handleClose = (val: boolean) => {
    onOpenChange(val);
    if (!val) setTimeout(resetForm, 300);
  };

  const handleSubmit = async () => {
    if (!selectedOwner) {
      toast({
        title: "Owner required",
        description: "Pick the owner this unit belongs to before submitting.",
        variant: "destructive",
      });
      return;
    }
    try {
      let imageUrl: string | undefined;
      if (photoFile) {
        setIsUploading(true);
        try {
          imageUrl = await uploadPropertyPhoto(photoFile);
        } catch (err) {
          setIsUploading(false);
          toast({
            title: "Photo upload failed",
            description: parseApiError(err, "Could not upload photo."),
            variant: "destructive",
          });
          return;
        }
        setIsUploading(false);
      }

      const bedroomsNum = bedrooms ? Number(bedrooms) : undefined;
      const bathsNum = bathrooms ? Number(bathrooms) : undefined;

      await createUnit.mutateAsync({
        ownerId: selectedOwner.id,
        address: address.trim(),
        propertyType: propertyType || undefined,
        city: city || undefined,
        postalCode: postalCode || undefined,
        country: country || undefined,
        lat: lat ?? undefined,
        lng: lng ?? undefined,
        sqm: sqm || undefined,
        bedrooms: Number.isFinite(bedroomsNum) ? bedroomsNum : undefined,
        baths: Number.isFinite(bathsNum) ? bathsNum : undefined,
        builtYear: builtYear || undefined,
        energyClass: energyClass || undefined,
        image: imageUrl,
        propertyValue: estimatedValue ? Number(estimatedValue) : undefined,
        acquisitionPrice: acquisitionPrice ? Number(acquisitionPrice) : undefined,
        overrideCap: overrideCap || undefined,
      });
      toast({
        title: "Unit registered",
        description: `${propertyType || "Property"} at ${address || "new address"} assigned to ${selectedOwner.name}.`,
      });
      handleClose(false);
    } catch (err) {
      toast({
        title: "Failed to create unit",
        description: parseApiError(err, "Failed to create unit"),
        variant: "destructive",
      });
    }
  };

  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Validate at selection (type + 8 MB), mirroring uploadPropertyPhoto, so a
    // bad file is caught here rather than on the upload round-trip.
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
  };

  const canProceed = () => {
    if (step === 1) return propertyType && address;
    return true;
  };

  const inputClass =
    "w-full bg-background border border-input rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition";
  const labelClass = "block text-xs font-semibold text-muted-foreground ml-1 mb-1.5";

  const footerContent = (
    <div className="flex gap-3">
      {step > 1 ? (
        <button
          onClick={() => setStep(step - 1)}
          className="flex-1 px-4 py-2.5 border border-border rounded-lg text-sm font-medium hover:bg-muted transition"
        >
          Back
        </button>
      ) : (
        <button
          onClick={() => handleClose(false)}
          className="flex-1 px-4 py-2.5 border border-border rounded-lg text-sm font-medium hover:bg-muted transition"
        >
          Cancel
        </button>
      )}

      {step < totalSteps ? (
        <button
          onClick={() => setStep(step + 1)}
          disabled={!canProceed()}
          className="flex-1 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Continue
        </button>
      ) : (
        <button
          onClick={handleSubmit}
          disabled={!selectedOwner || createUnit.isPending || isUploading}
          className="flex-1 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <CheckCircle2 size={16} />
          {isUploading
            ? "Uploading photo…"
            : createUnit.isPending
              ? "Registering…"
              : "Register Unit"}
        </button>
      )}
    </div>
  );

  return (
    <ResponsiveDrawer
      open={open}
      onOpenChange={handleClose}
      title="Register New Unit"
      subtitle={`Step ${step} of ${totalSteps}`}
      footer={footerContent}
    >
      {/* Progress Bar */}
      <div className="mb-5">
        <div className="flex gap-1.5">
          {Array.from({ length: totalSteps }).map((_, i) => (
            <div
              key={i}
              className={`h-1 flex-1 rounded-full transition-all duration-300 ${
                i < step ? "bg-primary" : "bg-muted"
              }`}
            />
          ))}
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          {step === 1 && "Property type & location"}
          {step === 2 && "Property details & photo"}
          {step === 3 && "Financials & owner assignment"}
        </p>
      </div>

      {/* Step 1: Type & Location */}
      {step === 1 && (
        <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-200">
          <div>
            <label className={labelClass}>Property Type</label>
            <div className="grid grid-cols-3 gap-2">
              {propertyTypes.map((type) => (
                <button
                  key={type.id}
                  onClick={() => setPropertyType(type.id)}
                  className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all ${
                    propertyType === type.id
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/30"
                  }`}
                >
                  <type.icon
                    size={22}
                    className={propertyType === type.id ? "text-primary" : "text-muted-foreground"}
                  />
                  <span
                    className={`text-xs font-medium ${propertyType === type.id ? "text-primary" : "text-muted-foreground"}`}
                  >
                    {type.label}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className={labelClass}>Street Address</label>
            <AddressAutocomplete
              testId="input-admin-unit-address"
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
              placeholder="e.g. 42 Makarios Ave, Apt 3B"
            />
            {lat !== null && lng !== null && (
              <p className="text-[11px] text-muted-foreground ml-1 mt-1">
                Pinned at {lat.toFixed(5)}, {lng.toFixed(5)}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>City</label>
              <input
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="e.g. Limassol"
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Postal Code</label>
              <input
                type="text"
                value={postalCode}
                onChange={(e) => setPostalCode(e.target.value)}
                placeholder="e.g. 3025"
                className={inputClass}
              />
            </div>
          </div>

          <div>
            <label className={labelClass}>Country</label>
            <input
              type="text"
              list="unit-country-options"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              placeholder="Start typing…"
              className={inputClass}
            />
            <datalist id="unit-country-options">
              {COUNTRY_SUGGESTIONS.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
        </div>
      )}

      {/* Step 2: Details & Photo */}
      {step === 2 && (
        <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-200">
          <div>
            <label className={labelClass}>Property Photo</label>
            <label className="flex flex-col items-center justify-center gap-2 p-6 border-2 border-dashed border-border rounded-xl cursor-pointer hover:border-primary/30 hover:bg-muted/50 transition">
              {photoPreview ? (
                <img
                  src={photoPreview}
                  alt="Preview"
                  className="w-full h-32 object-cover rounded-lg"
                />
              ) : (
                <>
                  <Upload size={24} className="text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Click to upload photo</span>
                </>
              )}
              <input type="file" accept="image/*" onChange={handlePhotoUpload} className="hidden" />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Size (m²)</label>
              <div className="relative">
                <Ruler
                  size={15}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <input
                  type="number"
                  value={sqm}
                  onChange={(e) => setSqm(e.target.value)}
                  placeholder="e.g. 85"
                  className={`${inputClass} pl-9`}
                />
              </div>
            </div>
            <div>
              <label className={labelClass}>Year Built</label>
              <YearSelect
                value={builtYear}
                onChange={setBuiltYear}
                min={1800}
                max={new Date().getFullYear() + 5}
                className="w-full appearance-none bg-background border border-input rounded-lg pr-9 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Bedrooms</label>
              <CountSelect
                value={bedrooms}
                onChange={setBedrooms}
                className="w-full appearance-none bg-background border border-input rounded-lg pl-3 pr-9 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
              />
            </div>
            <div>
              <label className={labelClass}>Bathrooms</label>
              <CountSelect
                value={bathrooms}
                onChange={setBathrooms}
                className="w-full appearance-none bg-background border border-input rounded-lg pl-3 pr-9 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
              />
            </div>
          </div>

          <div>
            <label className={labelClass}>Energy Class</label>
            <div className="relative">
              <Zap
                size={15}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <select
                value={energyClass}
                onChange={(e) => setEnergyClass(e.target.value)}
                className={`${inputClass} pl-9`}
              >
                <option value="">Select...</option>
                <option value="A+">A+</option>
                <option value="A">A</option>
                <option value="B">B</option>
                <option value="C">C</option>
                <option value="D">D</option>
                <option value="E">E</option>
                <option value="F">F</option>
                <option value="G">G</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* Step 3: Financials & Assignment */}
      {step === 3 && (
        <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-200">
          {canSeeFinancials ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>Estimated Value (€)</label>
                  <div className="relative">
                    <Euro
                      size={15}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                    />
                    <input
                      type="number"
                      value={estimatedValue}
                      onChange={(e) => setEstimatedValue(e.target.value)}
                      placeholder="e.g. 250000"
                      className={`${inputClass} pl-9`}
                    />
                  </div>
                </div>
                <div>
                  <label className={labelClass}>Acquisition Price (€)</label>
                  <div className="relative">
                    <Euro
                      size={15}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                    />
                    <input
                      type="number"
                      value={acquisitionPrice}
                      onChange={(e) => setAcquisitionPrice(e.target.value)}
                      placeholder="e.g. 220000"
                      className={`${inputClass} pl-9`}
                    />
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="bg-muted/50 border border-border rounded-lg px-3 py-2 text-xs text-muted-foreground">
              Financial fields are hidden — ask an admin to grant the{" "}
              <span className="font-medium">finance.viewAll</span> privilege to set valuations.
            </div>
          )}

          <div className="border-t border-border pt-5">
            <div className="flex items-center gap-2 mb-3">
              <Users size={15} className="text-primary" />
              <span className="text-sm font-semibold text-foreground">Assign Owner</span>
              <span className="text-xs text-destructive">(required)</span>
            </div>
            <div className="relative">
              <label className={labelClass}>Owner</label>
              {selectedOwner ? (
                <div className="flex items-center justify-between w-full bg-background border border-input rounded-lg px-3 py-2.5 text-sm">
                  <div>
                    <span className="font-medium text-foreground">{selectedOwner.name}</span>
                    <span className="text-muted-foreground ml-2">{selectedOwner.email}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedOwner(null);
                      setOwnerSearch("");
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
                    value={ownerSearch}
                    onChange={(e) => setOwnerSearch(e.target.value)}
                    placeholder="Search by name or email..."
                    className={inputClass}
                  />
                  {filteredOwners.length > 0 && (
                    <div className="absolute bottom-full left-0 right-0 mb-1 bg-card border border-border rounded-lg shadow-lg z-20 overflow-hidden max-h-56 overflow-y-auto">
                      {filteredOwners.map((user) => (
                        <button
                          key={user.id}
                          type="button"
                          onClick={() => {
                            setSelectedOwner({ id: user.id, name: user.name, email: user.email });
                            setOwnerSearch(user.name);
                          }}
                          className="flex flex-col w-full px-3 py-2 text-left hover:bg-secondary transition-colors"
                        >
                          <span className="text-sm font-medium text-foreground">{user.name}</span>
                          <span className="text-xs text-muted-foreground">{user.email}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
              <p className="text-[11px] text-muted-foreground mt-1.5 ml-1">
                The unit will appear in the owner's portfolio on their next refresh.
              </p>
            </div>

            {isSuperadmin && (
              <label
                className="mt-3 flex items-start gap-2 text-xs text-muted-foreground cursor-pointer"
                data-testid="label-override-cap"
              >
                <input
                  type="checkbox"
                  checked={overrideCap}
                  onChange={(e) => setOverrideCap(e.target.checked)}
                  className="mt-0.5"
                  data-testid="checkbox-override-cap"
                />
                <span>
                  Override the owner&apos;s plan unit cap. Use only for deliberate exceptions — the
                  unit still counts toward their cap.
                </span>
              </label>
            )}
          </div>
        </div>
      )}
    </ResponsiveDrawer>
  );
}
