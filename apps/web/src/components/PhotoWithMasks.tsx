import type { Photo } from "@sitesight/shared";
import { apiUrl } from "../lib/api";

/**
 * Shows a visit photo. Mask overlays are drawn server-side (overlay.ts) for the agent and the PDF;
 * TODO: add an API route that returns the overlay image so the review screen can show masks too.
 */
export function PhotoWithMasks({ photo, segmentIds = [] }: { photo: Photo | undefined; segmentIds?: number[] }) {
  if (!photo) return <div className="aspect-[4/3] rounded-lg bg-gray-100" />;
  return (
    <figure className="relative overflow-hidden rounded-lg bg-gray-100">
      {photo.url ? (
        <img src={apiUrl(photo.url)} alt={`Photo ${photo.id}`} className="h-auto w-full" loading="lazy" />
      ) : (
        <div className="aspect-[4/3]" />
      )}
      <figcaption className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
        photo {photo.id}
        {segmentIds.length ? ` · segments ${segmentIds.map((s) => `#${s}`).join(" ")}` : ""}
      </figcaption>
    </figure>
  );
}
