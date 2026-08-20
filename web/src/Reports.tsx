import { useMemo, useState } from "react";
import { dayBoundsMs, localDayKey } from "./dateUtils";

type SummaryRow = {
  _id: string;
  receivedAt: number;
  species: string;
  speciesCommonName?: string;
  speciesStatus?: "pending" | "done" | "failed";
};

const DAYS_SHOWN = 14;
const TOP_SPECIES = 8;

function speciesLabel(r: SummaryRow): string {
  return r.speciesStatus === "done" && r.speciesCommonName ? r.speciesCommonName : r.species;
}

type DayBar = { key: string; label: string; count: number };

export default function Reports({ rows }: { rows: SummaryRow[] }) {
  const [hoveredDay, setHoveredDay] = useState<DayBar | null>(null);

  const dailyCounts = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const r of rows) {
      const key = localDayKey(r.receivedAt);
      byDay.set(key, (byDay.get(key) ?? 0) + 1);
    }
    const days: DayBar[] = [];
    const now = new Date();
    for (let i = DAYS_SHOWN - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const key = localDayKey(d.getTime());
      days.push({ key, label: String(d.getDate()), count: byDay.get(key) ?? 0 });
    }
    return days;
  }, [rows]);

  const speciesRanked = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const label = speciesLabel(r);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, TOP_SPECIES);
    const rest = sorted.slice(TOP_SPECIES).reduce((sum, [, c]) => sum + c, 0);
    if (rest > 0) top.push(["Other", rest]);
    return top;
  }, [rows]);

  const maxDaily = Math.max(1, ...dailyCounts.map((d) => d.count));
  const maxSpecies = Math.max(1, ...speciesRanked.map(([, c]) => c));

  if (rows.length === 0) return null;

  return (
    <section className="reports">
      <div className="reports-block">
        <h2>Sightings, last {DAYS_SHOWN} days</h2>
        <div className="bar-chart" onMouseLeave={() => setHoveredDay(null)}>
          {dailyCounts.map((d) => (
            <div
              key={d.key}
              className="bar-chart-col"
              onMouseEnter={() => setHoveredDay(d)}
            >
              <div
                className={`bar-chart-bar ${d.count === 0 ? "zero" : ""}`}
                style={{ height: `${Math.max((d.count / maxDaily) * 100, d.count > 0 ? 6 : 2)}%` }}
              />
              <span className="bar-chart-label">{d.label}</span>
            </div>
          ))}
        </div>
        <p className="reports-caption">
          {hoveredDay
            ? `${new Date(dayBoundsMs(hoveredDay.key).start).toLocaleDateString(undefined, { month: "short", day: "numeric" })} — ${hoveredDay.count} sighting${hoveredDay.count === 1 ? "" : "s"}`
            : "hover a bar for the day's count"}
        </p>
      </div>

      <div className="reports-block">
        <h2>Field census</h2>
        <ul className="census-list">
          {speciesRanked.map(([name, count]) => (
            <li key={name} className="census-row">
              <span className="census-name">{name}</span>
              <span className="census-bar-track">
                <span
                  className="census-bar-fill"
                  style={{ width: `${(count / maxSpecies) * 100}%` }}
                />
              </span>
              <span className="census-count">{count}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
