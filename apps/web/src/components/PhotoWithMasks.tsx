import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { Photo } from "@sitesight/shared";
import { apiUrl } from "../lib/api";

/** Overlay image URL: the photo with the given kept masks and measured panels drawn server-side. */
export function overlayUrl(photoId: number, segmentIds: number[] = [], panelIds: number[] = [], max = 900): string {
  const q = new URLSearchParams({ max: String(max) });
  if (segmentIds.length) q.set("segments", segmentIds.join(","));
  if (panelIds.length) q.set("panel", panelIds.join(","));
  return apiUrl(`/photos/${photoId}/overlay?${q}`);
}

/**
 * An evidence photo with its kept masks and measured panels. Tap to toggle the overlay off/on.
 * Rejected segments are never drawn (the API hides them).
 */
export function PhotoWithMasks({
  photo,
  segmentIds = [],
  panelIds = [],
  label,
}: {
  photo: Photo | undefined;
  segmentIds?: number[];
  panelIds?: number[];
  /** e.g. "Photo 2"; defaults to the photo id. */
  label?: string;
}) {
  const hasOverlay = segmentIds.length > 0 || panelIds.length > 0;
  const [showOverlay, setShowOverlay] = useState(true);
  if (!photo) return <div className="aspect-[4/3] rounded-xl bg-slate-200" />;
  const overlayOn = hasOverlay && showOverlay;
  const src = overlayOn ? overlayUrl(photo.id, segmentIds, panelIds) : photo.url ? apiUrl(photo.url) : undefined;
  const name = label ?? `Photo #${photo.id}`;

  return (
    <figure className="relative overflow-hidden rounded-xl bg-slate-200">
      {src ? (
        <button
          type="button"
          className="block w-full"
          onClick={() => hasOverlay && setShowOverlay((v) => !v)}
          aria-label={hasOverlay ? (overlayOn ? "Hide masks" : "Show masks") : name}
          aria-pressed={hasOverlay ? overlayOn : undefined}
        >
          <img src={src} alt={name} className="mx-auto max-h-[62vh] w-full bg-slate-900 object-contain" loading="lazy" decoding="async" />
        </button>
      ) : (
        <div className="aspect-[4/3]" />
      )}
      <figcaption className="pointer-events-none absolute inset-x-2 bottom-2 flex items-center gap-2">
        <span className="rounded-full bg-black/70 px-2.5 py-1 text-xs font-semibold text-white">{name}</span>
        {hasOverlay && (
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-xs font-semibold text-white">
            {overlayOn ? <Eye className="h-3.5 w-3.5" aria-hidden /> : <EyeOff className="h-3.5 w-3.5" aria-hidden />}
            {overlayOn ? "Masks on · tap to hide" : "Masks off · tap to show"}
          </span>
        )}
      </figcaption>
    </figure>
  );
}
