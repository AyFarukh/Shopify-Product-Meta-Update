import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import yazl from 'yazl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../server/lib/prisma.js';
import {
  importCsvToBatch,
  readCsvHeader,
  resolveShopifyCsv,
  writeCorrectedCsv,
} from '../server/services/csvImportService.js';
import { buildVendorUpdateVariables } from '../server/services/shopifyProductService.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-import-test-'));

async function makeZip(csv: string, entryName = 'products_export.csv') {
  const csvPath = path.join(tempDir, `${Date.now()}-${Math.random()}.csv`);
  const zipPath = path.join(tempDir, `${Date.now()}-${Math.random()}.zip`);
  fs.writeFileSync(csvPath, csv);
  const zip = new yazl.ZipFile();
  zip.addFile(csvPath, entryName);
  zip.end();
  zip.outputStream.pipe(fs.createWriteStream(zipPath));
  await once(zip.outputStream, 'end');
  return zipPath;
}

beforeAll(async () => {
  await prisma.importProduct.deleteMany();
  await prisma.importBatch.deleteMany();
});

afterAll(async () => {
  await prisma.importProduct.deleteMany();
  await prisma.importBatch.deleteMany();
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Shopify ZIP/CSV import pipeline', () => {
  it('extracts ZIP, groups duplicate Handle rows, detects vendors from title, previews, and exports corrected CSV', async () => {
    const csv = [
      'Handle,Title,Vendor,Variant SKU',
      'fila-jogger,SIZE XS - Fila Women French Terry Jogger,Dubailist.com,FILA-XS',
      'fila-jogger,,,FILA-S',
      'elizabeth-foundation,Elizabeth Arden Flawless Finish Foundation,Unknown,EA-1',
      'tom-ford-blush,Tom Ford Cream Blush,Unknown,TF-1',
      'ysl-lipstick,YSL Yves Saint Laurent Slim Velvet Lipstick,Unknown,YSL-1',
      'green-hill-gloves,Green Hill MMA Gloves Iron,Unknown,GH-1',
      'shock-mouthguard,Shock Doctor Adult Gel Nano Mouthguard,Unknown,SD-1',
    ].join('\n');

    const zipPath = await makeZip(csv);
    const extracted = await resolveShopifyCsv(zipPath, 'shopify-products.zip');
    expect(await readCsvHeader(extracted)).toEqual(['Handle', 'Title', 'Vendor', 'Variant SKU']);

    const batch = await importCsvToBatch({
      csvPath: extracted,
      originalFileName: 'shopify-products.zip',
    });

    expect(batch.totalRows).toBe(7);
    expect(batch.uniqueProducts).toBe(6);
    expect(batch.duplicateRows).toBe(1);

    const products = await prisma.importProduct.findMany({
      where: { importBatchId: batch.id },
      orderBy: { handle: 'asc' },
    });
    const byHandle = Object.fromEntries(products.map((product) => [product.handle, product]));

    expect(byHandle['fila-jogger'].suggestedVendor).toBe('Fila');
    expect(byHandle['elizabeth-foundation'].suggestedVendor).toBe('Elizabeth Arden');
    expect(byHandle['tom-ford-blush'].suggestedVendor).toBe('Tom Ford');
    expect(byHandle['ysl-lipstick'].suggestedVendor).toBe('Yves Saint Laurent');
    expect(byHandle['green-hill-gloves'].suggestedVendor).toBe('Green Hill');
    expect(byHandle['shock-mouthguard'].suggestedVendor).toBe('Shock Doctor');
    expect(byHandle['fila-jogger'].confidence).toBeGreaterThanOrEqual(90);

    await prisma.importProduct.update({
      where: { id: byHandle['fila-jogger'].id },
      data: { approved: true },
    });

    const sink = new PassThrough();
    let exported = '';
    sink.setEncoding('utf8');
    sink.on('data', (chunk) => { exported += chunk; });
    const finished = once(sink, 'end');
    await writeCorrectedCsv(batch.id, batch.accessKey, sink);
    sink.end();
    await finished;

    const filaRows = exported.split(/\r?\n/).filter((line) => line.startsWith('fila-jogger,'));
    expect(filaRows).toHaveLength(2);
    expect(filaRows.every((line) => line.includes(',Fila,'))).toBe(true);
  });

  it('rejects a CSV missing required Handle/Title columns', async () => {
    const csvPath = path.join(tempDir, 'invalid-columns.csv');
    fs.writeFileSync(csvPath, 'Vendor,Variant SKU\nFila,SKU-1\n');
    await expect(readCsvHeader(csvPath)).rejects.toThrow(/Missing required CSV column/);
  });

  it('rejects an invalid ZIP', async () => {
    const fakeZip = path.join(tempDir, 'invalid.zip');
    fs.writeFileSync(fakeZip, 'not a zip file');
    await expect(resolveShopifyCsv(fakeZip, 'invalid.zip')).rejects.toThrow(/Invalid ZIP\/CSV upload/);
  });

  it('builds a Shopify mutation payload containing only id and vendor', () => {
    const variables = buildVendorUpdateVariables('gid://shopify/Product/123', 'Tom Ford');
    expect(variables).toEqual({
      product: {
        id: 'gid://shopify/Product/123',
        vendor: 'Tom Ford',
      },
    });
    expect(Object.keys(variables.product).sort()).toEqual(['id', 'vendor']);
  });
});
