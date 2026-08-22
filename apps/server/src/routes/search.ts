import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many } from '../db/index.js';
import type { Ctx } from '../ctx.js';

const querySchema = z.object({
  q: z.string().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

interface Row {
  message_id: string;
  conversation_id: string;
  role: string;
  snippet: string;
  conv_title: string;
  character_name: string;
  bookmarked: number;
  created_at: string;
}

function out(r: Row) {
  return {
    messageId: r.message_id,
    conversationId: r.conversation_id,
    conversationTitle: r.conv_title,
    characterName: r.character_name,
    role: r.role,
    snippet: r.snippet,
    bookmarked: !!r.bookmarked,
    createdAt: r.created_at,
  };
}

const FTS_SQL = `
  SELECT f.message_id, f.conversation_id, f.role,
         snippet(message_fts, 3, '«', '»', '…', 12) AS snippet,
         v.title AS conv_title, c.name AS character_name,
         m.bookmarked, m.created_at
  FROM message_fts f
  JOIN messages m ON m.id = f.message_id
  JOIN conversations v ON v.id = f.conversation_id
  JOIN characters c ON c.id = v.character_id
  WHERE message_fts MATCH ?
  ORDER BY m.created_at DESC LIMIT ?`;

const LIKE_SQL = `
  SELECT m.id AS message_id, m.conversation_id, m.role,
         substr(m.content, max(1, instr(m.content, ?) - 40), 120) || '…' AS snippet,
         v.title AS conv_title, c.name AS character_name,
         m.bookmarked, m.created_at
  FROM messages m
  JOIN conversations v ON v.id = m.conversation_id
  JOIN characters c ON c.id = v.character_id
  WHERE instr(m.content, ?) > 0
  ORDER BY m.created_at DESC LIMIT ?`;

export function searchRoutes(ctx: Ctx) {
  const { db } = ctx;
  return async function plugin(app: FastifyInstance) {
    // GET /api/search?q= — 메시지 본문 검색. FTS5(trigram), 짧은 질의는 LIKE 폴백.
    app.get<{ Querystring: Record<string, unknown> }>('/api/search', async (req) => {
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) return { results: [], error: 'bad_query' };
      const { q, limit } = parsed.data;

      try {
        // trigram 토크나이저는 3문자 이상부터 매치(실측) → 3문자 미만은 LIKE 폴백
        if ([...q].length < 3) {
          return { results: many<Row>(db, LIKE_SQL, q, q, limit).map(out) };
        }
        const match = '"' + q.replaceAll('"', '""') + '"';
        return { results: many<Row>(db, FTS_SQL, match, limit).map(out) };
      } catch {
        return { results: many<Row>(db, LIKE_SQL, q, q, limit).map(out) };
      }
    });
  };
}
