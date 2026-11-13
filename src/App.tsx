import { useCallback, useEffect, useState } from "react";
import { type Backend, getBackend } from "./ipc.js";
import { Session } from "./lib/session.js";
import { type Theme, applyTheme, prefs } from "./lib/prefs.js";
import { Welcome } from "./components/Welcome.js";
import { BoardScreen } from "./components/BoardScreen.js";
import { UpdateBar } from "./components/UpdateBar.js";

export default function App() {
  const [backend, setBackend] = useState<Backend | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [theme, setTheme] = useState<Theme>(prefs.theme());
  const [recent, setRecent] = useState(prefs.recent());
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    void getBackend().then(setBackend);
  }, []);

  useEffect(() => {
    applyTheme(theme);
    prefs.setTheme(theme);
  }, [theme]);

  const open = useCallback(
    async (root: string) => {
      if (!backend) return;
      setOpening(true);
      setError(null);
      try {
        const payload = await backend.openBoard(root);
        prefs.addRecent(root);
        setRecent(prefs.recent());
        setSession(new Session(backend, root, payload));
      } catch (e) {
        setError(`Couldn't open ${root}. ${String(e)}`);
      } finally {
        setOpening(false);
      }
    },
    [backend]
  );

  const pick = useCallback(async () => {
    const root = await backend?.pickFolder();
    if (root) await open(root);
  }, [backend, open]);

  // Browser build: open the generated board straight away.
  useEffect(() => {
    if (backend && !backend.native && !session) void open("/Volumes/Studio/Pre-production");
  }, [backend, session, open]);

  useEffect(() => {
    if (!backend || session) return;
    return backend.on("menu", (cmd) => cmd === "open" && void pick());
  }, [backend, session, pick]);

  if (!backend) return null;
  return (
    <>
      {session ? (
        <BoardScreen
          key={session.root}
          backend={backend}
          session={session}
          theme={theme}
          onTheme={setTheme}
          onClose={() => {
            void session.flush();
            setSession(null);
          }}
        />
      ) : (
        <Welcome recent={recent} onOpen={() => void pick()} onOpenRecent={(r) => void open(r)} error={opening ? null : error} />
      )}
      <UpdateBar backend={backend} beforeRestart={async () => { await session?.flush(); }} />
    </>
  );
}
