# 위임 브리프 — P1-3a 상태 트래커 (hermes 실행용)

> **먼저 `DESIGN-P1-3.md` 전체를 읽어라.** 이 브리프는 그 §2/§3/§4/§5/§6의 P1-3a 슬라이스만 실행 지시로 구체화한 것이다.
> 거버넌스 §0 절대 준수: 증거 원칙(raw만)·**원칙 0(live DB 백업 없이 쓰기 금지)**·최소 풋프린트·게이트 통과 전 다음 단계 금지.
> 위치: `/home/hermes/rpchat/app` (git root). 착수 전 `git log --oneline -1`로 HEAD=v0.0.8(3d55d6e) 확인.
> **설계 판단이 필요하거나 아래에 없는 결정이 나오면 진행 말고 PROGRESS.md에 질문만 남기고 STOP.**

범위: **상태 트래커(state tier)만.** 장면/에피소드/whole 재정의는 P1-3b/c(이번 아님). 기존 롤링 whole 동작 무변.

---

## STEP 0 — 백업 (원칙 0, 마이그레이션 전 필수)
```
cp /home/hermes/rpchat/data/rpchat.db /home/hermes/rpchat/backups/rpchat-pre-0005.db
sqlite3 /home/hermes/rpchat/backups/rpchat-pre-0005.db 'PRAGMA integrity_check;'   # ok 확인
sqlite3 /home/hermes/rpchat/data/rpchat.db "SELECT status,count(*) FROM memories GROUP BY status;"  # candidate|6 기록
```
게이트0: 백업 integrity ok + candidate|6 기록. 실패 시 STOP.

## STEP 1 — 마이그레이션 파일 (apps/server/migrations/0005_summary_tiers.sql)
파일 내용(**BEGIN/COMMIT 금지** — 러너가 파일당 1트랜잭션으로 감쌈):
```sql
ALTER TABLE summaries ADD COLUMN tier TEXT NOT NULL DEFAULT 'whole';
ALTER TABLE summaries ADD COLUMN covers_from_message_id TEXT;
ALTER TABLE summaries ADD COLUMN rolled_up_into TEXT;
CREATE INDEX IF NOT EXISTS idx_summaries_tier ON summaries(conversation_id, tier, created_at);
```
적용은 서버 부팅 시 자동(migrate()). STEP 4의 restart로 적용된다.

