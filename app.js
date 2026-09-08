/*
 * Phusion Passenger startup file — this is the "Application Startup File"
 * you point Plesk's Node.js panel at.
 *
 * Deliberately CommonJS with no build step of its own: Passenger loads this
 * file directly, and its ESM support varies by version, so the server is
 * compiled to CommonJS and simply required here.
 *
 * Passenger sets PORT; nothing else about the environment is assumed.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const distApp = path.join(__dirname, 'server', 'dist', 'app.js');

if (!fs.existsSync(distApp)) {
  console.error(
    '[netkit] server/dist is missing — the application has not been built.\n' +
      '         Run "npm ci && npm run build" (or the Plesk deploy script) before starting.',
  );
  process.exit(1);
}

const { createApp } = require(distApp);
const { ensureAdminSeed } = require(path.join(__dirname, 'server', 'dist', 'auth', 'seed.js'));
const { config } = require(path.join(__dirname, 'server', 'dist', 'config.js'));
const { selfTestOnBoot } = require(path.join(__dirname, 'server', 'dist', 'admin', 'selftest.js'));
const { startSupervisor, stopSupervisor } = require(path.join(__dirname, 'server', 'dist', 'admin', 'supervisor.js'));

async function start() {
  await ensureAdminSeed();

  const cfg = config();
  const app = createApp();
  const port = process.env.PORT || cfg.port || 3000;

  const server = app.listen(port, async () => {
    console.log(`[netkit] SupportWizard NetKit v${cfg.version} ready on port ${port} (${cfg.env}, data mode: ${cfg.dataMode})`);
    // Prove this deployment works before anyone relies on it, then keep
    // watching for anything that breaks later and try to fix it.
    await selfTestOnBoot();
    startSupervisor();
  });

  // Plesk restarts the app by signalling it — drain in-flight requests first.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      stopSupervisor();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 8000).unref();
    });
  }
}

start().catch((err) => {
  console.error('[netkit] failed to start:', err);
  process.exit(1);
});
