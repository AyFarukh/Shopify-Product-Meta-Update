import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import unzipper from 'unzipper';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';
import type { Writable } from 'node:stream';
import { prisma } from '../lib/prisma.js';
import { detectVendor } from '../vendor-detection/vendorDetectionService.js';

export const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
const REQUIRED_COLUMNS = ['Handle', 'Title', 'Vendor'] as const;

function importDir() {
  const dir = path.join(os.tmpdir(), 'shopify-product-meta-update-imports');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function controlledCsvPath() {
  return path.join(importDir(), `${crypto.randomUUID()}.csv`);
}

async function copyWithLimit(readable: NodeJS.ReadableStream, targetPath: string, declaredSize?: number) {
  if (declaredSize && declaredSize > MAX_UPLOAD_BYTES) throw new Error('CSV inside ZIP exceeds the 250 MB limit');
  let total = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > MAX_UPLOAD_BYTES) return callback(new Error('Extracted CSV exceeds the 250 MB limit'));
      callback(null, chunk);
    },
  });
  await pipeline(readable, limiter, fs.createWriteStream(targetPath, { flags: 'wx' }));
}

export async function readCsvHeader(csvPath: string): Promise<string[]> {
  const parser = fs.createReadStream(csvPath).pipe(parse({ bom: true, to_line: 1, relax_column_count: false }));
  for await (const record of parser) {
    const headers = (record as string[]).map((value) => String(value).trim());
    const missing = REQUIRED_COLUMNS.filter((column) => !headers.includes(column));
    if (missing.length) throw new Error(`Missing required CSV column(s): ${missing.join(', ')}`);
    return headers;
  }
  throw new Error('CSV file is empty');
}

export async function resolveShopifyCsv(uploadPath: string, originalName: string): Promise<string> {
  const lower = originalName.toLowerCase();
  if (lower.endsWith('.csv')) {
    await readCsvHeader(uploadPath);
    return uploadPath;
  }
  if (!lower.endsWith('.zip')) throw new Error('Only .zip and .csv files are supported');

  let directory: unzipper.ParseStream | undefined;
  try {
    directory = fs.createReadStream(uploadPath).pipe(unzipper.Parse({ forceStream: true }));
    const candidates: string[] = [];

    for await (const entry of directory) {
      const entryPath = String(entry.path || '');
      const normalized = path.posix.normalize(entryPath.replaceAll('\\', '/'));
      const unsafe = normalized.startsWith('../') || normalized.includes('/../') || path.posix.isAbsolute(normalized) || entryPath.includes('\0');
      if (unsafe) {
        entry.autodrain();
        throw new Error('ZIP contains an unsafe entry path');
      }

      if (entry.type !== 'File' || !normalized.toLowerCase().endsWith('.csv')) {
        entry.autodrain();
        continue;
      }

      const target = controlledCsvPath();
      const declaredSize = Number(entry.vars?.uncompressedSize || 0);
      try {
        await copyWithLimit(entry, target, declaredSize);
        candidates.push(target);
      } catch (error) {
        fs.rmSync(target, { force: true });
        throw error;
      }
    }

    if (!candidates.length) throw new Error('ZIP does not contain a CSV file');

    let lastValidationError: Error | null = null;
    for (const candidate of candidates) {
      try {
        await readCsvHeader(candidate);
        for (const other of candidates) if (other !== candidate) fs.rmSync(other, { force: true });
        return candidate;
      } catch (error) {
        lastValidationError = error as Error;
      }
    }

    for (const candidate of candidates) fs.rmSync(candidate, { force: true });
    throw lastValidationError ?? new Error('No valid Shopify product CSV found in ZIP');
  } catch (error) {
    if (directory) directory.destroy();
    throw new Error(`Invalid ZIP/CSV upload: ${(error as Error).message}`);
  }
}

type ParsedRow = Record<string, string>;

