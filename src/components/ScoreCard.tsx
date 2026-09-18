"use client";

import type { AnalysisResult } from "@/lib/types";

const BAND = (v: number) => (v >= 70 ? "var(--good)" : v >= 45 ? "var(--warn)" : "var(--bad)");
const VERDICT = (v: number) => (v >= 80 ? "Good" : v >= 65 ? "Decent" : v >= 45 ? "Mixed" : "Poor");

export default function ScoreCard({ result }: { result: AnalysisResult }) {
  const { scores } = result;

  return (
    <section className="card">
      <h2>Verdict</h2>
      <div className="headline">
        <span className="n" style={{ color: BAND(scores.overall) }}>{scores.overall}</span>
        <span className="of">out of 100<br />{VERDICT(scores.overall)}</span>
      </div>

      <div className="bars">
        {(
          [
            ["Light", scores.daylight],
            ["Stays cool", scores.afternoonHeat],
            ["Open view", scores.openness],
          ] as const
        ).map(([label, value]) => (
          <div className="bar" key={label}>
            <div className="row">
              <span>{label}</span>
              <b>{value}</b>
            </div>
            <div className="track">
              <div className="fill" style={{ width: `${value}%`, background: BAND(value) }} />
            </div>
          </div>
        ))}
      </div>

      <p className="hint" style={{ marginTop: 10 }}>Higher is better.</p>

      <div className="notes">
        <ul>
          {scores.notes.slice(0, 1).map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
