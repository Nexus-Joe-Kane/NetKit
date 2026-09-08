import { createApp } from '../app';
import { config } from '../config';
import { ensureAdminSeed } from '../auth/seed';
import { selfTestOnBoot } from '../admin/selftest';
import { startSupervisor, stopSupervisor } from '../admin/supervisor';

/**
 * Direct entry point: `node dist/bin/serve.js`.
 *
 * On Plesk, Passenger loads `app.js` at the project root instead, which
 * requires the same modules — so both paths run identical code.
 */
async function main(): Promise<void> {
  const cfg = config();
  await ensureAdminSeed();

  const app = createApp();
  const server = app.listen(cfg.port, async () => {
    console.log(`[netkit] SupportWizard NetKit v${cfg.version} listening on :${cfg.port} (${cfg.env})`);
    // Prove the deployment works before anyone relies on it, then start
    // watching for anything that breaks later.
    await selfTestOnBoot();
    startSupervisor();
  });

  // Plesk restarts the app by signalling it; finish in-flight work first.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      console.log(`[netkit] ${signal} received — shutting down`);
      stopSupervisor();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 8000).unref();
    });
  }
}

main().catch((err) => {
  console.error('[netkit] failed to start:', err);
  process.exit(1);
});
