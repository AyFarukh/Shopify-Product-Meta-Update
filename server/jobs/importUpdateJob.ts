import { prisma } from '../lib/prisma.js';
import { findProductByHandle, updateProductVendor } from '../services/shopifyProductService.js';

export async function startImportUpdateJob(shopId: string, importBatchId: string, importProductIds?: string[]) {
  const where = {
    importBatchId,
    approved: true,
    ...(importProductIds?.length ? { id: { in: importProductIds } } : {}),
  };
  const total = await prisma.importProduct.count({ where });
  if (!total) throw new Error('No approved import products selected');

  const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: importBatchId } });
  if (batch.shopId && batch.shopId !== shopId) throw new Error('Import belongs to a different Shopify store');
  if (!batch.shopId) await prisma.importBatch.update({ where: { id: batch.id }, data: { shopId } });

  const job = await prisma.updateJob.create({
    data: { shopId, type: 'CSV_IMPORT_UPDATE', status: 'QUEUED', total },
  });
  queueMicrotask(() => void runImportUpdateJob(job.id, shopId, importBatchId, importProductIds));
  return { jobId: job.id };
}

async function runImportUpdateJob(jobId: string, shopId: string, importBatchId: string, importProductIds?: string[]) {
  await prisma.updateJob.update({ where: { id: jobId }, data: { status: 'RUNNING', startedAt: new Date() } });
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  let processed = 0;
  let successful = 0;
  let failed = 0;
  let cursor: string | undefined;

  try {
    for (;;) {
      const imported = await prisma.importProduct.findMany({
        where: {
          importBatchId,
          approved: true,
          ...(importProductIds?.length ? { id: { in: importProductIds } } : {}),
        },
        orderBy: { id: 'asc' },
        take: 100,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!imported.length) break;

      for (const item of imported) {
        try {
          if (!item.suggestedVendor) throw new Error('Suggested Vendor is empty');
          if (['CONFLICT', 'NO_VENDOR_FOUND', 'REVIEW_REQUIRED'].includes(item.status) && !item.manual) {
            throw new Error('Product requires manual review before Shopify update');
          }

          const remote = await findProductByHandle(
            { shop: shop.shopDomain, accessToken: shop.accessToken },
            item.handle,
          );
          if (!remote) throw new Error(`Shopify product not found for handle: ${item.handle}`);

          const localProduct = await prisma.product.upsert({
            where: { shopId_shopifyGid: { shopId, shopifyGid: remote.id } },
            update: {
              handle: remote.handle,
              title: remote.title,
              currentVendor: remote.vendor,
              productType: remote.productType,
              status: remote.status,
              shopifyUpdatedAt: new Date(remote.updatedAt),
            },
            create: {
              shopId,
              shopifyGid: remote.id,
              handle: remote.handle,
              title: remote.title,
              currentVendor: remote.vendor,
              productType: remote.productType,
              status: remote.status,
              shopifyUpdatedAt: new Date(remote.updatedAt),
            },
          });

          await prisma.importProduct.update({
            where: { id: item.id },
            data: { shopifyGid: remote.id, matchedProductId: localProduct.id },
          });

          const newVendor = item.suggestedVendor.trim();
          if (remote.vendor === newVendor) {
            await prisma.importProduct.update({ where: { id: item.id }, data: { status: 'ALREADY_CORRECT' } });
            successful++;
            processed++;
            await prisma.updateJob.update({ where: { id: jobId }, data: { processed, successful, failed } });
            continue;
          }

          const record = await prisma.updateRecord.create({
            data: {
              updateJobId: jobId,
              productId: localProduct.id,
              productGid: remote.id,
              productTitle: remote.title,
              previousVendor: remote.vendor,
              newVendor,
              result: 'PENDING',
            },
          });

          try {
            await updateProductVendor(
              { shop: shop.shopDomain, accessToken: shop.accessToken },
              remote.id,
              newVendor,
            );
            await prisma.$transaction([
              prisma.updateRecord.update({ where: { id: record.id }, data: { result: 'SUCCESS' } }),
              prisma.product.update({ where: { id: localProduct.id }, data: { currentVendor: newVendor } }),
              prisma.importProduct.update({ where: { id: item.id }, data: { status: 'UPDATED' } }),
            ]);
            successful++;
          } catch (error) {
            await prisma.updateRecord.update({
              where: { id: record.id },
              data: { result: 'FAILED', error: String(error) },
            });
            await prisma.importProduct.update({ where: { id: item.id }, data: { status: 'FAILED' } });
            failed++;
          }
        } catch {
          failed++;
        }

        processed++;
        await prisma.updateJob.update({ where: { id: jobId }, data: { processed, successful, failed } });
      }

      cursor = imported.at(-1)!.id;
    }

    await prisma.updateJob.update({
      where: { id: jobId },
      data: {
        status: failed && successful === 0 ? 'FAILED' : 'COMPLETED',
        processed,
        successful,
        failed,
        finishedAt: new Date(),
      },
    });
  } catch (error) {
    await prisma.updateJob.update({
      where: { id: jobId },
      data: { status: 'FAILED', error: String(error), finishedAt: new Date() },
    });
  }
}
