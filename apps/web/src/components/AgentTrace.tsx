import { useEffect, useRef } from "react";
import type { AgentStep } from "@sitesight/shared";

const KIND_STYLE: Record<AgentStep["kind"], string> = {
  model: "border-violet-300 bg-violet-50",
  tool_call: "border-blue-300 bg-blue-50",
  tool_result: "border-gray-200 bg-white",
  error: "border-red-400 bg-red-50 text-red-800",
};

export function AgentTrace({ steps }: { steps: AgentStep[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }), [steps.length]);

  if (!steps.length) return <p className="text-sm text-gray-500">Waiting for the agent…</p>;
  return (
    <ol className="space-y-2">
      {steps.map((s) => (
        <li key={s.id} className={`rounded-lg border-l-4 px-3 py-2 text-xs ${KIND_STYLE[s.kind]}`}>
          <div className="mb-1 flex items-center gap-2 font-medium">
            <span className="uppercase text-gray-500">{s.kind.replace("_", " ")}</span>
            {s.name && <code className="text-gray-900">{s.name}</code>}
            <span className="ml-auto text-gray-400">run {s.runId}</span>
          </div>
          <StepBody step={s} />
        </li>
      ))}
      <div ref={endRef} />
    </ol>
  );
}

function StepBody({ step }: { step: AgentStep }) {
  const p = step.payload as Record<string, unknown> | null;
  if (step.kind === "error" && p) {
    return <p className="font-medium">{String(p.message ?? "Run failed")}</p>;
  }
  if (step.kind === "model" && p) {
    const text = typeof p.text === "string" ? p.text : "";
    return text ? <p className="whitespace-pre-wrap text-gray-700">{text}</p> : <p className="text-gray-400">(tool calls only)</p>;
  }
  return (
    <details>
      <summary className="cursor-pointer text-gray-600">{summarise(step)}</summary>
      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all text-[11px] text-gray-700">
        {JSON.stringify(step.payload, null, 2)}
      </pre>
    </details>
  );
}

function summarise(step: AgentStep): string {
  const p = step.payload as Record<string, unknown> | unknown[] | null;
  if (!p) return "";
  if (Array.isArray(p)) return `${p.length} result${p.length === 1 ? "" : "s"}`;
  if ("error" in p) return `error: ${String(p.error)}`;
  return Object.keys(p).slice(0, 4).join(", ");
}
