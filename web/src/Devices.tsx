import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import birdhouse from "./assets/birdhouse.png";

type Device = NonNullable<ReturnType<typeof useQuery<typeof api.devices.list>>>[number];
type Settings = Device["reported"];

function bytes(n: number): string {
  if (n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function duration(seconds: number): string {
  if (seconds <= 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 2) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} hr ago`;
}

// Inferences per second, which is capped by the camera's idle_framerate (1fps)
// rather than by the model. A rate well under that is the clearest sign the
// pipeline has stalled, so it earns a slot on the front of the panel.
function rate(inferences: number, uptime: number): string {
  if (uptime <= 0 || inferences <= 0) return "—";
  return `${(inferences / uptime).toFixed(2)}/s`;
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="dev-stat" title={title}>
      <span className="dev-stat-value">{value}</span>
      <span className="dev-stat-label">{label}</span>
    </div>
  );
}

// A slider that reports the DEVICE's value at rest but follows the pointer
// while dragging, committing once on release. Committing on every input event
// would bump the config revision dozens of times per drag, and each bump is a
// write the camera then has to collect.
function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  disabled,
  unconfirmed,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  disabled: boolean;
  unconfirmed: boolean;
  onCommit: (v: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [local, setLocal] = useState(value);
  const shown = dragging ? local : value;

  function commit() {
    if (!dragging) return;
    setDragging(false);
    if (local !== value) onCommit(local);
  }

  return (
    <label className={`dev-control${unconfirmed ? " unconfirmed" : ""}`}>
      <span className="dev-control-label">
        {label}
        <em>{format(shown)}</em>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        disabled={disabled}
        onChange={(e) => {
          setDragging(true);
          setLocal(Number(e.target.value));
        }}
        onPointerUp={commit}
        onBlur={commit}
        onKeyUp={commit}
      />
    </label>
  );
}

function Toggle({
  label,
  checked,
  disabled,
  unconfirmed,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  unconfirmed: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      className={`dev-toggle${checked ? " on" : ""}${
        unconfirmed ? " unconfirmed" : ""
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function DeviceCard({ d }: { d: Device }) {
  const sendCommand = useMutation(api.devices.sendCommand);
  const updateConfig = useMutation(api.devices.updateConfig);

  // Nothing reaches the camera except on its next beacon, so a press has no
  // visible effect for up to 10s. Without this the button feels broken and
  // gets pressed again.
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
    },
    []
  );

  function command(kind: "trigger" | "restart", note: string) {
    void sendCommand({ device: d.device, kind });
    setFlash(note);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 12_000);
  }

  function set(patch: Partial<Settings>) {
    void updateConfig({ device: d.device, settings: patch });
  }

  // Controls render the REQUESTED value, not the reported one. Rendering
  // device truth was the obvious choice and it was wrong: nothing reaches the
  // camera until its next beacon, so every toggle visibly snapped back for up
  // to 10 seconds and read as a click that failed.
  //
  // Honesty is preserved by `unconfirmed` instead — any control the device has
  // not yet echoed back is marked, so the panel shows what you asked for AND
  // that the hardware has not caught up.
  const s = d.desired;
  const offline = !d.online;
  const unconfirmed = (key: keyof Settings) => d.desired[key] !== d.reported[key];

  return (
    <article className={`device${offline ? " offline" : ""}`}>
      <header className="dev-head">
        {/* The enclosure this camera actually lives in, so the panel reads as
            a particular object in the garden rather than a row in a table. */}
        <img className="dev-render" src={birdhouse} alt="" aria-hidden="true" />
        <div className="dev-ident">
          <div className="dev-name">
            <span className={`dev-dot${d.online ? " live" : ""}`} />
            <h3>{d.device}</h3>
          </div>
          <span className="dev-seen">
            {d.online
              ? `beacon ${ago(d.receivedAt)}`
              : `silent since ${ago(d.receivedAt)}`}
          </span>
        </div>
      </header>

      <div className="dev-stats">
        <Stat label="uptime" value={duration(d.uptime)} />
        <Stat
          label="inference rate"
          value={rate(d.inferences, d.uptime)}
          title={`${d.inferences.toLocaleString()} inferences since boot · the camera's 1fps idle_framerate is the ceiling`}
        />
        <Stat label="wifi" value={d.rssi ? `${d.rssi} dBm` : "—"} />
        <Stat label="temp" value={d.temperature ? `${d.temperature.toFixed(0)}°C` : "—"} />
        <Stat
          label="largest free block"
          value={bytes(d.largestFreeInternal)}
          title="Largest contiguous internal allocation. This, not total free heap, is what predicts the bad_alloc boot loop — a 640x480 JPEG needs ~40KB in one piece."
        />
        <Stat label="heap free" value={bytes(d.freeInternal)} />
        <Stat label="psram free" value={bytes(d.freePsram)} />
        <Stat label="loop" value={d.loopTime ? `${d.loopTime} ms` : "—"} />
      </div>

      <div className="dev-actions">
        <button
          type="button"
          className="dev-btn primary"
          disabled={offline}
          onClick={() =>
            command("trigger", "trigger queued — collected on the next beacon")
          }
        >
          Trigger a sighting
        </button>
        <button
          type="button"
          className="dev-btn"
          disabled={offline}
          onClick={() => command("restart", "restart queued")}
        >
          Restart
        </button>
        {flash ? <span className="dev-flash">{flash}</span> : null}
        {d.configPending ? (
          <span className="dev-flash">settings queued — waiting for the next beacon</span>
        ) : null}
      </div>

      <div className="dev-controls">
        <div className="dev-toggles">
          <Toggle
            label="detection"
            checked={s.detectionEnabled}
            disabled={offline}
            unconfirmed={unconfirmed("detectionEnabled")}
            onChange={(v) => set({ detectionEnabled: v })}
          />
          <Toggle
            label="snapshot uploads"
            checked={s.snapshotUploads}
            disabled={offline}
            unconfirmed={unconfirmed("snapshotUploads")}
            onChange={(v) => set({ snapshotUploads: v })}
          />
          <Toggle
            label="capture mode"
            checked={s.captureMode}
            disabled={offline}
            unconfirmed={unconfirmed("captureMode")}
            onChange={(v) => set({ captureMode: v })}
          />
        </div>

        {s.captureMode ? (
          <p className="dev-warn">
            Capture mode is on: frames go to the training set, and no sightings
            are logged or identified.
          </p>
        ) : null}

        <Slider
          label="min confidence"
          value={s.minConfidence}
          min={0.01}
          max={1}
          step={0.01}
          format={(v) => `${(v * 100).toFixed(0)}%`}
          disabled={offline}
          unconfirmed={unconfirmed("minConfidence")}
          onCommit={(v) => set({ minConfidence: v })}
        />
        {s.captureMode ? (
          <Slider
            label="capture interval"
            value={s.captureInterval}
            min={1}
            max={120}
            step={1}
            format={(v) => `${v}s`}
            disabled={offline}
          unconfirmed={unconfirmed("captureInterval")}
            onCommit={(v) => set({ captureInterval: v })}
          />
        ) : null}
        <Slider
          label="brightness"
          value={s.brightness}
          min={-2}
          max={2}
          step={1}
          format={(v) => String(v)}
          disabled={offline}
          unconfirmed={unconfirmed("brightness")}
          onCommit={(v) => set({ brightness: v })}
        />
        <Slider
          label="contrast"
          value={s.contrast}
          min={-2}
          max={2}
          step={1}
          format={(v) => String(v)}
          disabled={offline}
          unconfirmed={unconfirmed("contrast")}
          onCommit={(v) => set({ contrast: v })}
        />
        <Slider
          label="saturation"
          value={s.saturation}
          min={-2}
          max={2}
          step={1}
          format={(v) => String(v)}
          disabled={offline}
          unconfirmed={unconfirmed("saturation")}
          onCommit={(v) => set({ saturation: v })}
        />
        <Slider
          label="auto-exposure level"
          value={s.aeLevel}
          min={-2}
          max={2}
          step={1}
          format={(v) => String(v)}
          disabled={offline}
          unconfirmed={unconfirmed("aeLevel")}
          onCommit={(v) => set({ aeLevel: v })}
        />
      </div>
    </article>
  );
}

export default function Devices() {
  const devices = useQuery(api.devices.list, {});

  // Absent entirely until a camera has beaconed once. An empty panel would
  // otherwise read as "the camera is broken" on a deployment that simply has
  // not been flashed with the beacon build yet.
  if (!devices || devices.length === 0) return null;

  return (
    <section className="devices">
      <div className="devices-head">
        <h2>The hide</h2>
        <span className="devices-note">
          every camera reports in every 10 seconds · commands ride back on the
          next report
        </span>
      </div>
      <div className="devices-grid">
        {devices.map((d) => (
          <DeviceCard key={d._id} d={d} />
        ))}
      </div>
    </section>
  );
}
