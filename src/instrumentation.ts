// Runs once when a Next.js server instance starts. With EMBEDDED_WORKER=1 (the
// all-in-one Docker image) the data poller runs inside the server process, so a
// single container fetches, stores, alerts and serves the dashboard.

export async function register(): Promise<void> {
  // NEXT_RUNTIME is inlined at build time, so the edge bundle drops this branch
  // (and with it node:sqlite / web-push).
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.EMBEDDED_WORKER === '1') {
    const { startEmbeddedWorker } = await import('./lib/server/embedded-worker')
    // Do not await the first cycle: register() must finish before requests are served.
    void startEmbeddedWorker()
  }
}
