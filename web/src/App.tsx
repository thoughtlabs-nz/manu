import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import TestUpload from "./TestUpload";

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

function absoluteTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function BirdMark() {
  return (
    <svg viewBox="0 0 48 40" className="bird-mark" aria-hidden="true">
      <path
        d="M4 30 C10 14 22 8 34 10 C36 6 40 4 44 5 C42 8 41 10 41 13 C41 24 30 33 18 33 L8 33 L14 38 L6 37 Z"
        fill="currentColor"
      />
      <circle cx="38.5" cy="9.5" r="1.4" fill="var(--paper)" />
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

function Entry({ d, index }: { d: Detection; index: number }) {
  return (
    <article className="entry" style={{ animationDelay: `${index * 60}ms` }}>
      <div className="entry-rule" />
      <div className="entry-head">
        <span className="entry-no">№ {String(index + 1).padStart(3, "0")}</span>
        <span className="entry-when" title={absoluteTime(d.receivedAt)}>
          {relativeTime(d.receivedAt)}
        </span>
      </div>
      <figure className="entry-photo">
        {d.snapshotUrl ? (
          <img src={d.snapshotUrl} alt={`${d.species} sighting`} loading="lazy" />
        ) : (
          <div className="entry-photo-none">
            <BirdMark />
            <span>no portrait captured</span>
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
  const detections = useQuery(api.detections.recent, { limit: 50 });
  const stats = useQuery(api.detections.stats, {});
  const loading = detections === undefined;

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
          <div className="stat live">
            <span className="live-dot" />
            <span className="stat-label">watching</span>
          </div>
        </div>
      </header>

      <TestUpload />

      <main>
        {loading ? (
          <p className="loading">consulting the log…</p>
        ) : detections.length === 0 ? (
          <EmptyPerch />
        ) : (
          <section className="feed">
            {detections.map((d, i) => (
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
