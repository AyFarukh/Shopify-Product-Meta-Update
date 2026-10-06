# Shopify Product Vendor Update

Embedded Shopify app for detecting Product Vendor from Product Title, reviewing suggestions, and updating **only Shopify `product.vendor`** after merchant approval.

## Stack

- Node.js
- Express
- TypeScript
- Shopify Admin GraphQL API
- Prisma
- React
- Shopify Polaris
- Vite
- SQLite locally, PostgreSQL-ready data model

## Safety rules

- Product title is read-only and is used only for detection.
- Vendor detection never blindly uses the first word.
- Multi-word brands such as Elizabeth Arden, Tom Ford, Yves Saint Laurent, Green Hill, and Shock Doctor are matched as complete brands.
- Unknown/uncertain matches stay in review instead of inventing a vendor.
- Conflicts with a valid current Shopify vendor require review.
- Shopify mutations are server-side only.
- The mutation payload contains only `id` and `vendor`.
- Title, handle, variants, price, inventory, images, tags, collections, metafields, SEO, product type, and all unrelated fields are never written.
- Every attempted vendor change stores the exact previous vendor for undo.

## Setup

```bash
npm install
cp .env.example .env
npm run prisma:generate
npm run prisma:migrate
npm run dev
```

Required Shopify scopes:

```
read_products,write_products
```

Configure the Shopify app redirect URL as:

```
https://YOUR_HOST/auth/callback
```

## Workflow

1. Install/connect the Shopify store.
2. Sync products with paginated Admin GraphQL queries.
3. Scan titles for vendor matches.
4. Review Current Vendor, Suggested Vendor, Confidence, and Status.
5. Manually correct a suggestion when needed.
6. Approve selected products.
7. Review the confirmation modal.
8. Confirm the vendor-only update.
9. Follow background job progress.
10. Review success/failure history.
11. Undo restores the exact previous vendor.

## Detection priority

1. Manual vendor rules
2. Aliases
3. Known brands, longest/multi-word match first
4. Valid existing Shopify vendor match
5. Safe title analysis
6. Manual review

Default examples include Fila, Dove, Elizabeth Arden, Tom Ford, Yves Saint Laurent, DKNY, NARS, Guerlain, Virbac, Green Hill, Shock Doctor, Adidas, Nike, Puma, Samsung, Apple, Sony, and LG.

Aliases include:

- YSL → Yves Saint Laurent
- Saint Laurent → Yves Saint Laurent

## Large catalogs

- Shopify product sync uses GraphQL pagination.
- Vendor scanning uses database cursor batches.
- Sync, scan, update, and undo are asynchronous jobs.
- Job progress exposes processed, successful, failed, remaining, and percentage.
- Shopify requests retry 429/5xx responses with exponential backoff.
- Failed items are isolated so one failure does not stop the remaining update job.

For horizontally scaled production, replace the in-process job trigger with a durable queue such as BullMQ/SQS while keeping the job tables and API contract.

## Validation

CI on `feature/vendor-title-update-app` runs:

```bash
npm install
npm run prisma:generate
npm run lint
npm run typecheck
npm test
npm run build
```

## Branch

Development branch:

```
feature/vendor-title-update-app
```

Do not merge into `main` until the app has been reviewed and tested on a Shopify development store.


## ZIP / CSV Shopify export workflow

The app can analyze Shopify product exports even when Shopify is not connected.

Supported uploads:

- Shopify product `.csv`
- `.zip` containing a Shopify product CSV
- Maximum uploaded/extracted CSV size: 250 MB

Required CSV columns:

- `Handle`
- `Title`
- `Vendor`

Processing rules:

1. ZIP entries are streamed and never extracted using their original filesystem path.
2. Unsafe ZIP paths and oversized extracted CSV files are rejected.
3. CSV is parsed as a stream.
4. Variant rows sharing the same `Handle` are grouped into one product record.
5. Vendor detection is based on `Title`, including multi-word brands.
6. The preview shows Current Vendor, Suggested Vendor, Confidence, and Status.
7. Manual corrections and bulk approval are supported.
8. In CSV-only mode, approved values can be exported as a corrected Shopify CSV while preserving the other original CSV columns.
9. With Shopify connected, approved rows are matched by Handle to a Shopify Product GID and only `product.vendor` is updated.
10. The live Shopify Vendor is read before update and stored as the exact undo/history value.

After pulling schema changes locally, run:

```bash
npm install
npm run prisma:generate
npx prisma db push
npm run dev
```

Shopify credentials are optional for CSV-only analysis. They are required only for OAuth, product sync, and applying updates to Shopify.
