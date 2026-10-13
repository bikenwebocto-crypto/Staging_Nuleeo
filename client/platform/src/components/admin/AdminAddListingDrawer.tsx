import { useEffect, useState } from "react";
import { Upload, X } from "lucide-react";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";
import { CountSelect } from "@ui/components/common/CountSelect";
import { useToast } from "@ui/hooks/use-toast";
import { uploadListingPhoto } from "@ui/lib/uploadListingPhoto";
import {
  useCreateMarketplaceListing,
  type MarketplaceListingStatus,
  type MarketplaceListingTag,
} from "@/lib/adminQueries";

interface AdminAddListingDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const STATUSES: MarketplaceListingStatus[] = ["active", "draft", "sold", "withdrawn"];
const TAGS: MarketplaceListingTag[] = ["Hot Deal", "New", "Featured", "Off-market"];

const emptyForm = {
  title: "",
  location: "",
  price: "",
  roi: "",
  beds: "",
  baths: "",
  sqm: "",
  image: "",
  tag: "" as MarketplaceListingTag | "",
  status: "active" as MarketplaceListingStatus,
  externalUrl: "",
};

type Form = typeof emptyForm;

const inputCls =
  "w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20";

export function AdminAddListingDrawer({ open, onOpenChange }: AdminAddListingDrawerProps) {
  const { toast } = useToast();
  const createListing = useCreateMarketplaceListing();
  const [form, setForm] = useState<Form>(emptyForm);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  // Revoke object URLs on swap/unmount so the browser releases the blob.
  useEffect(() => {
    return () => {
      if (photoPreview && photoPreview.startsWith("blob:")) {
        URL.revokeObjectURL(photoPreview);
      }
    };
  }, [photoPreview]);

  const close = () => {
    onOpenChange(false);
    setForm(emptyForm);
    if (photoPreview && photoPreview.startsWith("blob:")) {
      URL.revokeObjectURL(photoPreview);
    }
    setPhotoFile(null);
    setPhotoPreview(null);
    setIsUploading(false);
  };

  const handlePhotoPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (photoPreview && photoPreview.startsWith("blob:")) {
      URL.revokeObjectURL(photoPreview);
    }
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
    // Clear the URL field — file takes precedence on submit.
    setForm((f) => ({ ...f, image: "" }));
  };

  const clearPhoto = () => {
    if (photoPreview && photoPreview.startsWith("blob:")) {
      URL.revokeObjectURL(photoPreview);
    }
    setPhotoFile(null);
    setPhotoPreview(null);
  };

  const handleSave = async () => {
    if (!form.title.trim()) {
      toast({ title: "Title is required", variant: "destructive" });
      return;
    }
    if (!form.location.trim()) {
      toast({ title: "Location is required", variant: "destructive" });
      return;
    }
    const priceNum = Number(form.price);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      toast({ title: "Price must be a non-negative number", variant: "destructive" });
      return;
    }

    const numOrUndef = (s: string) => {
      const n = Number(s);
      return s.trim() === "" || !Number.isFinite(n) ? undefined : n;
    };

    let imageUrl = form.image.trim() || undefined;
    if (photoFile) {
      setIsUploading(true);
      try {
        imageUrl = await uploadListingPhoto(photoFile);
      } catch (err: any) {
        setIsUploading(false);
        toast({
          title: "Photo upload failed",
          description: err?.message ?? "Could not upload photo.",
          variant: "destructive",
        });
        return;
      }
      setIsUploading(false);
    }

    createListing.mutate(
      {
        title: form.title.trim(),
        location: form.location.trim(),
        price: priceNum,
        roi: numOrUndef(form.roi),
        beds: numOrUndef(form.beds),
        baths: numOrUndef(form.baths),
        sqm: numOrUndef(form.sqm),
        image: imageUrl,
        tag: form.tag || undefined,
        status: form.status,
        externalUrl: form.externalUrl.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast({ title: "Listing created" });
          close();
        },
        onError: (err: any) =>
          toast({ title: "Create failed", description: err?.message, variant: "destructive" }),
      },
    );
  };

  return (
    <ResponsiveDrawer
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      title="New Listing"
      subtitle="Add a property to the marketplace"
      footer={
        <div className="flex justify-end gap-2">
          <button
            onClick={close}
            className="px-4 py-2 rounded-lg text-sm text-muted-foreground hover:bg-muted transition"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={createListing.isPending || isUploading}
            className="px-4 py-2 rounded-lg bg-foreground text-background text-sm font-semibold hover:opacity-90 transition disabled:opacity-60"
          >
            {isUploading ? "Uploading photo…" : createListing.isPending ? "Saving…" : "Create"}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Title" required>
          <input
            type="text"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            className={inputCls}
          />
        </Field>
        <Field label="Location" required>
          <input
            type="text"
            value={form.location}
            placeholder="Limassol, Cyprus"
            onChange={(e) => setForm({ ...form, location: e.target.value })}
            className={inputCls}
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Price (€)" required>
            <input
              type="number"
              min="0"
              value={form.price}
              onChange={(e) => setForm({ ...form, price: e.target.value })}
              className={inputCls}
            />
          </Field>
          <Field label="ROI (%)">
            <input
              type="number"
              step="0.1"
              value={form.roi}
              onChange={(e) => setForm({ ...form, roi: e.target.value })}
              className={inputCls}
            />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <Field label="Beds">
            <CountSelect
              value={form.beds}
              onChange={(v) => setForm({ ...form, beds: v })}
              className="w-full appearance-none bg-background border border-input rounded-lg pl-3 pr-9 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </Field>
          <Field label="Baths">
            <CountSelect
              value={form.baths}
              onChange={(v) => setForm({ ...form, baths: v })}
              className="w-full appearance-none bg-background border border-input rounded-lg pl-3 pr-9 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </Field>
          <Field label="m²">
            <input
              type="number"
              min="0"
              value={form.sqm}
              onChange={(e) => setForm({ ...form, sqm: e.target.value })}
              className={inputCls}
            />
          </Field>
        </div>
        <Field label="Photo">
          {photoPreview ? (
            <div className="relative">
              <img
                src={photoPreview}
                alt="Preview"
                className="w-full h-40 object-cover rounded-lg border border-border"
              />
              <button
                type="button"
                onClick={clearPhoto}
                className="absolute top-2 right-2 p-1 rounded-full bg-background/80 backdrop-blur border border-border text-muted-foreground hover:text-foreground"
                aria-label="Remove photo"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <label className="flex flex-col items-center justify-center gap-2 p-6 border-2 border-dashed border-border rounded-xl cursor-pointer hover:border-primary/30 hover:bg-muted/50 transition">
              <Upload size={22} className="text-muted-foreground" />
              <span className="text-xs text-muted-foreground">
                Click to upload (JPEG, PNG, or WebP — up to 8 MB)
              </span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={handlePhotoPick}
                className="hidden"
              />
            </label>
          )}
        </Field>
        <Field label="…or Image URL">
          <input
            type="url"
            value={form.image}
            placeholder="https://… or /assets/…"
            onChange={(e) => setForm({ ...form, image: e.target.value })}
            disabled={!!photoFile}
            className={inputCls + (photoFile ? " opacity-50 cursor-not-allowed" : "")}
          />
        </Field>
        <Field label="External URL">
          <input
            type="url"
            value={form.externalUrl}
            placeholder="Optional broker / docs link"
            onChange={(e) => setForm({ ...form, externalUrl: e.target.value })}
            className={inputCls}
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Tag">
            <select
              value={form.tag}
              onChange={(e) => setForm({ ...form, tag: e.target.value as Form["tag"] })}
              className={inputCls}
            >
              <option value="">No tag</option>
              {TAGS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select
              value={form.status}
              onChange={(e) =>
                setForm({ ...form, status: e.target.value as MarketplaceListingStatus })
              }
              className={inputCls}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s} className="capitalize">
                  {s}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
    </ResponsiveDrawer>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-foreground mb-1">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}
