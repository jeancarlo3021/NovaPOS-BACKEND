import { handle } from 'hono/vercel';
import app from '../src/app';

// Node.js serverless runtime (Vercel)
export const config = { runtime: 'nodejs20.x' };

export default handle(app);
