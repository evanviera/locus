interface Props {
  left: number;
  paused: boolean;
  onToggle(): void;
}

/** Shown while online-only images (Google Drive, Dropbox) are being downloaded
 *  so they can be previewed. Pausing stops all but images zoomed in on. */
export function CloudStatus({ left, paused, onToggle }: Props) {
  return (
    <div className="cloud-status" role="status" data-testid="cloud-status" data-canvas-control>
      <span>
        {paused ? "Downloads paused" : "Downloading from the cloud"} · {left.toLocaleString()} left
      </span>
      <button className="btn small" onClick={onToggle}>
        {paused ? "Resume" : "Pause"}
      </button>
    </div>
  );
}
