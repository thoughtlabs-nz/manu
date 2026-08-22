import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

function when(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.floor(h / 24)} days ago`;
}

// What the receiving end actually gets. Shown in the panel because the first
// thing anyone building an n8n workflow needs is the shape of the payload, and
// reading it out of the source is a worse experience than reading it here.
const SAMPLE = `{
  "event": "species_identified",
  "sentAt": "2026-08-22T02:31:07.412Z",
  "detectionId": "j57a...",
  "device": "bird-cam-1",
  "confidence": 0.42,
  "objectCount": 1,
  "detectedAt": "2026-08-22T02:31:02.881Z",
  "snapshotUrl": "https://...convex.cloud/...",
  "species": {
    "commonName": "New Zealand Fantail",
    "scientificName": "Rhipidura fuliginosa",
    "confidence": 0.91,
    "cost": 0.0021
  }
}`;

export default function Dispatch() {
  const config = useQuery(api.webhooks.get, {});
  const save = useMutation(api.webhooks.save);
  const sendTest = useMutation(api.webhooks.sendTest);

  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [onDetection, setOnDetection] = useState(true);
  const [onSpecies, setOnSpecies] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Seed the form once the config arrives, but never overwrite edits in
  // progress — this query is reactive, and a delivery result landing mid-typing
  // would otherwise wipe the field.
  useEffect(() => {
    if (config === undefined || dirty) return;
    setUrl(config?.url ?? "");
    setEnabled(config?.enabled ?? false);
    setOnDetection(config?.onDetection ?? true);
    setOnSpecies(config?.onSpeciesIdentified ?? true);
  }, [config, dirty]);

  if (config === undefined) return null;

  async function commit(next?: { enabled?: boolean }) {
    setError(null);
    setNote(null);
    try {
      await save({
        enabled: next?.enabled ?? enabled,
        url,
        onDetection,
        onSpeciesIdentified: onSpecies,
        // undefined leaves the stored secret alone, so an untouched blank field
        // does not silently clear a secret that is already set.
        secret: secret === "" ? undefined : secret,
      });
      setDirty(false);
      setSecret("");
      setNote("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    }
  }

  async function test() {
    setError(null);
    setNote(null);
    try {
      await sendTest({});
      setNote("Test dispatched — the result appears below in a moment.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send");
    }
  }

  const delivered = config?.lastAt ? config : null;
  const ok = delivered?.lastStatus !== undefined && delivered.lastStatus < 300;

  return (
    <section className="dispatch">
      <button
        type="button"
        className="dispatch-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <h2>The dispatch</h2>
        <span className="dispatch-summary">
          {config?.enabled && config.url ? (
            <>
              <span className="dev-dot live" />
              posting to {new URL(config.url).host}
            </>
          ) : (
            "no webhook configured"
          )}
        </span>
        <span className="dev-chevron" aria-hidden="true">
          {open ? "−" : "+"}
        </span>
      </button>

      {open ? (
        <div className="dispatch-body">
          <p className="dispatch-intro">
            POST every sighting to a URL of your choosing — n8n, Zapier, or your
            own endpoint. There is no filtering here on purpose: the payload
            carries confidence and species, so deciding what deserves a
            notification belongs in whatever receives it.
          </p>

          <label className="dispatch-field">
            <span>Webhook URL</span>
            <input
              type="url"
              inputMode="url"
              placeholder="https://n8n.example.com/webhook/manu"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setDirty(true);
              }}
            />
            <small>
              Must be https and publicly reachable — Convex runs in the cloud and
              cannot see your LAN.
            </small>
          </label>

          <label className="dispatch-field">
            <span>Shared secret (optional)</span>
            <input
              type="password"
              autoComplete="new-password"
              placeholder={
                config?.hasSecret ? "•••••••• (set — type to replace)" : "none"
              }
              value={secret}
              onChange={(e) => {
                setSecret(e.target.value);
                setDirty(true);
              }}
            />
            <small>
              Sent as <code>X-Manu-Secret</code> so the receiver can reject
              anything that did not come from here. Never shown again once
              saved.
            </small>
          </label>

          <div className="dispatch-events">
            <label className={`dev-toggle${onDetection ? " on" : ""}`}>
              <input
                type="checkbox"
                checked={onDetection}
                onChange={(e) => {
                  setOnDetection(e.target.checked);
                  setDirty(true);
                }}
              />
              <span>on detection</span>
            </label>
            <label className={`dev-toggle${onSpecies ? " on" : ""}`}>
              <input
                type="checkbox"
                checked={onSpecies}
                onChange={(e) => {
                  setOnSpecies(e.target.checked);
                  setDirty(true);
                }}
              />
              <span>on species identified</span>
            </label>
          </div>
          <p className="dispatch-hint">
            A <strong>detection</strong> fires the instant the camera reports,
            with no species and usually no photo — the snapshot arrives on a
            separate request a moment later. <strong>Species identified</strong>{" "}
            lands seconds afterwards with both. Most relays want the second one.
          </p>

          <div className="dispatch-actions">
            <button
              type="button"
              className="dev-btn primary"
              onClick={() => void commit()}
              disabled={!dirty}
            >
              {dirty ? "Save" : "Saved"}
            </button>
            <button
              type="button"
              className="dev-btn"
              onClick={() => void commit({ enabled: !enabled })}
              disabled={dirty || (!enabled && !url)}
              title={
                !enabled && !url ? "Set and save a URL first" : undefined
              }
            >
              {enabled ? "Disable" : "Enable"}
            </button>
            <button
              type="button"
              className="dev-btn"
              onClick={() => void test()}
              disabled={dirty || !config?.url}
            >
              Send test
            </button>
            <span className={`dispatch-state${enabled ? " on" : ""}`}>
              {enabled ? "enabled" : "disabled"}
            </span>
          </div>

          {error ? <p className="dispatch-error">{error}</p> : null}
          {note ? <p className="dispatch-note">{note}</p> : null}

          {delivered ? (
            <p className={`dispatch-last${ok ? " ok" : " bad"}`}>
              Last delivery — {delivered.lastEvent} ·{" "}
              {delivered.lastStatus !== undefined
                ? `HTTP ${delivered.lastStatus}`
                : "failed"}{" "}
              · {when(delivered.lastAt!)}
              {delivered.lastError ? (
                <>
                  <br />
                  <span className="dispatch-last-error">
                    {delivered.lastError}
                  </span>
                </>
              ) : null}
            </p>
          ) : null}

          <details className="dispatch-sample">
            <summary>Payload shape</summary>
            <pre>{SAMPLE}</pre>
          </details>
        </div>
      ) : null}
    </section>
  );
}
