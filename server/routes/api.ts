import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireShopifySession } from '../middleware/shopifyAuth.js';
import { startSyncJob, startUndoJob, startUpdateJob, startVendorScan } from '../jobs/jobRunner.js';

export const apiRouter = Router();
apiRouter.use(requireShopifySession);
const shopId = (req: Request) => req.shopSession!.shopId;

apiRouter.get('/dashboard', async (req, res) => {
  const id = shopId(req);
  const [total, scanned, detected, generic, correct, review, ready, updated, failed] = await Promise.all([
    prisma.product.count({ where: { shopId: id } }),
    prisma.vendorSuggestion.count({ where: { product: { shopId: id } } }),
    prisma.vendorSuggestion.count({ where: { product: { shopId: id }, suggestedVendor: { not: null } } }),
    prisma.vendorSuggestion.count({ where: { product: { shopId: id, currentVendor: { in: ['Dubailist.com','Unknown','Generic','No Vendor','N/A',''] } } } }),
    prisma.vendorSuggestion.count({ where: { product: { shopId: id }, status: 'ALREADY_CORRECT' } }),
    prisma.vendorSuggestion.count({ where: { product: { shopId: id }, status: { in: ['REVIEW_REQUIRED','REVIEW_RECOMMENDED','CONFLICT','NO_VENDOR_FOUND'] } } }),
    prisma.vendorSuggestion.count({ where: { product: { shopId: id }, approved: true, status: 'HIGH_CONFIDENCE' } }),
    prisma.vendorSuggestion.count({ where: { product: { shopId: id }, status: 'UPDATED' } }),
    prisma.updateRecord.count({ where: { updateJob: { shopId: id }, result: 'FAILED' } }),
  ]);
  res.json({ totalProducts: total, syncedProducts: total, productsScanned: scanned, vendorsDetected: detected, genericVendorProducts: generic, alreadyCorrect: correct, reviewRequired: review, readyToUpdate: ready, updated, failed });
});

apiRouter.post('/products/sync', async (req, res) => res.status(202).json({ queued: true, ...(await startSyncJob(shopId(req))) }));

apiRouter.get('/products', async (req, res) => {
  const id = shopId(req);
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = [25,50,100].includes(Number(req.query.pageSize)) ? Number(req.query.pageSize) : 25;
  const q = String(req.query.q || '').trim();
  const status = String(req.query.status || '').trim();
  const where = {
    shopId: id,
    ...(q ? { OR: [{ title: { contains: q } }, { handle: { contains: q } }, { currentVendor: { contains: q } }, { suggestion: { suggestedVendor: { contains: q } } }] } : {}),
    ...(status ? { suggestion: { status } } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.product.findMany({ where, include: { suggestion: true }, skip: (page - 1) * pageSize, take: pageSize, orderBy: { title: 'asc' } }),
    prisma.product.count({ where }),
  ]);
  res.json({ items, total, page, pageSize });
});

apiRouter.post('/vendors/scan', async (req, res) => res.status(202).json({ queued: true, ...(await startVendorScan(shopId(req))) }));

apiRouter.patch('/vendors/suggestions/:id', async (req, res) => {
  const body = z.object({ suggestedVendor: z.string().trim().min(1).max(255), saveRule: z.boolean().optional() }).parse(req.body);
  const suggestion = await prisma.vendorSuggestion.findFirstOrThrow({ where: { id: req.params.id, product: { shopId: shopId(req) } }, include: { product: true } });
  const updated = await prisma.vendorSuggestion.update({
    where: { id: suggestion.id },
    data: { suggestedVendor: body.suggestedVendor, confidence: 100, reason: 'Manual merchant correction', source: 'manual', status: 'HIGH_CONFIDENCE', manual: true, approved: false, rejected: false },
  });
  if (body.saveRule) {
    await prisma.vendorRule.create({
      data: { shopId: shopId(req), name: `Manual: ${body.suggestedVendor}`, matchType: 'Exact', matchValue: suggestion.product.title, vendor: body.suggestedVendor, priority: 1000 },
    });
  }
  res.json(updated);
});

