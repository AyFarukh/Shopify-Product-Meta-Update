import { Router } from 'express';
import crypto from 'node:crypto';
import { config, shopifyConfigured } from '../lib/config.js';
import { prisma } from '../lib/prisma.js';
import { validateOAuthHmac } from '../middleware/shopifyAuth.js';

export const authRouter = Router();
const states = new Map<string,number>();
const cleanShop = (shop:string) => shop.trim().toLowerCase().replace(/^https?:\/\//,'').replace(/\/$/,'');

authRouter.get('/auth', (req,res) => {
  if (!shopifyConfigured) return res.status(503).send('Shopify credentials are not configured. CSV-only analysis is still available.');
  const shop = cleanShop(String(req.query.shop || ''));
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) return res.status(400).send('Invalid shop');
  const state = crypto.randomBytes(24).toString('hex');
  states.set(state, Date.now());
  const redirectUri = `${config.HOST}/auth/callback`;
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set('client_id',config.SHOPIFY_API_KEY);
  url.searchParams.set('scope',config.SHOPIFY_SCOPES);
  url.searchParams.set('redirect_uri',redirectUri);
  url.searchParams.set('state',state);
  res.redirect(url.toString());
});

authRouter.get('/auth/callback', async (req,res,next) => {
  try {
    if (!validateOAuthHmac(req.query)) return res.status(400).send('Invalid OAuth HMAC');
    const shop = cleanShop(String(req.query.shop||''));
    const code=String(req.query.code||'');
    const state=String(req.query.state||'');
    const created=states.get(state);
    states.delete(state);
    if(!created || Date.now()-created>10*60_000) return res.status(400).send('Invalid OAuth state');
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({client_id:config.SHOPIFY_API_KEY,client_secret:config.SHOPIFY_API_SECRET,code})
    });
    if(!tokenRes.ok) throw new Error('OAuth token exchange failed');
    const token = await tokenRes.json() as {access_token:string;scope:string};
    await prisma.shop.upsert({
      where:{shopDomain:shop},
      update:{accessToken:token.access_token,scopes:token.scope},
      create:{shopDomain:shop,accessToken:token.access_token,scopes:token.scope,settings:{create:{}}}
    });
    res.redirect(`${config.WEB_ORIGIN}?shop=${encodeURIComponent(shop)}`);
  } catch(e){ next(e); }
});
