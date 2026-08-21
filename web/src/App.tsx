import { useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import TestUpload from "./TestUpload";
import Calendar from "./Calendar";
import Reports from "./Reports";
import { dayBoundsMs, formatDayKey, localDayKey } from "./dateUtils";

type Detection = NonNullable<
  ReturnType<typeof useQuery<typeof api.detections.recent>>
>[number];

function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  const min = Math.floor(delta / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs} hr${hrs > 1 ? "s" : ""} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days > 1 ? "s" : ""} ago`;
}

// Species-ID calls cost fractions of a cent, so a plain toFixed(2) would show
// every sighting as "$0.00". Scale the precision to the magnitude instead.
function money(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function absoluteTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// A pīwakawaka (fantail) — its fanned tail is the clearest "this is a bird"
// silhouette at small sizes, and it's the bird that keeps showing up in the
// test photos, so it fits.
function BirdMark() {
  return (
    <svg viewBox="0 0 64 48" className="bird-mark" aria-hidden="true">
      <g stroke="currentColor" strokeLinecap="round" fill="none">
        <path d="M21 27 L3 31 M21 27 L4 19 M21 27 L9 9 M21 27 L17 4 M21 27 L25 6" strokeWidth="4" />
        <path d="M10 42 L52 42" strokeWidth="2" />
        <path d="M32 34 L30 42 M38 34 L39 42" strokeWidth="1.6" />
      </g>
      <ellipse cx="36" cy="26" rx="13" ry="10" fill="currentColor" />
      <circle cx="49" cy="17" r="7" fill="currentColor" />
      <polygon points="55,17 61,19 55,21" fill="currentColor" />
      <circle cx="50.5" cy="15" r="1.3" fill="var(--paper)" />
    </svg>
  );
}

function EmptyPerch() {
  return (
    <div className="empty">
      <div className="empty-branch" />
      <h2>The perch is empty.</h2>
      <p>
        The camera is watching. When a bird lands, its portrait and the moment
        of arrival will appear here — live, no refresh needed.
      </p>
    </div>
  );
}

function ConfidenceMeter({ value }: { value: number }) {
  return (
    <div
      className="meter"
      role="meter"
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="detection confidence"
    >
      <div className="meter-fill" style={{ width: `${value * 100}%` }} />
    </div>
  );
}

const HOLD_MS = 1400;
const MOVE_CANCEL_PX = 12;

function DeleteRing({ progress }: { progress: number }) {
  const r = 16;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 40 40" className="delete-ring" aria-hidden="true">
      <circle cx="20" cy="20" r={r} className="delete-ring-track" />
      <circle
        cx="20"
        cy="20"
        r={r}
        className="delete-ring-fill"
        transform="rotate(-90 20 20)"
        style={{ strokeDasharray: c, strokeDashoffset: c * (1 - progress) }}
      />
    </svg>
  );
}

function Entry({ d, index }: { d: Detection; index: number }) {
  const removeDetection = useMutation(api.detections.remove);
  const [holding, setHolding] = useState(false);
  const [progress, setProgress] = useState(0);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<{ t: number; x: number; y: number } | null>(null);
  const deletingRef = useRef(false);

  function cancelHold() {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    startRef.current = null;
    setHolding(false);
    setProgress(0);
  }

  function tick() {
    if (!startRef.current || deletingRef.current) return;
    const p = Math.min((performance.now() - startRef.current.t) / HOLD_MS, 1);
    setProgress(p);
    if (p >= 1) {
      deletingRef.current = true;
      removeDetection({ detectionId: d._id }).catch(() => {
        deletingRef.current = false;
        cancelHold();
      });
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (deletingRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    startRef.current = { t: performance.now(), x: e.clientX, y: e.clientY };
    setHolding(true);
    setProgress(0);
    rafRef.current = requestAnimationFrame(tick);
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLElement>) {
    if (!startRef.current) return;
    const dx = e.clientX - startRef.current.x;
    const dy = e.clientY - startRef.current.y;
    if (Math.hypot(dx, dy) > MOVE_CANCEL_PX) cancelHold();
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLElement>) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (!deletingRef.current) cancelHold();
  }

  return (
    <article className="entry" style={{ animationDelay: `${index * 60}ms` }}>
      <div className="entry-rule" />
      <div className="entry-head">
        <span className="entry-no">№ {String(index + 1).padStart(3, "0")}</span>
        <span className="entry-when" title={absoluteTime(d.receivedAt)}>
          {relativeTime(d.receivedAt)}
        </span>
      </div>
      <figure
        className="entry-photo"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {d.snapshotUrl ? (
          <img
            src={d.snapshotUrl}
            alt={`${d.species} sighting`}
            loading="lazy"
            draggable={false}
          />
        ) : (
          <div className="entry-photo-none">
            <BirdMark />
            <span>no portrait captured</span>
          </div>
        )}
        {holding && (
          <div className="delete-overlay">
            <DeleteRing progress={progress} />
            <span className="delete-label">hold to delete</span>
          </div>
        )}
      </figure>
      <div className="entry-body">
        <h3 className="entry-species">
          {d.speciesStatus === "done" && d.speciesCommonName
            ? d.speciesCommonName
            : d.species}
        </h3>
        {d.speciesStatus === "done" && d.speciesScientificName ? (
          <p className="entry-scientific">{d.speciesScientificName}</p>
        ) : null}
        {d.speciesStatus === "pending" ? (
          <p className="entry-identifying">
            <span className="live-dot" />
            identifying species
          </p>
        ) : null}
        <div className="entry-meta">
          <span className="chip">{d.device}</span>
          <span className="conf">
            {(d.confidence * 100).toFixed(0)}
            <small>%</small>
          </span>
          {typeof d.speciesCost === "number" && d.speciesCost > 0 ? (
            <span className="chip cost" title="OpenRouter charge to identify this sighting">
              {money(d.speciesCost)}
            </span>
          ) : null}
        </div>
        <ConfidenceMeter value={d.confidence} />
        <p className="entry-note">
          {d.objectCount > 1
            ? `${d.objectCount} visitors in frame · `
            : ""}
          logged {absoluteTime(d.receivedAt)}
        </p>
      </div>
    </article>
  );
}

export default function App() {
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");

  const recentDetections = useQuery(api.detections.recent, { limit: 50 });
  const dayBounds = selectedDay ? dayBoundsMs(selectedDay) : null;
  const dayDetections = useQuery(
    api.detections.byDay,
    dayBounds ? dayBounds : "skip"
  );
  const summaryRows = useQuery(api.detections.summary, {});
  const stats = useQuery(api.detections.stats, {});
  const llm = useQuery(api.llmUsage.summary, {});

  const activeDetections = selectedDay ? dayDetections : recentDetections;
  const loading = activeDetections === undefined;

  const sortedDetections = useMemo(() => {
    if (!activeDetections) return undefined;
    return sortOrder === "newest"
      ? activeDetections
      : [...activeDetections].reverse();
  }, [activeDetections, sortOrder]);

  const dayCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of summaryRows ?? []) {
      const key = localDayKey(r.receivedAt);
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [summaryRows]);

  return (
    <div className="page">
      <div className="grain" aria-hidden="true" />
      <header className="masthead">
        <div className="masthead-brand">
          <BirdMark />
          <div>
            <h1>Manu</h1>
            <p className="tagline">a backyard bird observatory</p>
          </div>
        </div>
        <div className="masthead-stats">
          <div className="stat">
            <span className="stat-value">{stats?.last24h ?? "—"}</span>
            <span className="stat-label">sightings / 24h</span>
          </div>
          <div className="stat">
            <span className="stat-value">
              {stats ? Object.keys(stats.byDevice).length : "—"}
            </span>
            <span className="stat-label">cameras active</span>
          </div>
          <div className="stat">
            <span className="stat-value">
              {stats?.latestAt ? relativeTime(stats.latestAt) : "—"}
            </span>
            <span className="stat-label">last sighting</span>
          </div>
          <div
            className="stat"
            title={
              llm
                ? `${llm.last24h.calls} species-ID calls in 24h · ` +
                  `30d ${money(llm.last30d.cost)} · ` +
                  `all time ${money(llm.allTime.cost)}${llm.allTime.capped ? "+" : ""} · ` +
                  `avg ${money(llm.avgCostPerCall)}/call` +
                  (llm.wasted.calls
                    ? ` · ${llm.wasted.calls} billed but unusable (${money(llm.wasted.cost)})`
                    : "")
                : undefined
            }
          >
            <span className="stat-value">
              {llm ? money(llm.last24h.cost) : "—"}
            </span>
            <span className="stat-label">species ID / 24h</span>
          </div>
          <div className="stat live">
            <span className="live-dot" />
            <span className="stat-label">watching</span>
          </div>
        </div>
      </header>

      <TestUpload />

      <section className="logbook">
        <Calendar counts={dayCounts} selected={selectedDay} onSelect={setSelectedDay} />
        <Reports rows={summaryRows ?? []} />
      </section>

      <div className="feed-toolbar">
        {selectedDay ? (
          <span className="feed-filter">
            Showing <strong>{formatDayKey(selectedDay)}</strong>
            <button type="button" className="feed-filter-clear" onClick={() => setSelectedDay(null)}>
              clear ×
            </button>
          </span>
        ) : (
          <span className="feed-filter muted">Showing the most recent 50 sightings</span>
        )}
        <button
          type="button"
          className="sort-toggle"
          onClick={() => setSortOrder((s) => (s === "newest" ? "oldest" : "newest"))}
        >
          {sortOrder === "newest" ? "newest first" : "oldest first"} ⇅
        </button>
      </div>

      <main>
        {loading || !sortedDetections ? (
          <p className="loading">consulting the log…</p>
        ) : sortedDetections.length === 0 ? (
          selectedDay ? (
            <p className="loading">no sightings on {formatDayKey(selectedDay)}.</p>
          ) : (
            <EmptyPerch />
          )
        ) : (
          <section className="feed">
            {sortedDetections.map((d, i) => (
              <Entry key={d._id} d={d} index={i} />
            ))}
          </section>
        )}
      </main>

      <footer className="colophon">
        <span>
          field observations recorded on-device by an ESP32-S3 · relayed the
          moment they happen
        </span>
      </footer>
    </div>
  );
}
