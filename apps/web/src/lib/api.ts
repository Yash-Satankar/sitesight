import type {
  AgentStep,
  BoqItem,
  BoqItemInput,
  CreateProjectBody,
  CreateZoneBody,
  ParsedBoqResponse,
  PatchAssessmentBody,
  Photo,
  PresignResponse,
  Project,
  ProjectDetail,
  ProjectListItem,
  ReportResponse,
  VisitDetail,
  VisitStatus,
  VisitSummary,
  Zone,
} from "@sitesight/shared";

const CONFIGURED = (import.meta.env.VITE_API_URL as string | undefined)?.trim() || undefined;
const POINTS_AT_LOCALHOST = CONFIGURED ? /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(CONFIGURED) : false;

/**
 * Dev: "/api", proxied to the API by Vite, so the app works from a phone on the LAN and over HTTPS
 * (a localhost VITE_API_URL would point the phone at itself). Production: VITE_API_URL (e.g. the Railway API).
 */
export const API_URL = CONFIGURED && !(import.meta.env.DEV && POINTS_AT_LOCALHOST) ? CONFIGURED : import.meta.env.DEV ? "/api" : (CONFIGURED ?? "/api");

/** URLs the API returns may be relative to the API (local storage mode: "/storage/…"); make them usable. */
export function apiUrl(url: string): string {
  return url.startsWith("/") ? `${API_URL}${url}` : url;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const isForm = init.body instanceof FormData;
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: isForm ? init.headers : { "Content-Type": "application/json", ...init.headers },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  listProjects: () => request<ProjectListItem[]>("/projects"),
  createProject: (body: CreateProjectBody) => post<Project>("/projects", body),
  getProject: (id: number) => request<ProjectDetail>(`/projects/${id}`),

  parseBoq: (projectId: number, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<ParsedBoqResponse>(`/projects/${projectId}/boq`, { method: "POST", body: form });
  },
  saveBoq: (projectId: number, items: BoqItemInput[]) =>
    request<BoqItem[]>(`/projects/${projectId}/boq`, { method: "PUT", body: JSON.stringify({ items }) }),

  createZone: (projectId: number, body: CreateZoneBody) => post<Zone>(`/projects/${projectId}/zones`, body),
  createVisit: (projectId: number) => post<VisitSummary>(`/projects/${projectId}/visits`, {}),

  getVisit: (id: number) => request<VisitDetail>(`/visits/${id}`),
  runVisit: (id: number) => post<{ status: VisitStatus }>(`/visits/${id}/run`),

  registerPhoto: (visitId: number, body: { zoneId: number; storageKey: string; voiceNoteKey?: string; askBackId?: number }) =>
    post<Photo>(`/visits/${visitId}/photos`, body),
  fulfilAskBack: (id: number, photoId: number) => post<{ resumed: boolean }>(`/ask-backs/${id}/fulfil`, { photoId }),
  skipAskBack: (id: number) => post<{ resumed: boolean }>(`/ask-backs/${id}/skip`),

  patchAssessment: (id: number, body: PatchAssessmentBody) =>
    request<unknown>(`/assessments/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  createReport: (visitId: number) => post<ReportResponse>(`/visits/${visitId}/report`),
};

/** Presign → PUT directly to R2 → return the storage key. */
export async function uploadFile(visitId: number, blob: Blob, kind: "photo" | "voice"): Promise<string> {
  const contentType = blob.type || (kind === "photo" ? "image/jpeg" : "audio/webm");
  const { uploadUrl, storageKey } = await post<PresignResponse>(`/visits/${visitId}/photos/presign`, {
    contentType,
    kind,
  });
  const res = await fetch(apiUrl(uploadUrl), { method: "PUT", body: blob, headers: { "Content-Type": contentType } });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
  return storageKey;
}

/** Subscribe to the live agent trace. Returns an unsubscribe function. */
export function subscribeTrace(
  visitId: number,
  handlers: { onStep: (s: AgentStep) => void; onStatus: (s: VisitStatus) => void; onCost?: (usd: number) => void },
): () => void {
  const es = new EventSource(`${API_URL}/visits/${visitId}/trace`);
  es.addEventListener("step", (e) => handlers.onStep(JSON.parse((e as MessageEvent).data)));
  es.addEventListener("status", (e) => handlers.onStatus(JSON.parse((e as MessageEvent).data).status));
  es.addEventListener("cost", (e) => handlers.onCost?.(JSON.parse((e as MessageEvent).data).costUsd));
  return () => es.close();
}
