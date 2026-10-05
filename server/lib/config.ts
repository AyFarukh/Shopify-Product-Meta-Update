import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().url().default('http://localhost:3000'),
  SHOPIFY_API_KEY: z.string().min(1),
  SHOPIFY_API_SECRET: z.string().min(1),
  SHOPIFY_SCOPES: z.string().default('read_products,write_products'),
  SHOPIFY_API_VERSION: z.string().default('2026-10'),
  DATABASE_URL: z.string().default('file:./dev.db'),
  SESSION_SECRET: z.string().min(16),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
});

export const config = schema.parse(process.env);
