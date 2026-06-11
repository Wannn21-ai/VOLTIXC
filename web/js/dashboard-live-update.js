export const DEFAULT_REFRESH_INTERVAL_MS = 3000;
export const MIN_REFRESH_INTERVAL_MS = 1000;
export const MAX_REFRESH_INTERVAL_MS = 5000;

export function clampRefreshInterval(value) {
  const parsed = Number(value);
  const fallback = DEFAULT_REFRESH_INTERVAL_MS;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(MAX_REFRESH_INTERVAL_MS, Math.max(MIN_REFRESH_INTERVAL_MS, Math.round(parsed)));
}

export function createMetersUpdateScheduler(
  update,
  {
    debounceMs = 150,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    onError = error => console.error("[Dashboard] Meter update failed:", error),
  } = {},
) {
  let timer = null;
  let running = false;
  let rerunRequested = false;

  const run = async () => {
    timer = null;
    if (running) {
      rerunRequested = true;
      return;
    }

    running = true;
    try {
      await update();
    } catch (error) {
      onError(error);
    } finally {
      running = false;
      if (rerunRequested) {
        rerunRequested = false;
        schedule();
      }
    }
  };

  const schedule = () => {
    if (running) {
      rerunRequested = true;
      return;
    }
    if (timer !== null) clearTimeoutFn(timer);
    timer = setTimeoutFn(run, debounceMs);
  };

  return { schedule };
}
