import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, uploadFile } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { ErrorNote } from "../components/Layout";

/** Mobile-first capture: pick zone → camera → optional hold-to-record voice note → next. */
export function CapturePage() {
  const visitId = Number(useParams().visitId);
  const [params] = useSearchParams();
  const askBackId = params.get("askBack") ? Number(params.get("askBack")) : undefined;
  const navigate = useNavigate();

  const { data } = useAsync(async () => {
    const visit = await api.getVisit(visitId);
    const project = await api.getProject(visit.projectId);
    return { visit, project };
  }, [visitId]);

  const [zoneId, setZoneId] = useState<number | null>(params.get("zone") ? Number(params.get("zone")) : null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [voice, setVoice] = useState<Blob | null>(null);
  const [uploaded, setUploaded] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (zoneId == null && data?.project.zones[0]) setZoneId(data.project.zones[0].id);
  }, [data, zoneId]);

  const askBack = data?.visit.askBacks.find((a) => a.id === askBackId);

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
      setUploaded((n) => n + 1);
      setPhoto(null);
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

  const existing = (data?.visit.photos.length ?? 0) + uploaded;

  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-xl font-semibold">{askBack ? "Requested photo" : "Capture"}</h1>
      {askBack && (
        <div className="card border-amber-300 bg-amber-50 text-sm">
          <p className="font-medium">{askBack.instruction}</p>
          <p className="text-gray-600">{askBack.reason}</p>
        </div>
      )}

      <label className="block text-sm">
        <span className="mb-1 block text-gray-600">Zone</span>
        <select className="input" value={zoneId ?? ""} onChange={(e) => setZoneId(Number(e.target.value))} disabled={!!askBack}>
          {data?.project.zones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.name}
            </option>
          ))}
        </select>
      </label>

      <label className="card flex aspect-[4/3] cursor-pointer flex-col items-center justify-center overflow-hidden p-0 text-gray-500">
        {photo ? (
          <img src={URL.createObjectURL(photo)} alt="Preview" className="h-full w-full object-cover" />
        ) : (
          <span>📷 Tap to take photo</span>
        )}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
        />
      </label>

      <VoiceRecorder value={voice} onChange={setVoice} />
      <ErrorNote error={error} />

      <button className="btn w-full py-3" disabled={!photo || zoneId == null || busy} onClick={submit}>
        {busy ? "Uploading…" : askBack ? "Upload and resume agent" : "Upload & next"}
      </button>

      {!askBack && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-500">{existing} photo(s) in this visit</span>
          <div className="flex gap-2">
            <Link className="btn-secondary" to={`/visits/${visitId}`}>
              View visit
            </Link>
            <button className="btn" disabled={existing === 0} onClick={finishAndRun}>
              Done → run agent
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function VoiceRecorder({ value, onChange }: { value: Blob | null; onChange: (b: Blob | null) => void }) {
  const recorder = useRef<MediaRecorder | null>(null);
  const [recording, setRecording] = useState(false);

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        onChange(new Blob(chunks, { type: rec.mimeType.split(";")[0] || "audio/webm" }));
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

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        className={recording ? "btn bg-red-600 hover:bg-red-700" : "btn-secondary"}
        onPointerDown={start}
        onPointerUp={stop}
        onPointerLeave={() => recording && stop()}
      >
        🎙 {recording ? "Recording… release to stop" : "Hold to record voice note"}
      </button>
      {value && !recording && (
        <>
          <audio controls src={URL.createObjectURL(value)} className="h-8 flex-1" />
          <button type="button" className="text-sm text-gray-500" onClick={() => onChange(null)}>
            ✕
          </button>
        </>
      )}
    </div>
  );
}
