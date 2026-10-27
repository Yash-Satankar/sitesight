import { Link } from "react-router-dom";
import type { AskBack } from "@sitesight/shared";

export function AskBackCard({
  askBack,
  zoneName,
  onSkip,
}: {
  askBack: AskBack;
  zoneName: string | undefined;
  onSkip: () => void;
}) {
  return (
    <div className="card border-amber-300 bg-amber-50">
      <p className="text-xs font-medium uppercase text-amber-800">Photo requested · {zoneName ?? `zone ${askBack.zoneId}`}</p>
      <p className="mt-1 font-medium">{askBack.instruction}</p>
      <p className="mt-1 text-sm text-gray-600">Why: {askBack.reason}</p>
      <div className="mt-3 flex gap-2">
        <Link
          className="btn"
          to={`/visits/${askBack.visitId}/capture?zone=${askBack.zoneId}&askBack=${askBack.id}`}
        >
          📷 Take this photo
        </Link>
        <button className="btn-secondary" onClick={onSkip}>
          Skip
        </button>
      </div>
    </div>
  );
}
