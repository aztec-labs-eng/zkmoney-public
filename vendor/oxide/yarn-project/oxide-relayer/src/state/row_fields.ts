export type Row = Record<string, unknown>;

export function stringField(row: Row, key: string): string;
export function stringField(row: Row, key: string, opts: { optional: true }): string | undefined;
export function stringField(row: Row, key: string, opts?: { optional: true }): string | undefined {
  const value = row[key];
  if (opts?.optional && (value === null || value === undefined)) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`sqlite row field ${key} is not a string.`);
  }
  return value;
}

export function numberField(row: Row, key: string): number;
export function numberField(row: Row, key: string, opts: { optional: true }): number | undefined;
export function numberField(row: Row, key: string, opts?: { optional: true }): number | undefined {
  const value = row[key];
  if (opts?.optional && (value === null || value === undefined)) {
    return undefined;
  }
  if (typeof value !== 'number') {
    throw new Error(`sqlite row field ${key} is not a number.`);
  }
  return value;
}

export function dateField(row: Row, key: string): Date;
export function dateField(row: Row, key: string, opts: { optional: true }): Date | undefined;
export function dateField(row: Row, key: string, opts?: { optional: true }): Date | undefined {
  if (opts?.optional) {
    const value = stringField(row, key, { optional: true });
    return value ? new Date(value) : undefined;
  }
  return new Date(stringField(row, key));
}
