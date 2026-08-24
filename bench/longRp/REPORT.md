# long-rp-v1 first live run

사전등록: `bench/longRp/preregistration.md` (실행 전 고정). 이 문서는 그 게이트로 raw를 재추출한 것이다. θ 사후 조정 없음. 95%는 목표가 아님.

## 확인함

- 러너 `VALID`: story_complete=100, probe_complete=9, 전부 `status` 경로 ok.
- 파일: `bench/longRp/results/long-rp-1787582894376.json`
- sha256 `456e1489ebb87ca18e2e562505201a0fdcab1915048d1f7bf152e2e0107f75da` (16480 bytes)
- model `/Users/llm/models/Gemma-4-Dark-Thoughts-V2-31B.i1-Q4_K_M.gguf` · contextTokens 16384 · promptVersion `2026.08.22-r1`
- story wall 합 338.4s (min 2163 / med 3363 / max 6350 ms). probe는 별도(특히 P100-a 44547ms).
- conv `96222ef0-ceff-45be-93af-cb5f5fdff593` 종료 후 삭제됨 (live row 0). generation_log 0.
- 서리 `09e7827f-…` messages 55 → 55. 제품 `apps/**` 무수정.
- 캐릭터 `린-longrp-v1` `e1288984-…` archived=1 잔존.

## hold_rate (scored facts only; VALID)

재추출:

| h | held/scored | hold_rate | held | missed | unscored |
|---|-------------|-----------|------|--------|----------|
| 30 | 0/6 | 0 | — | F01 F02 F03 F05 F06 F07 | F04 F08 |
| 60 | 4/6 | 0.6666666666666666 | F01 F09 F10 F13 | F11 F12 | F02 F03 F04 F05 F06 F07 F08 F14 |
| 100 | 3/7 | 0.42857142857142855 | F15 F17 F18 | F03 F16 F19 F20 | F01 F02 F04–F14 |

## probe raw (pass = 사전등록 must/forbid)

- P30-a fail missing `등대지기`. 본문: 일과+열쇠 꾸러미. F05(열쇠 없음)와 어긋나나 forbid 미적중.
- P30-b fail missing `사흘`. 폭풍 표류·왼손목은 있음.
- P30-c fail missing `모르`. 본문: 열쇠는 린 주머니에 계속 있었다고 단정 (F06 모순).
- P60-a PASS. 주머니 + 미나 언니.
- P60-b fail missing `모르`. 본문: 고의로 심지를 건드린 흔적이라고 단정 (F12).
- P60-c PASS. 부엌·골방.
- P100-a PASS. 편지 + 끄지 말라.
- P100-b fail missing `조수`,`당번`. 위치만 묘사.
- P100-c fail missing `왼손`. 등유 한 시즌은 본문에 있음(F19는 같은 probe 실패로 missed).

## 판정

- 러너 게이트: **VALID**. 이번 칸(100턴 실측) 닫힘.
- 채택 θ 없음. 저hold는 정상 결과. 게이트/키워드 재설계 제안 없음.
- 비채택 대상 아님(원래 측정).

## 확인안함

- dropped_messages / 실제 프롬프트에 fact가 남았는지.
- Galaxy 동시 사용.
- 요약·기억 주입을 켠 대조군.
- 키워드 휴리스틱이 의미적 유지(사흘→3일 등)를 놓친 비율. 사후 키 변경 금지.

## 향후 실험 (별도 사전등록)

- 요약 approve 켠 대조.
- probe를 사실당 1개로 늘려 unscored 축소.
- 금지 문구를 모순 유형별로. **현 벤치 재작업 아님.**
