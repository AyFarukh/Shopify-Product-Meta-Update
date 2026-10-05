import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { config } from './lib/config.js';
import { authRouter } from './routes/auth.js';
import { apiRouter } from './routes/api.js';

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: config.WEB_ORIGIN, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.get('/health', (_req, res) => res.json({ ok: true }));
app.use(authRouter);
app.use('/api', apiRouter);
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  const error = err as { name?: string; message?: string };
  res.status(error?.name === 'ZodError' ? 400 : 500).json({ error: error?.message || 'Unexpected error' });
});
app.listen(config.PORT, () => console.log(`Server listening on ${config.PORT}`));
