import { useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";

type Status = "idle" | "uploading" | "done" | "error";

export default function TestUpload() {
  const generateUploadUrl = useMutation(api.testUpload.generateUploadUrl);
  const createFromUpload = useMutation(api.testUpload.createFromUpload);
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handleFile(file: File) {
    setStatus("uploading");
    setErrorMsg(null);
    try {
      const uploadUrl = await generateUploadUrl();
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type || "image/jpeg" },
        body: file,
      });
      if (!res.ok) throw new Error(`upload failed (${res.status})`);
      const { storageId } = await res.json();
      await createFromUpload({ storageId });
      setStatus("done");
      setTimeout(() => setStatus("idle"), 2500);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "upload failed");
      setStatus("error");
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const label =
    status === "uploading"
      ? "uploading…"
      : status === "done"
        ? "added — check the log ✓"
        : status === "error"
          ? "failed — try again"
          : "choose a photo";

  return (
    <section className="test-upload">
      <div className="test-upload-text">
        <h2>Submit a specimen</h2>
        <p>
          Upload any bird photo to test the identifier directly. It runs
          through the exact same species-ID pipeline as a real sighting and
          appears in the log below, tagged <code>test-upload</code>.
        </p>
      </div>
      <label className="test-upload-control">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          disabled={status === "uploading"}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
        <span className={`test-upload-button ${status}`}>{label}</span>
      </label>
      {errorMsg && <p className="test-upload-error">{errorMsg}</p>}
    </section>
  );
}
