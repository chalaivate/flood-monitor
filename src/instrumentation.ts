// Runs once when a Next.js server instance starts (Node.js runtime): logs configuration
// warnings, installs the graceful-shutdown handlers when NEXT_MANUAL_SIG_HANDLE is set,
// and with EMBEDDED_WORKER=1 (the all-in-one Docker image) starts the data poller inside
// the server process, so a single container fetches, stores, alerts and serves the
// dashboard. See src/lib/server/lifecycle.ts.

export async function register(): Promise<void> {
  // NEXT_RUNTIME is inlined at build time, so the edge bundle drops this branch
  // (and with it node:sqlite / web-push).
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { onServerStart } = await import('./lib/server/lifecycle')
    onServerStart()
  }
}
