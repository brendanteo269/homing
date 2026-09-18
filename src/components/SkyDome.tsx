"use client";

import { compassName } from "@/lib/blockage";
import type { AnalysisResult } from "@/lib/types";

export default function SkyDome({ result }: { result: AnalysisResult }) {
  const W = 480;
  const H = 220;
  const PAD = 18;
  const facing = Math.round(result.viewpoint.facing);
  const samples = Array.from({ length: 37 }, (_, i) => {
    const bearing = Math.round((facing - 90 + i * 5 + 360) % 360);
    return Math.min(80, Math.max(0, result.horizon.elevation[bearing] ?? 0));
  });
  const skyline = samples
    .map((elevation, i) => {
      const x = PAD + (i / (samples.length - 1)) * (W - PAD * 2);
      const y = H - PAD - (elevation / 90) * (H - PAD * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <figure className="view-profile">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img"
        aria-label={`A front-on view of the skyline when facing ${compassName(facing)}`}>
        <rect x={PAD} y={PAD} width={W - PAD * 2} height={H - PAD * 2} fill="var(--sky-open)" />
        <path d={`${skyline} L${W - PAD} ${H - PAD} L${PAD} ${H - PAD} Z`} fill="var(--mass)" />
        <line x1={W / 2} y1={PAD} x2={W / 2} y2={H - PAD} stroke="var(--ink)" strokeDasharray="3 4" strokeOpacity="0.5" />
        <text x={PAD} y={H - 4} fontSize="11" fill="var(--faint)">left</text>
        <text x={W / 2} y={H - 4} fontSize="11" fill="var(--faint)" textAnchor="middle">straight ahead</text>
        <text x={W - PAD} y={H - 4} fontSize="11" fill="var(--faint)" textAnchor="end">right</text>
      </svg>
      <div className="legend">
        <span><i style={{ background: "var(--sky-open)", border: "1px solid var(--line-bright)" }} />sky you can see</span>
        <span><i style={{ background: "var(--mass)" }} />buildings in the way</span>
        <span>facing {compassName(facing)}</span>
      </div>
    </figure>
  );
}
