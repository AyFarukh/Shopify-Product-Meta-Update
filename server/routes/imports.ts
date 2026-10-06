import { Router } from 'express';
import type { Request } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { optionalShopifySession, requireShopifySession } from '../middleware/shopifyAuth.js';
import {
  MAX_UPLOAD_BYTES,
  assertImportAccess,
  importCsvToBatch,
  resolveShopifyCsv,
  writeCorrectedCsv,
} from '../services/csvImportService.js';
import { startImportUpdateJob } from '../jobs/importUpdateJob.js';

export const importsRouter = Router();

const uploadRoot = path.join(os.tmpdir(), 'shopify-product-meta-update-uploads');
fs.mkdirSync(uploadRoot, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadRoot),
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const lower = file.originalname.toLowerCase();
    if (!lower.endsWith('.zip') && !lower.endsWith('.csv')) return cb(new Error('Only .zip and .csv files are supported'));
    cb(null, true);
  },
});

function importKey(req: Request) {
  return String(req.header('x-import-key') || '');
}

importsRouter.get('/imports/shopify-status', optionalShopifySession, (req, res) => {
  res.json({ connected: Boolean(req.shopSession), shop: req.shopSession?.shop ?? null });
});

importsRouter.post('/imports/upload', optionalShopifySession, upload.single('file'), async (req, res, next) => {
  const uploaded = req.file;
  if (!uploaded) return res.status(400).json({ error: 'ZIP or CSV file is required' });

  let csvPath: string | null = null;
  try {
    csvPath = await resolveShopifyCsv(uploaded.path, uploaded.originalname);
    const batch = await importCsvToBatch({
      csvPath,
      originalFileName: uploaded.originalname,
      shopId: req.shopSession?.shopId,
    });
    if (uploaded.path !== csvPath) fs.rmSync(uploaded.path, { force: true });

    res.status(201).json({
      id: batch.id,
      accessKey: batch.accessKey,
      status: batch.status,
      totalRows: batch.totalRows,
      uniqueProducts: batch.uniqueProducts,
      duplicateRows: batch.duplicateRows,
      shopifyConnected: Boolean(req.shopSession),
    });
  } catch (error) {
    if (csvPath && csvPath !== uploaded.path) fs.rmSync(csvPath, { force: true });
    fs.rmSync(uploaded.path, { force: true });
    next(error);
  }
});

importsRouter.get('/imports/:id/products', async (req, res, next) => {
  try {
    const batch = await assertImportAccess(String(req.params.id), importKey(req));
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = [25, 50, 100].includes(Number(req.query.pageSize)) ? Number(req.query.pageSize) : 25;
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    const where = {
      importBatchId: batch.id,
      ...(q ? { OR: [{ title: { contains: q } }, { handle: { contains: q } }, { currentVendor: { contains: q } }, { suggestedVendor: { contains: q } }] } : {}),
      ...(status ? { status } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.importProduct.findMany({
        where,
        orderBy: { title: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.importProduct.count({ where }),
    ]);
    res.json({
      batch: {
        id: batch.id,
        originalFileName: batch.originalFileName,
        totalRows: batch.totalRows,
        uniqueProducts: batch.uniqueProducts,
        duplicateRows: batch.duplicateRows,
        status: batch.status,
      },
      items,
      total,
      page,
      pageSize,
    });
  } catch (error) {
    next(error);
  }
});

importsRouter.patch('/imports/:id/products/:productId', async (req, res, next) => {
  try {
    const batch = await assertImportAccess(String(req.params.id), importKey(req));
    const body = z.object({ suggestedVendor: z.string().trim().min(1).max(255) }).parse(req.body);
    const product = await prisma.importProduct.findFirstOrThrow({
      where: { id: String(req.params.productId), importBatchId: batch.id },
    });
    res.json(await prisma.importProduct.update({
      where: { id: product.id },
      data: {
        suggestedVendor: body.suggestedVendor,
        confidence: 100,
        reason: 'Manual correction before update/export',
        source: 'manual',
        status: 'HIGH_CONFIDENCE',
        manual: true,
        approved: false,
      },
    }));
  } catch (error) {
    next(error);
  }
});

importsRouter.post('/imports/:id/approve', async (req, res, next) => {
  try {
    const batch = await assertImportAccess(String(req.params.id), importKey(req));
    const body = z.object({
      ids: z.array(z.string()).optional(),
      allFiltered: z.boolean().optional().default(false),
      q: z.string().optional().default(''),
      status: z.string().optional().default(''),
      approved: z.boolean().optional().default(true),
    }).parse(req.body);

    if (!body.allFiltered && (!body.ids || body.ids.length === 0)) {
      return res.status(400).json({ error: 'Select products or use allFiltered' });
    }

    const where = {
      importBatchId: batch.id,
      ...(body.ids?.length && !body.allFiltered ? { id: { in: body.ids } } : {}),
      ...(body.allFiltered && body.status ? { status: body.status } : {}),
      AND: [
        ...(body.allFiltered && body.q ? [{
          OR: [
            { title: { contains: body.q } },
            { handle: { contains: body.q } },
            { currentVendor: { contains: body.q } },
            { suggestedVendor: { contains: body.q } },
          ],
        }] : []),
        {
          OR: [
            { manual: true },
            { status: { in: ['HIGH_CONFIDENCE', 'REVIEW_RECOMMENDED'] } },
          ],
        },
      ],
    };

    const result = await prisma.importProduct.updateMany({
      where,
      data: { approved: body.approved },
    });
    res.json({ count: result.count });
  } catch (error) {
    next(error);
  }
});

importsRouter.get('/imports/:id/export', async (req, res, next) => {
  try {
    const batch = await assertImportAccess(String(req.params.id), importKey(req));
    const safeName = path.basename(batch.originalFileName).replace(/\.(zip|csv)$/i, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}-corrected.csv"`);
    await writeCorrectedCsv(batch.id, batch.accessKey, res);
  } catch (error) {
    if (!res.headersSent) next(error);
    else res.destroy(error as Error);
  }
});

importsRouter.post('/imports/:id/update-shopify', requireShopifySession, async (req, res, next) => {
  try {
    const batch = await assertImportAccess(String(req.params.id), importKey(req));
    const body = z.object({
      ids: z.array(z.string()).optional(),
      confirmed: z.literal(true),
    }).parse(req.body);
    const result = await startImportUpdateJob(req.shopSession!.shopId, batch.id, body.ids);
    res.status(202).json({ queued: true, ...result });
  } catch (error) {
    next(error);
  }
});
