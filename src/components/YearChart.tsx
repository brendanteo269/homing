"use client";

import type { SunMetrics } from "@/lib/types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A heatmap answers the useful question immediately: when in the year does
 * this wall get sun, and how much of it arrives when a room is already warm?
 * Bar heights made that comparison depend on reading an axis first.
 */
export default function YearChart({ sun }: { sun: SunMetrics }) {
  const max = Math.max(1, ...sun.monthlyFacadeHours);

  return (
    <figure className="sun-calendar">
      <figcaption className="heatmap-heading">
        <span>Month</span><span>Before 2pm</span><span>After 2pm</span>
      </figcaption>
      {sun.monthlyFacadeHours.map((hours, i) => {
        const afternoon = sun.monthlyAfternoonMinutes[i] / 60;
        const before = Math.max(0, hours - afternoon);
        return (
          <div className="heatmap-row" key={MONTHS[i]}>
            <span>{MONTHS[i]}</span>
            <SunCell hours={before} max={max} colour="var(--steel)" label={`${MONTHS[i]}, before 2pm`} />
            <SunCell hours={afternoon} max={max} colour="var(--sun)" label={`${MONTHS[i]}, after 2pm`} />
          </div>
        );
      })}
      <p className="heatmap-key">Darker means more direct sun, averaged across that month.</p>
    </figure>
  );
}

function SunCell({ hours, max, colour, label }: { hours: number; max: number; colour: string; label: string }) {
  const alpha = 0.12 + (hours / max) * 0.88;
  return (
    <span
      className="sun-cell"
      style={{ backgroundColor: `color-mix(in srgb, ${colour} ${Math.round(alpha * 100)}%, var(--panel))` }}
      aria-label={`${label}: ${hours.toFixed(1)} hours per day`}
      title={`${label}: ${hours.toFixed(1)} hours per day`}
    >
      {hours >= 0.05 ? `${hours.toFixed(1)}h` : "–"}
    </span>
  );
}
