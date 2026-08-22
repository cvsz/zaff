import postgres, { type Sql } from "postgres";

export type Db = Sql;

export interface CreateDbOptions {
  max?: number;
  idleTimeout?: number;
  connectTimeout?: number;
}

export function createDb(url: string, options: CreateDbOptions = {}): Db {
  return postgres(url, {
    max: options.max ?? 10,
    idle_timeout: options.idleTimeout ?? 30,
    connect_timeout: options.connectTimeout ?? 10,
    onnotice: () => {},
  });
}
