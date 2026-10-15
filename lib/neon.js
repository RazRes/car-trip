import { neon } from '@neondatabase/serverless';

let sql;

export function query(text, params) {
  sql ??= neon(process.env.DATABASE_URL);
  return sql.query(text, params);
}
