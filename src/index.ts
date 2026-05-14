// Local development server — Vercel uses api/[[...route]].ts
import 'dotenv/config';
import { serve } from '@hono/node-server';
import app from './app.js';

const port = Number(process.env.PORT) || 3001;
serve({ fetch: app.fetch, port }, () =>
  console.log(`NovaPOS API → http://localhost:${port}/api/health`)
);
