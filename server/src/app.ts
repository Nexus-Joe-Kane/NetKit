import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { bootstrapCredentials, refreshVaultIfChanged } from './services/vault';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config, resetConfig } from './config';
import { apiRouter, errorHandler } from './routes/api';
import { operationsRouter } from './routes/operations';
import { authRouter, requireAuth } from './auth/routes';
import { adminRouter } from './admin/routes';
import { clearAllProviderCaches } from './admin/supervisor';

/**
 * The Express application.
 *
 * Exported separately from the listener so it can be mounted by Phusion
 * Passenger on Plesk, driven by tests, or started directly.
 */
export function createApp(): Express {
  // Passenger loads this file directly rather than bin/serve, so the vault
  // has to be read here too — before the config() below, which is the first
  // thing that would cache a credential's absence.
  bootstrapCredentials();
  const cfg = config();
  const app = express();

  // Plesk terminates TLS in nginx in front of the app, so the real client IP
  // and protocol arrive in X-Forwarded-* headers.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // Everything — styles and the Poppins webfonts — is served from
          // this origin, so no external host needs allowing at all.
          styleSrc: ["'self'", "'unsafe-inline'"],
          fontSrc: ["'self'", 'data:'],
          imgSrc: ["'self'", 'data:'],
          scriptSrc: ["'self'"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      // Let the browser send the session cookie on same-site navigations.
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  app.use(compression());
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  if (cfg.corsOrigins.length) {
    app.use(cors({ origin: cfg.corsOrigins, credentials: true }));
  }

  /*
   * Pick up credentials another worker saved.
   *
   * Passenger runs several worker processes. Saving a credential puts it into
   * the environment of the one process that handled the request, so without
   * this the others go on answering "not connected" for a key the
   * Credentials page says is stored — which is exactly what they did.
   *
   * One `stat` of the vault file per request, and only on a change does
   * anything else happen: the config cache and the provider clients are both
   * holding a view from before the credential existed, so both go.
   */
  app.use((_req: Request, _res: Response, next: NextFunction) => {
    try {
      const refresh = refreshVaultIfChanged();
      if (refresh.changed) {
        resetConfig();
        clearAllProviderCaches();
        if (refresh.loaded.length) {
          console.log(`[netkit] picked up ${refresh.loaded.length} credential(s) saved elsewhere.`);
        }
      }
    } catch {
      // A settings refresh must never be the reason a request fails.
    }
    next();
  });

  // ---- Liveness, before auth so monitoring can reach it --------------
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, version: cfg.version, uptime: Math.round(process.uptime()) });
  });

  // ---- Authentication ------------------------------------------------
  app.use('/api/auth', authRouter());

  // ---- Everything else needs a session -------------------------------
  const apiLimiter = rateLimit({
    windowMs: cfg.rateLimit.windowMs,
    limit: cfg.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: { code: 'rate_limited', message: 'Slow down a moment — too many requests.' } },
  });

  app.use('/api/admin', adminRouter());
  app.use('/api', requireAuth, apiLimiter, operationsRouter());
  app.use('/api', requireAuth, apiLimiter, apiRouter());

  // ---- Static SPA ----------------------------------------------------
  const publicDir = cfg.publicDir ? resolve(cfg.publicDir) : findPublicDir();
  if (publicDir && existsSync(publicDir)) {
    app.use(
      express.static(publicDir, {
        // Hashed asset filenames can be cached hard; index.html cannot.
        setHeaders: (res, path) => {
          if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
          else if (/\.[0-9a-f]{8,}\./.test(path)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        },
      }),
    );

    // Client-side routing: anything that isn't an API call or a real file
    // falls through to the SPA shell.
    app.get(/^(?!\/api\/).*/, (req, res, next) => {
      if (req.method !== 'GET') return next();
      res.sendFile(join(publicDir, 'index.html'), (err) => {
        if (err) next();
      });
    });
  }

  // ---- Not found -----------------------------------------------------
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/api/')) return next();
    res.status(404).json({ ok: false, error: { code: 'not_found', message: `No such endpoint: ${req.method} ${req.path}` } });
  });

  app.use(errorHandler);
  return app;
}

/**
 * Locates the built SPA. On Plesk the app root and the document root are
 * often different directories, so several conventional spots are tried.
 */
function findPublicDir(): string | null {
  const candidates = [
    resolve(process.cwd(), 'public'),
    resolve(process.cwd(), 'web/dist'),
    resolve(__dirname, '../../public'),
    resolve(__dirname, '../../web/dist'),
  ];
  return candidates.find((c) => existsSync(join(c, 'index.html'))) ?? null;
}
