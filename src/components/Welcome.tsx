interface Props {
  recent: string[];
  onOpen(): void;
  onOpenRecent(root: string): void;
  error: string | null;
}

const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export function Welcome({ recent, onOpen, onOpenRecent, error }: Props) {
  return (
    <main className="welcome">
      <div className="welcome-inner">
        <h1>Locus</h1>
        <p className="welcome-lede">Open a folder to see every image in it, and in every folder below it, on one board.</p>
        <button className="btn primary" onClick={onOpen}>
          Open folder…
        </button>
        {error && <p className="welcome-error">{error}</p>}
        {recent.length > 0 && (
          <section className="recent">
            <h2>Recent</h2>
            <ul>
              {recent.map((r) => (
                <li key={r}>
                  <button className="recent-item" onClick={() => onOpenRecent(r)} title={r}>
                    <span className="recent-name">{base(r)}</span>
                    <span className="recent-path">{r}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
