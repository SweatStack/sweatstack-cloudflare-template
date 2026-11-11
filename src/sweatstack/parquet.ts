// Decodes SweatStack's Parquet timeseries (ZSTD-compressed) into plain columns.
// You should not need this file directly: use client.getActivityData() / getLongitudinalData().
//
// hyparquet is a pure-JS Parquet reader; fzstd is a pure-JS ZSTD decompressor. Both run on Workers
// without WebAssembly.

import { decompress } from "fzstd";
import { parquetMetadata, parquetRead } from "hyparquet";

const compressors = {
  ZSTD: (input: Uint8Array, outputLength: number) => decompress(input, new Uint8Array(outputLength)),
};

/**
 * Reads the given columns (or all columns) of a Parquet file. Columns the file does not have are
 * left out of the result. Values come back as hyparquet decodes them: numbers, strings, `Date` for
 * timestamps, `bigint` for 64-bit integers, and `null` for missing samples.
 */
export async function readColumns(buffer: ArrayBuffer, columns?: readonly string[]): Promise<Record<string, unknown[]>> {
  const metadata = parquetMetadata(buffer);
  const available = new Set(metadata.schema.slice(1).map((element) => element.name));
  const wanted = columns ? columns.filter((name) => available.has(name)) : [...available];
  const rows = Number(metadata.num_rows);

  const out: Record<string, unknown[]> = {};
  for (const name of wanted) out[name] = new Array<unknown>(rows).fill(null);
  if (wanted.length === 0 || rows === 0) return out;

  await parquetRead({
    file: buffer,
    metadata,
    columns: wanted,
    compressors,
    onChunk: ({ columnName, columnData, rowStart }) => {
      const column = out[columnName];
      if (!column) return;
      for (let i = 0; i < columnData.length; i++) column[rowStart + i] = columnData[i];
    },
  });
  return out;
}

/** Milliseconds since the epoch for a decoded timestamp value, or null. */
export function toMillis(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

/** A finite number, or null. Converts bigint; anything else becomes null. */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  return null;
}
