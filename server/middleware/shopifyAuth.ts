import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma.js';
import { config, shopifyConfigured } from '../lib/config.js';

declare global { namespace Express { interface Request { shopSession?: { shopId:string; shop:string; accessToken:string } } } }

async function attachSessionFromBearer(req: Request) {
  if (!shopifyConfigured) return false;
  const auth = req.header('authorization');
  if (!auth?.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  const payload = jwt.verify(token, config.SHOPIFY_API_SECRET, { algorithms:['HS256'], audience: config.SHOPIFY_API_KEY }) as jwt.JwtPayload;
  const dest = String(payload.dest || '');
  const shop = new URL(dest).hostname;
  if (!shop.endsWith('.myshopify.com')) throw new Error('Invalid shop domain');
  const record = await prisma.shop.findUnique({where:{shopDomain:shop}});
  if (!record) throw new Error('Shop not installed');
  req.shopSession = {shopId:record.id, shop, accessToken:record.accessToken};
  return true;
}

export async function optionalShopifySession(req: Request, _res: Response, next: NextFunction) {
  try {
    await attachSessionFromBearer(req);
    next();
  } catch {
    next();
  }
}

export async function requireShopifySession(req: Request, res: Response, next: NextFunction) {
  if (!shopifyConfigured) return res.status(503).json({error:'Shopify credentials are not configured'});
  try {
    const attached = await attachSessionFromBearer(req);
    if (!attached) return res.status(401).json({error:'Missing Shopify session token'});
    next();
  } catch {
    return res.status(401).json({error:'Invalid Shopify session'});
  }
}

export function validateOAuthHmac(query: Record<string,unknown>) {
  if (!shopifyConfigured) return false;
  const { hmac, ...rest } = query;
  if (typeof hmac !== 'string') return false;
  const message = Object.keys(rest).sort().map(k=>`${k}=${Array.isArray(rest[k]) ? (rest[k] as unknown[]).join(',') : rest[k]}`).join('&');
  const digest = crypto.createHmac('sha256', config.SHOPIFY_API_SECRET).update(message).digest('hex');
  const expected = Buffer.from(digest, 'utf8');
  const received = Buffer.from(hmac, 'utf8');
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}