apiRouter.post('/vendors/approve', async (req, res) => {
  const body = z.object({ ids: z.array(z.string()).min(1), approved: z.boolean().default(true) }).parse(req.body);
  const result = await prisma.vendorSuggestion.updateMany({
    where: { id: { in: body.ids }, product: { shopId: shopId(req) }, status: { notIn: ['CONFLICT','NO_VENDOR_FOUND','ALREADY_CORRECT'] } },
    data: { approved: body.approved, rejected: !body.approved },
  });
  res.json({ count: result.count });
});

apiRouter.post('/vendors/update', async (req, res) => {
  const body = z.object({ productIds: z.array(z.string()).min(1), confirmed: z.literal(true) }).parse(req.body);
  res.status(202).json({ queued: true, ...(await startUpdateJob(shopId(req), body.productIds)) });
});

apiRouter.get('/jobs/:id', async (req, res) => {
  const id = shopId(req);
  const job = await prisma.scanJob.findFirst({ where: { id: req.params.id, shopId: id } }) ?? await prisma.updateJob.findFirst({ where: { id: req.params.id, shopId: id } });
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ ...job, remaining: Math.max(0, job.total - job.processed), percentage: job.total ? Math.round(job.processed / job.total * 100) : 0 });
});

apiRouter.get('/history', async (req, res) => {
  res.json(await prisma.updateJob.findMany({ where: { shopId: shopId(req) }, include: { records: true }, orderBy: { createdAt: 'desc' }, take: 100 }));
});

apiRouter.post('/history/:jobId/undo', async (req, res) => {
  res.status(202).json({ queued: true, ...(await startUndoJob(shopId(req), req.params.jobId)) });
});

apiRouter.get('/vendor-rules', async (req, res) => res.json(await prisma.vendorRule.findMany({ where: { shopId: shopId(req) }, orderBy: { priority: 'desc' } })));
apiRouter.post('/vendor-rules', async (req, res) => {
  const body = z.object({ name:z.string().min(1), matchType:z.enum(['Contains','Starts With','Exact','Regex','Alias']), matchValue:z.string().min(1), vendor:z.string().min(1), priority:z.number().int().default(100), enabled:z.boolean().default(true) }).parse(req.body);
  res.status(201).json(await prisma.vendorRule.create({ data: { shopId: shopId(req), ...body } }));
});
apiRouter.patch('/vendor-rules/:id', async (req, res) => {
  const existing = await prisma.vendorRule.findFirstOrThrow({ where: { id: req.params.id, shopId: shopId(req) } });
  const body = z.object({ name:z.string().min(1).optional(), matchType:z.enum(['Contains','Starts With','Exact','Regex','Alias']).optional(), matchValue:z.string().min(1).optional(), vendor:z.string().min(1).optional(), priority:z.number().int().optional(), enabled:z.boolean().optional() }).parse(req.body);
  res.json(await prisma.vendorRule.update({ where: { id: existing.id }, data: body }));
});
apiRouter.delete('/vendor-rules/:id', async (req, res) => {
  const existing = await prisma.vendorRule.findFirstOrThrow({ where: { id: req.params.id, shopId: shopId(req) } });
  await prisma.vendorRule.delete({ where: { id: existing.id } });
  res.status(204).end();
});

apiRouter.get('/vendor-aliases', async (req, res) => res.json(await prisma.vendorAlias.findMany({ where: { shopId: shopId(req) }, orderBy: { alias: 'asc' } })));
apiRouter.post('/vendor-aliases', async (req, res) => {
  const body = z.object({ alias:z.string().trim().min(1).max(255), vendor:z.string().trim().min(1).max(255) }).parse(req.body);
  res.status(201).json(await prisma.vendorAlias.create({ data: { shopId: shopId(req), ...body } }));
});
apiRouter.patch('/vendor-aliases/:id', async (req, res) => {
  const existing = await prisma.vendorAlias.findFirstOrThrow({ where: { id: req.params.id, shopId: shopId(req) } });
  const body = z.object({ alias:z.string().trim().min(1).max(255).optional(), vendor:z.string().trim().min(1).max(255).optional() }).parse(req.body);
  res.json(await prisma.vendorAlias.update({ where: { id: existing.id }, data: body }));
});
apiRouter.delete('/vendor-aliases/:id', async (req, res) => {
  const existing = await prisma.vendorAlias.findFirstOrThrow({ where: { id: req.params.id, shopId: shopId(req) } });
  await prisma.vendorAlias.delete({ where: { id: existing.id } });
  res.status(204).end();
});