export async function importCsvToBatch(params: {
  csvPath: string;
  originalFileName: string;
  shopId?: string;
}) {
  await readCsvHeader(params.csvPath);

  const batch = await prisma.importBatch.create({
    data: {
      shopId: params.shopId,
      originalFileName: params.originalFileName,
      accessKey: crypto.randomBytes(32).toString('hex'),
      csvPath: params.csvPath,
      status: 'PROCESSING',
    },
  });

  let totalRows = 0;
  let duplicateRows = 0;

  try {
    const parser = fs.createReadStream(params.csvPath).pipe(parse({
      bom: true,
      columns: true,
      skip_empty_lines: true,
      relax_column_count: false,
      trim: false,
    }));

    for await (const raw of parser) {
      totalRows++;
      const row = raw as ParsedRow;
      const handle = String(row.Handle ?? '').trim();
      const title = String(row.Title ?? '').trim();
      const vendor = String(row.Vendor ?? '').trim();
      if (!handle) throw new Error(`Row ${totalRows + 1}: Handle is required`);

      const existing = await prisma.importProduct.findUnique({
        where: { importBatchId_handle: { importBatchId: batch.id, handle } },
      });

      if (existing) {
        duplicateRows++;
        if ((!existing.title && title) || (!existing.currentVendor && vendor)) {
          await prisma.importProduct.update({
            where: { id: existing.id },
            data: {
              ...(existing.title ? {} : { title }),
              ...(existing.currentVendor ? {} : { currentVendor: vendor }),
            },
          });
        }
        continue;
      }

      await prisma.importProduct.create({
        data: {
          importBatchId: batch.id,
          handle,
          title,
          currentVendor: vendor,
          confidence: 0,
          reason: 'Pending title analysis',
          source: 'pending',
          status: 'PENDING',
        },
      });
    }

    const emptyTitle = await prisma.importProduct.findFirst({ where: { importBatchId: batch.id, title: '' } });
    if (emptyTitle) throw new Error(`Product with handle "${emptyTitle.handle}" has no Title value in any CSV row`);

    const [rules, aliases, existingVendors] = params.shopId ? await Promise.all([
      prisma.vendorRule.findMany({ where: { shopId: params.shopId, enabled: true } }),
      prisma.vendorAlias.findMany({ where: { shopId: params.shopId } }),
      prisma.product.findMany({ where: { shopId: params.shopId }, distinct: ['currentVendor'], select: { currentVendor: true } }),
    ]) : [[], [], []];

    const aliasMap = Object.fromEntries(aliases.map((item) => [item.alias, item.vendor]));
    let cursor: string | undefined;

    for (;;) {
      const products = await prisma.importProduct.findMany({
        where: { importBatchId: batch.id },
        orderBy: { id: 'asc' },
        take: 250,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!products.length) break;

      for (const product of products) {
        const detected = detectVendor(product.title, product.currentVendor, {
          aliases: aliasMap,
          existingVendors: existingVendors.map((item) => item.currentVendor),
          rules: rules.map((rule) => ({
            matchType: rule.matchType as 'Contains' | 'Starts With' | 'Exact' | 'Regex' | 'Alias',
            matchValue: rule.matchValue,
            vendor: rule.vendor,
            priority: rule.priority,
            enabled: rule.enabled,
          })),
        });

        let matchedProductId: string | undefined;
        let shopifyGid: string | undefined;
        if (params.shopId) {
          const matched = await prisma.product.findFirst({ where: { shopId: params.shopId, handle: product.handle } });
          matchedProductId = matched?.id;
          shopifyGid = matched?.shopifyGid;
        }

        await prisma.importProduct.update({
          where: { id: product.id },
          data: {
            suggestedVendor: detected.vendor,
            confidence: detected.confidence,
            reason: detected.reason,
            source: detected.source,
            status: detected.status,
            matchedProductId,
            shopifyGid,
          },
        });
      }
      cursor = products.at(-1)!.id;
    }

    const uniqueProducts = await prisma.importProduct.count({ where: { importBatchId: batch.id } });
    return await prisma.importBatch.update({
      where: { id: batch.id },
      data: { status: 'READY', totalRows, duplicateRows, uniqueProducts },
    });
  } catch (error) {
    await prisma.importBatch.update({
      where: { id: batch.id },
      data: { status: 'FAILED', totalRows, duplicateRows, error: (error as Error).message },
    });
    throw error;
  }
}

export async function assertImportAccess(importId: string, accessKey: string | undefined) {
  if (!accessKey) throw new Error('Missing import access key');
  const batch = await prisma.importBatch.findFirst({ where: { id: importId, accessKey } });
  if (!batch) throw new Error('Import not found or access denied');
  return batch;
}

export async function writeCorrectedCsv(importId: string, accessKey: string, writable: Writable) {
  const batch = await assertImportAccess(importId, accessKey);
  const headers = await readCsvHeader(batch.csvPath);
  const parser = fs.createReadStream(batch.csvPath).pipe(parse({
    bom: true,
    columns: headers,
    from_line: 2,
    skip_empty_lines: false,
    relax_column_count: false,
  }));
  const output = stringify({ header: true, columns: headers });
  output.pipe(writable);

  let lastHandle = '';
  let lastReplacement: string | null = null;

  for await (const raw of parser) {
    const row = raw as ParsedRow;
    const handle = String(row.Handle ?? '').trim();
    if (handle !== lastHandle) {
      const product = await prisma.importProduct.findUnique({
        where: { importBatchId_handle: { importBatchId: batch.id, handle } },
      });
      lastHandle = handle;
      lastReplacement = product?.approved && product.suggestedVendor ? product.suggestedVendor : null;
    }
    if (lastReplacement) row.Vendor = lastReplacement;
    if (!output.write(row)) await new Promise<void>((resolve) => output.once('drain', resolve));
  }

  output.end();
  await new Promise<void>((resolve, reject) => {
    output.once('end', resolve);
    output.once('error', reject);
  });
}
