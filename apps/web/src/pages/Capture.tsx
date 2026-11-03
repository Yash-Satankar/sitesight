import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Camera, Check, ImagePlus, Mic, Play, Trash2, Upload } from "lucide-react";
import { VOICE_MAX_SECONDS } from "@sitesight/shared";
import { api, apiUrl, uploadFile } from "../lib/api";
import { toVoiceWav } from "../lib/wav";
import { useAsync } from "../lib/useAsync";
import { ErrorNote } from "../components/Layout";
import { AskBackCard } from "../components/AskBackCard";
import { BottomBar, BottomBarSpacer, TopBar, fmtDate } from "../components/ui";

/** Mobile-first capture: pick zone → camera → optional hold-to-record voice note → next. */
export function CapturePage() {
  const visitId = Number(useParams().visitId);
  const [params] = useSearchParams();
  const askBackId = params.get("askBack") ? Number(params.get("askBack")) : undefined;
  const navigate = useNavigate();

  const { data, reload } = useAsync(async () => {
    const visit = await api.getVisit(visitId);
    const project = await api.getProject(visit.projectId);
    return { visit, project };
  }, [visitId]);

  const [zoneId, setZoneId] = useState<number | null>(params.get("zone") ? Number(params.get("zone")) : null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [voice, setVoice] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (zoneId == null && data?.project.zones[0]) setZoneId(data.project.zones[0].id);
  }, [data, zoneId]);

  // The request may be this visit's or still open from an earlier visit; a photo taken here answers either.
  const earlierAskBack = data?.visit.earlierOpenAskBacks.find((a) => a.id === askBackId);
  const askBack = data?.visit.askBacks.find((a) => a.id === askBackId) ?? earlierAskBack;

  async function submit() {
    if (!photo || zoneId == null) return;
    setBusy(true);
    setError(null);
    try {
      const storageKey = await uploadFile(visitId, photo, "photo");
      const voiceNoteKey = voice ? await uploadFile(visitId, voice, "voice") : undefined;
      const registered = await api.registerPhoto(visitId, { zoneId, storageKey, voiceNoteKey, askBackId });
      if (askBackId) {
        await api.fulfilAskBack(askBackId, registered.id);
        navigate(`/visits/${visitId}`);
        return;
      }
      setPhoto(null);
      await reload(); // the strip shows the new photo's real thumbnail
      setVoice(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function finishAndRun() {
    try {
      await api.runVisit(visitId);
      navigate(`/visits/${visitId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const existing = data?.visit.photos.length ?? 0;
  const zones = data?.project.zones ?? [];
  const zoneName = (id: number) => zones.find((z) => z.id === id)?.name;
  const itemCode = (id: number | null) => (id == null ? undefined : data?.project.boqItems.find((b) => b.id === id)?.code);
  const openRequests = askBack
    ? []
    : [...(data?.visit.askBacks.filter((a) => a.status === "open") ?? []), ...(data?.visit.earlierOpenAskBacks ?? [])];
  const preview = usePreviewUrl(photo);

  return (
    <div className="mx-auto max-w-md">
      <TopBar
        back={`/visits/${visitId}`}
        title={askBack ? "Requested photo" : "Take photos"}
        subtitle={data ? `${data.project.name} · ${fmtDate(data.visit.visitDate)}` : undefined}
      />
      <div className="space-y-5">
        {askBack && (
          <AskBackCard
            askBack={askBack}
            zoneName={zoneName(askBack.zoneId)}
            itemCode={itemCode(askBack.boqItemId)}
            fromVisitDate={earlierAskBack?.visitDate}
            showAction={false}
          />
        )}
        {openRequests.map((a) => (
          <AskBackCard
            key={a.id}
            askBack={a}
            zoneName={zoneName(a.zoneId)}
            itemCode={itemCode(a.boqItemId)}
            captureVisitId={visitId}
            fromVisitDate={(a as { visitDate?: string }).visitDate}
          />
        ))}

        <section>
          <h2 className="eyebrow mb-2">Zone</h2>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Zone">
            {zones.map((z) => {
              const on = z.id === zoneId;
              return (
                <button
                  key={z.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={!!askBack && !on}
                  onClick={() => setZoneId(z.id)}
                  className={`inline-flex min-h-12 items-center gap-1.5 rounded-full border-2 px-4 text-base font-semibold transition-colors ${
                    on ? "border-accent bg-accent text-white" : "border-slate-300 bg-white text-slate-800 hover:border-slate-400 disabled:opacity-40"
                  }`}
                >
                  {on && <Check className="h-4 w-4" aria-hidden />}
                  {z.name}
                </button>
              );
            })}
          </div>
        </section>

        <label className="relative flex aspect-[4/3] w-full cursor-pointer flex-col items-center justify-center gap-3 overflow-hidden rounded-2xl border-2 border-dashed border-accent/50 bg-accent-soft text-accent-strong active:bg-teal-100">
          {preview ? (
            <>
              <img src={preview} alt="Photo to upload" className="absolute inset-0 h-full w-full object-cover" />
              <span className="absolute right-3 bottom-3 inline-flex min-h-10 items-center gap-1.5 rounded-full bg-black/70 px-3 text-sm font-semibold text-white">
                <Camera className="h-4 w-4" aria-hidden /> Retake
              </span>
            </>
          ) : (
            <>
              <span className="flex h-20 w-20 items-center justify-center rounded-full bg-accent text-white shadow-md">
                <Camera className="h-10 w-10" aria-hidden />
              </span>
              <span className="text-lg font-bold">Take a photo</span>
              <span className="text-sm text-slate-700">{zoneId != null ? zoneName(zoneId) : "Pick a zone first"}</span>
            </>
          )}
          <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
        </label>

        <VoiceRecorder value={voice} onChange={setVoice} />
        <ErrorNote error={error} />

        {!askBack && (
          <section>
            <h2 className="eyebrow mb-2">
              In this visit · <span className="num">{existing}</span> photo{existing === 1 ? "" : "s"}
            </h2>
            {existing > 0 ? (
              <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
                {data?.visit.photos.map((p) => (
                  <img
                    key={p.id}
                    src={p.url ? apiUrl(p.url) : undefined}
                    alt=""
                    loading="lazy"
                    className="h-20 w-20 shrink-0 rounded-xl bg-slate-200 object-cover"
                  />
                ))}
              </div>
            ) : (
              <p className="flex items-center gap-2 text-sm text-slate-600">
                <ImagePlus className="h-4 w-4" aria-hidden /> No photos yet.
              </p>
            )}
            <Link to={`/visits/${visitId}`} className="mt-2 inline-flex min-h-12 items-center text-sm font-semibold text-accent">
              Open the visit without running the agent
            </Link>
          </section>
        )}

        <BottomBarSpacer />
        <BottomBar>
          {askBack ? (
            <button className="btn flex-1" disabled={!photo || zoneId == null || busy} onClick={submit}>
              <Upload className="h-5 w-5" aria-hidden /> {busy ? "Uploading…" : "Upload and resume agent"}
            </button>
          ) : photo ? (
            <button className="btn flex-1" disabled={zoneId == null || busy} onClick={submit}>
              <Upload className="h-5 w-5" aria-hidden /> {busy ? "Uploading…" : "Upload & take next"}
            </button>
          ) : (
            <button className="btn flex-1" disabled={existing === 0} onClick={finishAndRun}>
              <Play className="h-5 w-5" aria-hidden /> Done · run agent on {existing} photo{existing === 1 ? "" : "s"}
            </button>
          )}
        </BottomBar>
      </div>
    </div>
  );
}

/** Object URL for the chosen photo, revoked when it changes. */
function usePreviewUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url;
}

function VoiceRecorder({ value, onChange }: { value: Blob | null; onChange: (b: Blob | null) => void }) {
  const recorder = useRef<MediaRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);

  const [hitLimit, setHitLimit] = useState(false);

  useEffect(() => {
    if (!recording) return;
    setSeconds(0);
    setHitLimit(false);
    const started = Date.now();
    const t = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      setSeconds(Math.min(s, VOICE_MAX_SECONDS));
      // Auto-stop at the limit: Meta's push-to-talk transcription and our 4 MB upload cap.
      if (s >= VOICE_MAX_SECONDS) {
        setHitLimit(true);
        stop();
      }
    }, 250);
    return () => clearInterval(t);
  }, [recording]);

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const recording = new Blob(chunks, { type: rec.mimeType.split(";")[0] || "audio/webm" });
        // Meta's transcription takes 16 kHz mono WAV only: convert here (the server has no audio tools).
        try {
          onChange(await toVoiceWav(recording));
        } catch {
          onChange(null);
          alert("This browser couldn't prepare the voice note. Upload the photo without it, or try another browser.");
        }
      };
      rec.start();
      recorder.current = rec;
      setRecording(true);
    } catch {
      alert("Microphone not available");
    }
  }

  function stop() {
    recorder.current?.stop();
    recorder.current = null;
    setRecording(false);
  }

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const clock = `${fmt(seconds)} / ${fmt(VOICE_MAX_SECONDS)}`;
  const nearLimit = VOICE_MAX_SECONDS - seconds <= 10;

  return (
    <section className="space-y-2">
      <button
        type="button"
        className={`flex min-h-16 w-full touch-none items-center justify-center gap-3 rounded-2xl border-2 text-base font-bold select-none transition-colors ${
          recording ? "border-red-600 bg-red-600 text-white" : "border-slate-300 bg-white text-slate-900 active:bg-slate-100"
        }`}
        onPointerDown={start}
        onPointerUp={stop}
        onPointerLeave={() => recording && stop()}
        onContextMenu={(e) => e.preventDefault()}
      >
        <Mic className={`h-6 w-6 ${recording ? "animate-pulse" : ""}`} aria-hidden />
        {recording ? (
          <>
            <span className={`num ${nearLimit ? "rounded bg-white px-1.5 text-red-700" : ""}`}>{clock}</span> Recording · release to stop
          </>
        ) : (
          `Hold to add a voice note (up to ${VOICE_MAX_SECONDS} s)`
        )}
      </button>
      {recording && (
        <div className="h-1.5 overflow-hidden rounded-full bg-slate-200" aria-hidden>
          <div className="h-full bg-red-600 transition-[width] duration-200" style={{ width: `${(seconds / VOICE_MAX_SECONDS) * 100}%` }} />
        </div>
      )}
      {hitLimit && !recording && (
        <p className="text-sm text-slate-600" role="status">
          Stopped at {VOICE_MAX_SECONDS} seconds, the voice note limit.
        </p>
      )}
      {value && !recording && (
        <div className="flex items-center gap-2">
          <audio controls src={URL.createObjectURL(value)} className="h-12 min-w-0 flex-1" />
          <button type="button" className="btn-ghost text-red-700" onClick={() => onChange(null)} aria-label="Delete voice note">
            <Trash2 className="h-5 w-5" />
          </button>
        </div>
      )}
    </section>
  );
}
