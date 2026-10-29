import { useState } from "react";
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
}: {
  photo: Photo | undefined;
  segmentIds?: number[];
  panelIds?: number[];
}) {
  const hasOverlay = segmentIds.length > 0 || panelIds.length > 0;
  const [showOverlay, setShowOverlay] = useState(true);
  if (!photo) return <div className="aspect-[4/3] rounded-lg bg-gray-100" />;
  const overlayOn = hasOverlay && showOverlay;
  const src = overlayOn ? overlayUrl(photo.id, segmentIds, panelIds) : photo.url ? apiUrl(photo.url) : undefined;

  return (
    <figure className="relative overflow-hidden rounded-lg bg-gray-100">
      {src ? (
        <button
          type="button"
          className="block w-full"
          onClick={() => hasOverlay && setShowOverlay((v) => !v)}
          aria-label={hasOverlay ? (overlayOn ? "Hide masks" : "Show masks") : `Photo ${photo.id}`}
        >
          <img src={src} alt={`Photo ${photo.id}`} className="h-auto w-full" loading="lazy" decoding="async" />
        </button>
      ) : (
        <div className="aspect-[4/3]" />
      )}
      <figcaption className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
        photo {photo.id}
        {hasOverlay ? (overlayOn ? " · masks on (tap to hide)" : " · masks off (tap to show)") : ""}
      </figcaption>
    </figure>
  );
}
