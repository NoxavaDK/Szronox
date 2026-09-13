const intervalMs = Number(process.env.WORKER_POLL_MS ?? 30_000);
console.log(`SzroNox worker started (poll ${intervalMs}ms)`);
const timer = setInterval(() => undefined, intervalMs);
process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
