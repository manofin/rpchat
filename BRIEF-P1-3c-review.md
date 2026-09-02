# 위임 브리프 — P1-3c 설계 검수 (hermes, 코드 변경 없음)

> **이것은 설계 리뷰 태스크다. 코드·DB·git 변경 절대 금지.** 읽고 평가만 한다.
> 대상: `/home/hermes/rpchat/app/DESIGN-P1-3c.md` (+ 맥락: `DESIGN-P1-3.md`, 현재 코드 `apps/server/src/prompt/builder.ts`·`apps/server/src/routes/memory.ts`).
> 목적: 다른 시점의 비평. Claude Code 설계에 동의/반대·놓친 리스크·더 단순한 대안을 raw로 낸다.

## 평가 항목 (각각 근거와 함께)
1. **whole 처리 2-A vs 2-B**: DESIGN-P1-3c §2 표를 보고, 어느 안이 나은지 네 판단과 이유. 2-A(롤링 유지+episode 중간tier)의 "whole↔episode 중복" 우려가 실제로 문제인가? 2-B(whole=rollup)의 부트스트랩 공백은 어떻게든 해결 가능한가?
2. **오펀 방지(§3-3)**: 에피소드 draft 생성 시 장면을 안 접고 **승인 시** covers 범위로 접는 설계. 범위 기반 재판정에 허점 있나?(예: 승인 사이에 새 장면이 범위에 끼어듦, 같은 covers_until 중복, created_at 경계) 더 안전한 방법?
3. **주입(§3-4)**: state→whole→episode→scene priority-fill. episode 1건 cap·예산 차감 순서에 문제? scene의 rolled_up_into 배제와 상호작용 이상?
4. **rollup 범위(§5-2)**: 미접힘 장면 전부 1개 vs THRESHOLD 단위. 어느 쪽이 실전에 낫나?
5. **놓친 것**: 위 외 리스크·엣지케이스·더 단순한 설계.

## 출력
- 파일 작성만: `/home/hermes/rpchat/app/REVIEW-P1-3c.md` 에 아래 형식으로. (git add 금지, 커밋 금지)
```
# P1-3c 설계 검수 by hermes [ISO시각]
## 1. whole 2-A vs 2-B: <권고 A/B + 이유>
## 2. 오펀 방지: <허점 유무 + 대안>
## 3. 주입: <문제 유무>
## 4. rollup 범위: <권고>
## 5. 놓친 것: <목록>
## 종합: <한 문단>
```
- 완료 후 PROGRESS.md에 "P1-3c 설계검수 완료, REVIEW-P1-3c.md 참조" 한 줄만 append.

## 금지
- 코드/스키마/DB/git 변경 일절 금지. 빌드·마이그레이션·커밋 금지. 순수 문서 리뷰.
- 확신 없으면 "불확실"로 표기. 억지 결론 금지.
