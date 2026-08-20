import { useMemo, useState } from "react";
import { localDayKey } from "./dateUtils";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

function monthLabel(cursor: Date): string {
  return cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

// Fixed intensity steps rather than a continuous scale — keeps the tint
// legible without needing per-cell contrast math (sequential, single hue).
function intensityStep(count: number, maxInMonth: number): 0 | 1 | 2 | 3 | 4 {
  if (count === 0 || maxInMonth === 0) return 0;
  const ratio = count / maxInMonth;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

export default function Calendar({
  counts,
  selected,
  onSelect,
}: {
  counts: Record<string, number>;
  selected: string | null;
  onSelect: (dayKey: string | null) => void;
}) {
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  const todayKey = localDayKey(Date.now());

  const { cells, maxInMonth } = useMemo(() => {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const firstDow = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const cells: Array<{ dayKey: string; day: number } | null> = [];
    for (let i = 0; i < firstDow; i++) cells.push(null);
    let max = 0;
    for (let day = 1; day <= daysInMonth; day++) {
      const dayKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      max = Math.max(max, counts[dayKey] ?? 0);
      cells.push({ dayKey, day });
    }
    return { cells, maxInMonth: max };
  }, [cursor, counts]);

  return (
    <div className="calendar">
      <div className="calendar-head">
        <button
          type="button"
          className="calendar-nav"
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
          aria-label="previous month"
        >
          ‹
        </button>
        <span className="calendar-month">{monthLabel(cursor)}</span>
        <button
          type="button"
          className="calendar-nav"
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
          aria-label="next month"
        >
          ›
        </button>
      </div>
      <div className="calendar-weekdays">
        {WEEKDAYS.map((w, i) => (
          <span key={i}>{w}</span>
        ))}
      </div>
      <div className="calendar-grid">
        {cells.map((cell, i) => {
          if (!cell) return <span key={`blank-${i}`} className="calendar-cell blank" />;
          const count = counts[cell.dayKey] ?? 0;
          const step = intensityStep(count, maxInMonth);
          const isSelected = selected === cell.dayKey;
          const isToday = cell.dayKey === todayKey;
          return (
            <button
              key={cell.dayKey}
              type="button"
              className={`calendar-cell step-${step} ${isSelected ? "selected" : ""} ${isToday ? "today" : ""}`}
              disabled={count === 0}
              title={count > 0 ? `${count} sighting${count > 1 ? "s" : ""}` : "no sightings"}
              onClick={() => onSelect(isSelected ? null : cell.dayKey)}
            >
              {cell.day}
            </button>
          );
        })}
      </div>
    </div>
  );
}