## STEP 2 — 서버: state 생성 (apps/server/src/prompt/templates.ts, routes/memory.ts)
### 2a. templates.ts `renderSummaryPrompt` 출력 스키마에 state 추가
현재 출력 JSON(line 118)에 `state`를 넣는다:
```
{"summary":"…8문장 이내","state":{"장소":"","시각":"","동석":"","관계":"","보류":"","신체소지":""},"memories":[…]}
```
지시문에 한 줄 추가: `state 는 현재 시점의 사실만. 모르면 빈 문자열. 6개 키 고정(장소/시각/동석/관계/보류/신체소지).`
그리고 **state를 마크다운 불릿 문자열로 변환**하는 헬퍼를 templates.ts에 추가:
```ts
export function stateToBullets(s: Record<string, string> | null): string | null {
  if (!s) return null;
  const order: Array<[string,string]> = [['장소','장소'],['시각','시각'],['동석','동석 인물'],['관계','관계·감정'],['보류','보류된 목표'],['신체소지','신체·소지']];
  const lines = order.map(([k,label]) => { const v=(s[k]??'').trim(); return v?`- ${label}: ${v}`:null; }).filter(Boolean);
  return lines.length ? lines.join('\n') : null;
}
export function renderState(bullets: string | null): string | null {
  return bullets && bullets.trim() ? `### 현재 상태\n${bullets.trim()}` : null;
}
```
### 2b. routes/memory.ts `/summarize` 핸들러: state draft 저장
`parsed`에서 `parsed.state`(객체)를 꺼내 `stateToBullets`로 변환, 있으면 summaries에 **tier='state', status='draft'** 로 INSERT (covers_until = 마지막 msg id, covers_from=null). 기존 summary INSERT는 **tier='whole'** 명시(기본값과 동일하나 명시). 트랜잭션 내에서 함께.
반환 payload에 state draft 포함(선택). memories 로직 무변.

## STEP 3 — 서버: state 주입 (apps/server/src/prompt/builder.ts)
DESIGN §4 우선순위 중 **state만** 이번에 반영:
- 기존 `summaryRow`(최신 approved) 조회를 `tier='whole'`로 한정: `WHERE conversation_id=? AND tier='whole' AND status='approved'`.
- 추가로 최신 approved `tier='state'` 1건 조회 → `stateBullets` = 그 content(이미 불릿).
- 요약 하위예산에서 **state 먼저**(cap=min(200, 남은예산)), 그 다음 whole. `renderState(stateBullets)`를 systemParts에 whole보다 **앞**에 넣는다(순서: …기억, state, whole, 로어).
- BudgetReport 섹션 note에 state 포함 여부 표기(간단히).

## STEP 4 — 타입 (apps/server/src/types.ts SummaryRow, apps/web/src/types.ts Summary)
- SummaryRow: `tier`, `covers_from_message_id`, `rolled_up_into` 추가.
- 웹 Summary: `tier?: 'scene'|'episode'|'whole'|'state'` 추가.

## STEP 5 — UI (apps/web/src/pages/ChatDrawer.tsx SummaryTab)
- summaries를 tier로 분리: `state`(최상단 카드), `whole`(기존 카드 로직). scene/episode는 이번에 없음.
- 상태 카드: content(불릿) 표시 + 기존 편집/승인/삭제 재사용. draft/approved 배지 동일.
- 생성 토스트: "요약 초안 — 상태 + 전체 + 기억 N".

---

## 게이트 (raw 필수, 전부 통과해야 커밋)
1. `npm run build --workspace apps/server` → exit 0  (node 함정: 네이티브 아님이라 무관, 단 npm ci 하면 PATH=/home/hermes/.local/bin:$PATH)
2. `npm run build --workspace apps/web` → exit 0
3. restart 후 마이그레이션 검증:
   - `systemctl --user restart rpchat`
   - `sqlite3 data/rpchat.db "SELECT name FROM schema_migrations;"` → 0005 포함
   - `sqlite3 data/rpchat.db "SELECT tier,count(*) FROM summaries GROUP BY tier;"` → 기존 1행 `whole|1`
   - `sqlite3 data/rpchat.db 'PRAGMA foreign_key_check;'` → 빈 출력
4. `curl -s localhost:8787/api/health | head -c 80` → db:ok
5. **memories 무접촉**: `sqlite3 data/rpchat.db "SELECT status,count(*) FROM memories GROUP BY status;"` → candidate|6 불변
6. `PRAGMA integrity_check;` → ok
7. (선택 권장) 임시 대화나 기존 대화에 summarize 호출 → state draft 생성 확인 → **정화**(생성된 draft DELETE), 기존 데이터 무접촉

## 통과 시
```
git add apps/server/migrations/0005_summary_tiers.sql apps/server/src/prompt/templates.ts apps/server/src/routes/memory.ts apps/server/src/prompt/builder.ts apps/server/src/types.ts apps/web/src/types.ts apps/web/src/pages/ChatDrawer.tsx
git commit -m "feat(summary): state tracker tier (P1-3a)"
git tag v0.0.9
```
PROGRESS.md에 append: 변경파일·커밋·태그, 게이트 raw(build exit/migration/health/candidate|6/integrity), 미결.

## 실패 시
`git checkout -- <파일>`; 마이그레이션이 적용됐다면 `cp /home/hermes/rpchat/backups/rpchat-pre-0005.db /home/hermes/rpchat/data/rpchat.db` 복원 후 restart. 사유를 PROGRESS.md에 기록하고 STOP.
