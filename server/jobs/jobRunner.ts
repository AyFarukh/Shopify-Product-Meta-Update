import { prisma } from '../lib/prisma.js';
import { detectVendor } from '../vendor-detection/vendorDetectionService.js';
import { fetchProductsPage, updateProductVendor } from '../services/shopifyProductService.js';

const SCAN_BATCH_SIZE = 200;

type JobId = { jobId: string };

export async function startSyncJob(shopId: string): Promise<JobId> {
  const job = await prisma.scanJob.create({ data: { shopId, type: 'SYNC', status: 'QUEUED' } });
  queueMicrotask(() => void runSyncJob(job.id, shopId));
  return { jobId: job.id };
}

async function runSyncJob(jobId: string, shopId: string) {
  await prisma.scanJob.update({ where: { id: jobId }, data: { status: 'RUNNING', startedAt: new Date() } });
  try {
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
    let after: string | null = null;
    let processed = 0;
    let successful = 0;
    let failed = 0;

    do {
      const page = await fetchProductsPage({ shop: shop.shopDomain, accessToken: shop.accessToken }, after);
      for (const p of page.nodes) {
        try {
          await prisma.product.upsert({
            where: { shopId_shopifyGid: { shopId, shopifyGid: p.id } },
            update: {
              handle: p.handle,
              title: p.title,
              currentVendor: p.vendor,
              productType: p.productType,
              status: p.status,
              shopifyUpdatedAt: new Date(p.updatedAt),
              syncedAt: new Date(),
            },
            create: {
              shopId,
              shopifyGid: p.id,
              handle: p.handle,
              title: p.title,
              currentVendor: p.vendor,
              productType: p.productType,
              status: p.status,
              shopifyUpdatedAt: new Date(p.updatedAt),
            },
          });
          successful++;
        } catch {
          failed++;
        }
        processed++;
      }

      await prisma.scanJob.update({
        where: { id: jobId },
        data: { processed, successful, failed, total: processed },
      });
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);

    await prisma.scanJob.update({
      where: { id: jobId },
      data: { status: 'COMPLETED', finishedAt: new Date(), total: processed, processed, successful, failed },
    });
  } catch (error) {
    await prisma.scanJob.update({
      where: { id: jobId },
      data: { status: 'FAILED', error: String(error), finishedAt: new Date() },
    });
  }
}

export async function startVendorScan(shopId: string): Promise<JobId> {
  const total = await prisma.product.count({ where: { shopId } });
  const job = await prisma.scanJob.create({ data: { shopId, type: 'SCAN', status: 'QUEUED', total } });
  queueMicrotask(() => void runVendorScan(job.id, shopId));
  return { jobId: job.id };
}

