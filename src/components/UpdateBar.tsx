import { useCallback, useEffect, useState } from "react";
import type { Backend } from "../ipc";

// Signed updates from GitHub Releases, the same way every Forme app updates:
// a quiet check at launch and "Check for Updates…" in the app menu.

type Pending = { version: string; downloadAndInstall: (cb: (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void) => Promise<void> };

interface Props {
  backend: Backend;
  beforeRestart(): Promise<void>;
}

export function UpdateBar({ backend, beforeRestart }: Props) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);

  const check = useCallback(
    async (manual: boolean) => {
      if (!backend.native) return;
      try {
        const { check: checkUpdate } = await import("@tauri-apps/plugin-updater");
        const update = (await checkUpdate()) as Pending | null;
        if (update) {
          setPending(update);
          setHidden(false);
          setStatus(`Locus ${update.version} is available.`);
        } else if (manual) {
          setHidden(false);
          setStatus("Locus is up to date.");
        }
      } catch (e) {
        if (manual) {
          setHidden(false);
          setStatus(`Couldn't check for updates. ${String(e)}`);
        }
      }
    },
    [backend]
  );

  useEffect(() => {
    void check(false);
    return backend.on("menu", (cmd) => cmd === "check-updates" && void check(true));
  }, [backend, check]);

  const install = async () => {
    if (!pending || busy) return;
    setBusy(true);
    let total = 0;
    let done = 0;
    try {
      await pending.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data?.contentLength ?? 0;
        if (e.event === "Progress") done += e.data?.chunkLength ?? 0;
        setStatus(total ? `Installing… ${Math.min(100, Math.round((done / total) * 100))}%` : "Installing…");
      });
      setStatus("Update installed. Restarting…");
      await beforeRestart();
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("restart_app");
    } catch (e) {
      setBusy(false);
      setStatus(`Update failed. ${String(e)}`);
    }
  };

  if (!status || hidden) return null;
  return (
    <div className="update-bar" role="status">
      <span>{status}</span>
      {pending && !busy && (
        <button className="btn primary small" onClick={() => void install()}>
          Install and restart
        </button>
      )}
      {!busy && (
        <button className="btn ghost small" onClick={() => setHidden(true)}>
          {pending ? "Later" : "OK"}
        </button>
      )}
    </div>
  );
}
