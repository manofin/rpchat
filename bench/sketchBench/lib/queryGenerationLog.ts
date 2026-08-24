/**
 * hermes-only generation_log reader/deleter (better-sqlite3, Node ABI 127 / v22).
 * Never tar this file to Mac /tmp. Mac invokes it over SSH:
 *   ssh rpchat 'PATH=/home/hermes/.local/bin:$PATH npx tsx bench/sketchBench/lib/queryGenerationLog.ts --conv <id> --mode read'
 *
 * Usage: --mode read|delete --conv <id> [--db /home/hermes/rpchat/data/rpchat.db]
 * stdout: JSON only.
 */
import Database from 'better-sqlite3';

const DEFAULT_DB = '/home/hermes/rpchat/data/rpchat.db';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return undefined;
  return process.argv[i + 1];
}

type LogRow = {
  ttft_ms: number | null;
  total_ms: number | null;
  completion_tokens: number | null;
  status: string;
  created_at: string | number | null;
};

function main() {
  const mode = arg('--mode');
  const conv = arg('--conv');
  const dbPath = arg('--db') ?? DEFAULT_DB;
  if (mode !== 'read' && mode !== 'delete') {
    console.error('usage: queryGenerationLog.ts --mode read|delete --conv <id> [--db path]');
    process.exit(2);
  }
  if (!conv) {
    console.error('missing --conv');
    process.exit(2);
  }

  if (mode === 'read') {
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(
      `SELECT ttft_ms, total_ms, completion_tokens, status, created_at
       FROM generation_log WHERE conversation_id = ? ORDER BY created_at ASC`,
    ).all(conv) as LogRow[];
    db.close();
    process.stdout.write(JSON.stringify({ conv, n: rows.length, rows }) + '\n');
    return;
  }

  const db = new Database(dbPath);
  const info = db.prepare('DELETE FROM generation_log WHERE conversation_id = ?').run(conv);
  db.close();
  process.stdout.write(JSON.stringify({ conv, deleted: info.changes }) + '\n');
}

main();
