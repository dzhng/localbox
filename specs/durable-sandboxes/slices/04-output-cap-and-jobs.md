# 04 Output cap and jobs

**Unlocks:** every result fits one Convex document (map Q17, L11), and long work
runs as real background jobs, which gives idle a signal (Q5; plan decision D4).
Removes Vercel Blob (seam T4).

## Seam

- `packages/contract`: `defaultLimits.max_output_bytes = 900 * 1024` (from 4 MiB,
  `packages/contract/src/index.ts:61`). One function `capResult(result)` →
  `{result, truncated?: {original_bytes, returned_bytes}}`, applied where output
  is produced (guest gateway), the same for local and remote calls.
- `fs.read` gains `offset`/`length`; `job.output` gains `offset`/`length` and
  returns `{data, offset, next_offset, eof}`.
- Real jobs in `packages/guest-gateway` (today `job.*` are stubs,
  `index.ts:144-147`): `shell.exec` with `background: true` returns `job_id`;
  jobs keep a ring-buffered on-disk log; `job.status|wait|cancel|output` work;
  cancel kills the process group. New internal read `guest.activity` →
  `{running_jobs}` for slice 12.
- Screenshots are re-encoded or scaled to fit the cap and the result says so
  (plan decision D12).
- Delete `packages/blob`, `@vercel/blob`, `tests/blob.test.ts`,
  `tests/vercel-blob.test.ts`, the externalize paths in `apps/relay/src/http.ts`
  and `packages/guest-gateway/src/service.ts`, `BLOB_*` in
  `apps/relay/api/[...path].ts` and `DEVELOPMENT.md`.

## See it

`npm run proof -- 04 --tier u,l`: a 2 MiB `fs.read` returns 900 KiB with
`truncated.original_bytes = 2097152`; paging reconstructs the exact sha256; a
background job writing 3 MiB pages fully; cancel kills the group. Tier l repeats
through fixture machine A's CLI.

## Gates

New `tests/output-cap.test.ts`, `tests/guest-jobs.test.ts`;
`tests/contract.test.ts` with regenerated snapshots; `tests/guest-gateway.test.ts`.

## Delegated

Job log location and ring size (at least 64 MiB per job), UTF-8-safe truncation
boundary, screenshot re-encode strategy.

## Feedback that would change it

A different paging shape.