async function runVendorScan(jobId: string, shopId: string) {
  await prisma.scanJob.update({ where: { id: jobId }, data: { status: 'RUNNING', startedAt: new Date() } });
  try {
    const [rules, aliases, existing, settings] = await Promise.all([
      prisma.vendorRule.findMany({ where: { shopId, enabled: true } }),
      prisma.vendorAlias.findMany({ where: { shopId } }),
      prisma.product.findMany({ where: { shopId }, distinct: ['currentVendor'], select: { currentVendor: true } }),
      prisma.appSettings.findUnique({ where: { shopId } }),
    ]);
    const aliasMap = Object.fromEntries(aliases.map((a) => [a.alias, a.vendor]));
    const generic = settings ? (JSON.parse(settings.genericVendorsJson) as string[]) : undefined;
    const ruleInputs = rules.map((x) => ({
      matchType: x.matchType as 'Contains' | 'Starts With' | 'Exact' | 'Regex' | 'Alias',
      matchValue: x.matchValue,
      vendor: x.vendor,
      priority: x.priority,
      enabled: x.enabled,
    }));

    let processed = 0;
    let successful = 0;
    let failed = 0;
    let cursor: string | undefined;

    for (;;) {
      const products = await prisma.product.findMany({
        where: { shopId },
        orderBy: { id: 'asc' },
        take: SCAN_BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!products.length) break;

      for (const product of products) {
        try {
          const result = detectVendor(product.title, product.currentVendor, {
            rules: ruleInputs,
            aliases: aliasMap,
            existingVendors: existing.map((x) => x.currentVendor),
            genericVendors: generic,
          });
          await prisma.vendorSuggestion.upsert({
            where: { productId: product.id },
            update: {
              suggestedVendor: result.vendor,
              confidence: result.confidence,
              reason: result.reason,
              source: result.source,
              status: result.status,
              approved: false,
              rejected: false,
              manual: false,
            },
            create: {
              productId: product.id,
              suggestedVendor: result.vendor,
              confidence: result.confidence,
              reason: result.reason,
              source: result.source,
              status: result.status,
            },
          });
          successful++;
        } catch {
          failed++;
        }
        processed++;
      }

      cursor = products.at(-1)!.id;
      await prisma.scanJob.update({ where: { id: jobId }, data: { processed, successful, failed } });
    }

    await prisma.scanJob.update({
      where: { id: jobId },
      data: { status: 'COMPLETED', processed, successful, failed, finishedAt: new Date() },
    });
  } catch (error) {
    await prisma.scanJob.update({
      where: { id: jobId },
      data: { status: 'FAILED', error: String(error), finishedAt: new Date() },
    });
  }
}

export async function startUpdateJob(shopId: string, productIds: string[]): Promise<JobId> {
  const uniqueProductIds = [...new Set(productIds)];
  const job = await prisma.updateJob.create({
    data: { shopId, type: 'UPDATE', status: 'QUEUED', total: uniqueProductIds.length },
  });
  queueMicrotask(() => void runUpdateJob(job.id, shopId, uniqueProductIds));
  return { jobId: job.id };
}

async function runUpdateJob(jobId: string, shopId: string, productIds: string[]) {
  await prisma.updateJob.update({ where: { id: jobId }, data: { status: 'RUNNING', startedAt: new Date() } });
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  let processed = 0;
  let successful = 0;
  let failed = 0;

  for (const productId of productIds) {
    const product = await prisma.product.findFirst({
      where: { id: productId, shopId },
      include: { suggestion: true },
    });
    const suggestion = product?.suggestion;

    if (
      !product ||
      !suggestion?.approved ||
      !suggestion.suggestedVendor ||
      ['CONFLICT', 'NO_VENDOR_FOUND', 'ALREADY_CORRECT'].includes(suggestion.status)
    ) {
      processed++;
      failed++;
      await prisma.updateJob.update({ where: { id: jobId }, data: { processed, successful, failed } });
      continue;
    }

    const newVendor = suggestion.suggestedVendor.trim();
    if (product.currentVendor === newVendor) {
      processed++;
      successful++;
      await prisma.vendorSuggestion.update({ where: { productId: product.id }, data: { status: 'ALREADY_CORRECT' } });
      await prisma.updateJob.update({ where: { id: jobId }, data: { processed, successful, failed } });
      continue;
    }

    const record = await prisma.updateRecord.create({
      data: {
        updateJobId: jobId,
        productId: product.id,
        productGid: product.shopifyGid,
        productTitle: product.title,
        previousVendor: product.currentVendor,
        newVendor,
        result: 'PENDING',
      },
    });

    try {
      await updateProductVendor({ shop: shop.shopDomain, accessToken: shop.accessToken }, product.shopifyGid, newVendor);
      await prisma.$transaction([
        prisma.updateRecord.update({ where: { id: record.id }, data: { result: 'SUCCESS' } }),
        prisma.product.update({ where: { id: product.id }, data: { currentVendor: newVendor } }),
        prisma.vendorSuggestion.update({ where: { productId: product.id }, data: { status: 'UPDATED' } }),
      ]);
      successful++;
    } catch (error) {
      await prisma.updateRecord.update({ where: { id: record.id }, data: { result: 'FAILED', error: String(error) } });
      failed++;
    }

    processed++;
    await prisma.updateJob.update({ where: { id: jobId }, data: { processed, successful, failed } });
  }

  await prisma.updateJob.update({
    where: { id: jobId },
    data: { status: failed && successful === 0 ? 'FAILED' : 'COMPLETED', finishedAt: new Date() },
  });
}

export async function startUndoJob(shopId: string, sourceJobId: string): Promise<JobId> {
  const source = await prisma.updateJob.findFirstOrThrow({ where: { id: sourceJobId, shopId, type: 'UPDATE' } });
  const total = await prisma.updateRecord.count({
    where: { updateJobId: source.id, result: 'SUCCESS', undoneAt: null },
  });
  const job = await prisma.updateJob.create({ data: { shopId, type: 'UNDO', status: 'QUEUED', total } });
  queueMicrotask(() => void runUndoJob(job.id, shopId, source.id));
  return { jobId: job.id };
}

async function runUndoJob(jobId: string, shopId: string, sourceJobId: string) {
  await prisma.updateJob.update({ where: { id: jobId }, data: { status: 'RUNNING', startedAt: new Date() } });
  const records = await prisma.updateRecord.findMany({
    where: { updateJobId: sourceJobId, updateJob: { shopId }, result: 'SUCCESS', undoneAt: null },
    orderBy: { createdAt: 'asc' },
  });
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  let processed = 0;
  let successful = 0;
  let failed = 0;

  for (const record of records) {
    try {
      await updateProductVendor(
        { shop: shop.shopDomain, accessToken: shop.accessToken },
        record.productGid,
        record.previousVendor,
      );
      await prisma.$transaction([
        prisma.product.update({ where: { id: record.productId }, data: { currentVendor: record.previousVendor } }),
        prisma.updateRecord.update({ where: { id: record.id }, data: { undoneAt: new Date() } }),
      ]);
      successful++;
    } catch {
      failed++;
    }
    processed++;
    await prisma.updateJob.update({ where: { id: jobId }, data: { processed, successful, failed } });
  }

  await prisma.updateJob.update({
    where: { id: jobId },
    data: { status: failed && successful === 0 ? 'FAILED' : 'COMPLETED', finishedAt: new Date() },
  });
}
