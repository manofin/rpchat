import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { getSetting, many, one, parseJson, run, setSetting } from '../db/index.js';
import type { ModelProfile } from '../types.js';

/** 서술 지침 입력 상한(문자). 예산 경고는 buildPrompt 섹션 note 가 따로 낸다. */
export const PROFILE_INSTRUCTION_MAX = 20000;

const profileSchema = z.object({
  model: z.string().max(200).nullable().optional(),
  temperature: z.number().min(0).max(2),
  top_p: z.number().min(0).max(1),
  max_tokens: z.number().int().min(16).max(8192),
  stop: z.array(z.string().min(1).max(40)).max(4).default([]),
  system_mode: z.enum(['system', 'merge']).default('system'),
  notes: z.string().max(500).nullable().optional(),
  // 0023 서술 지침. 생략하면 기존 값 유지(지침 필드를 모르는 구 클라이언트의 PUT 이 지침을 지우지 않게).
  instruction_enabled: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
  instruction_text: z.string().max(PROFILE_INSTRUCTION_MAX).nullable().optional(),
});

const EDITABLE_SETTINGS = ['content_policy', 'token_calibration'] as const;

export function settingsRoutes(ctx: Ctx) {
  const { db } = ctx;
  return async function plugin(app: FastifyInstance) {
    app.get('/api/profiles', async () =>
      many<ModelProfile>(db, 'SELECT * FROM model_profiles ORDER BY name').map((p) => ({ ...p, stop: parseJson<string[]>(p.stop_json, []) })),
    );

    app.put<{ Params: { name: string } }>('/api/profiles/:name', async (req, reply) => {
      const cur = one<ModelProfile>(db, 'SELECT * FROM model_profiles WHERE name = ?', req.params.name);
      const p = profileSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: p.error.flatten() });
      const d = p.data;
      const enabled = d.instruction_enabled === undefined ? undefined : (d.instruction_enabled === true || d.instruction_enabled === 1 ? 1 : 0);
      if (cur) {
        run(
          db,
          `UPDATE model_profiles SET model=?, temperature=?, top_p=?, max_tokens=?, stop_json=?, system_mode=?, notes=?,
             instruction_enabled = CASE WHEN ? THEN ? ELSE instruction_enabled END,
             instruction_text = CASE WHEN ? THEN ? ELSE instruction_text END
           WHERE name=?`,
          d.model ?? null, d.temperature, d.top_p, d.max_tokens, JSON.stringify(d.stop), d.system_mode, d.notes ?? null,
          enabled !== undefined ? 1 : 0, enabled ?? 0,
          d.instruction_text !== undefined ? 1 : 0, d.instruction_text ?? null,
          req.params.name,
        );
      } else {
        if (!/^[a-z0-9-]{2,40}$/.test(req.params.name)) return reply.code(400).send({ error: '프로필 이름은 소문자/숫자/하이픈 2~40자' });
        run(
          db,
          'INSERT INTO model_profiles (name, model, temperature, top_p, max_tokens, stop_json, system_mode, notes, instruction_enabled, instruction_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          req.params.name, d.model ?? null, d.temperature, d.top_p, d.max_tokens, JSON.stringify(d.stop), d.system_mode, d.notes ?? null,
          enabled ?? 0, d.instruction_text ?? null,
        );
      }
      const row = one<ModelProfile>(db, 'SELECT * FROM model_profiles WHERE name = ?', req.params.name)!;
      return { ...row, stop: parseJson<string[]>(row.stop_json, []) };
    });

    app.get('/api/settings', async () => {
      const out: Record<string, string> = {};
      for (const k of EDITABLE_SETTINGS) out[k] = getSetting(db, k, '');
      return out;
    });

    const settingsSchema = z.object({ content_policy: z.string().max(2000).optional(), token_calibration: z.number().min(0.3).max(4).optional() });
    app.put('/api/settings', async (req, reply) => {
      const p = settingsSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: p.error.flatten() });
      if (p.data.content_policy !== undefined) setSetting(db, 'content_policy', p.data.content_policy);
      if (p.data.token_calibration !== undefined) setSetting(db, 'token_calibration', p.data.token_calibration.toFixed(3));
      const out: Record<string, string> = {};
      for (const k of EDITABLE_SETTINGS) out[k] = getSetting(db, k, '');
      return out;
    });

    app.get<{ Querystring: { limit?: string } }>('/api/generation-log', async (req) => {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 50) || 50));
      return many(db, 'SELECT * FROM generation_log ORDER BY created_at DESC LIMIT ?', limit).map((r: any) => ({ ...r, budget: parseJson(r.budget_json, {}), budget_json: undefined }));
    });
  };
}
