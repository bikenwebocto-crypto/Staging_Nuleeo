import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { cn } from "@ui/lib/utils";

// Leaflet ships its marker images as bundler-relative paths that 404 under
// Vite. Point the default pin at the same CDN assets the platform map uses
// (see SuperAdminDashboard) so the marker actually renders.
const markerIcon = L.icon({
  iconRetinaUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png",
  iconUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png",
  shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

// No point chosen yet → frame the whole island (the address search is
// Cyprus-only, default city Limassol).
const DEFAULT_CENTER: [number, number] = [35.0, 33.0];
const DEFAULT_ZOOM = 8;
// Street-level zoom once a precise point exists.
const PIN_ZOOM = 16;

export interface AddressMapPickerProps {
  lat: number | null;
  lng: number | null;
  onChange: (lat: number, lng: number) => void;
  className?: string;
  testId?: string;
  /** Map height classes (default "h-40 sm:h-52"). */
  heightClass?: string;
}

// Mirrors the app theme: the address drawer is usually dark, so a white basemap
// looks jarring. Track the <html> `dark` class and swap the CARTO tile set.
function useIsDark(): boolean {
  const [dark, setDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setDark(el.classList.contains("dark")));
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

interface PinLayerProps {
  lat: number | null;
  lng: number | null;
  onChange: (lat: number, lng: number) => void;
}

// Lives INSIDE <MapContainer> so it can reach the Leaflet map instance. Handles
// click-to-place, drag-to-fine-tune, and recentring when the coordinates change
// from the outside (e.g. the address autocomplete picked a result).
function PinLayer({ lat, lng, onChange }: PinLayerProps) {
  // Remembers the last coordinate WE pushed up. Lets the recenter effect below
  // distinguish an external change (address picked → fly there) from our own
  // click/drag (leave the map where the user put it, don't yank it back).
  const selfRef = useRef<string | null>(null);

  const commit = (la: number, ln: number) => {
    selfRef.current = `${la},${ln}`;
    onChange(la, ln);
  };

  const map = useMapEvents({
    click(e) {
      commit(e.latlng.lat, e.latlng.lng);
    },
  });

  // The drawer slides in on a transform, so Leaflet can measure the container as
  // 0×0 mid-animation and paint grey tiles. Re-measure once it's settled.
  useEffect(() => {
    const t = setTimeout(() => map.invalidateSize(), 200);
    return () => clearTimeout(t);
  }, [map]);

  useEffect(() => {
    if (lat === null || lng === null) return;
    const key = `${lat},${lng}`;
    if (selfRef.current === key) {
      selfRef.current = null;
      return; // our own click/drag — don't fight the user
    }
    map.setView([lat, lng], Math.max(map.getZoom(), PIN_ZOOM), { animate: true });
  }, [lat, lng, map]);

  if (lat === null || lng === null) return null;
  return (
    <Marker
      position={[lat, lng]}
      draggable
      icon={markerIcon}
      eventHandlers={{
        dragend(e) {
          const p = (e.target as L.Marker).getLatLng();
          commit(p.lat, p.lng);
        },
      }}
    />
  );
}

export function AddressMapPicker({
  lat,
  lng,
  onChange,
  className,
  testId = "map-property-location",
  heightClass = "h-40 sm:h-52",
}: AddressMapPickerProps) {
  const isDark = useIsDark();
  const point: [number, number] | null = lat !== null && lng !== null ? [lat, lng] : null;
  const tileUrl = isDark
    ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
    : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";

  return (
    <div className={cn("space-y-1.5", className)} data-testid={testId}>
      {/* `isolate` traps Leaflet's internal pane/control z-indexes (200–1000)
          inside this box. Without it they leak into the shared stacking context
          and paint over the address autocomplete dropdown that renders directly
          above the map (it sits at a modest z-50). */}
      <div className="isolate overflow-hidden rounded-xl border border-border">
        <MapContainer
          center={point ?? DEFAULT_CENTER}
          zoom={point ? PIN_ZOOM : DEFAULT_ZOOM}
          scrollWheelZoom={false}
          attributionControl={false}
          className={cn(heightClass, "w-full")}
        >
          <TileLayer
            url={tileUrl}
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
          />
          <PinLayer lat={lat} lng={lng} onChange={onChange} />
        </MapContainer>
      </div>
      <p className="text-[11px] text-muted-foreground ml-1">
        {point ? (
          <>
            Drag the pin or tap the map to fine-tune · {point[0].toFixed(5)}, {point[1].toFixed(5)}
          </>
        ) : (
          <>Search an address above, or tap the map to drop a pin.</>
        )}
      </p>
    </div>
  );
}
