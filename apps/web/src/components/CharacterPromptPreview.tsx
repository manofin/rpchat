import React, { useEffect, useRef, useState } from 'react';
import { get } from '../lib/api';
import type { CharacterPromptPreview as CharacterPromptPreviewBody } from '../types';

export const UNSAVED_CHARACTER_PROMPT_PREVIEW_HINT =
  '캐릭터를 저장한 후 프롬프트 미리보기를 확인할 수 있습니다';

export async function loadCharacterPromptPreview(
  characterId: string | null | undefined,
  getFn: <T>(path: string) => Promise<T>,
): Promise<CharacterPromptPreviewBody | null> {
  if (!characterId) return null;
  return await getFn<CharacterPromptPreviewBody>(`/api/characters/${characterId}/prompt-preview`);
}

export function CharacterPromptPreviewView({ preview }: { preview: CharacterPromptPreviewBody }) {
  return (
    <>
      <div className="muted small">예상 토큰 {preview.totalEstTokens}</div>
      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
        {preview.sections.map((s) => (
          <li key={s.name}>
            {s.name} · {s.est_tokens}/{s.budget}t
          </li>
        ))}
      </ul>
      <div className="mono" style={{ marginTop: 8, maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
        {preview.fixedExcerpt}
      </div>
      {preview.fixedTruncated ? (
        <div className="muted small">고정 블록 발췌가 잘렸습니다</div>
      ) : null}
    </>
  );
}

export function CharacterPromptPreview({
  characterId,
  getFn = get,
}: {
  characterId: string | null | undefined;
  getFn?: <T>(path: string) => Promise<T>;
}) {
  const [preview, setPreview] = useState<CharacterPromptPreviewBody | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!characterId) {
      setPreview(null);
      setErr(null);
      setLoading(false);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    setErr(null);
    void loadCharacterPromptPreview(characterId, getFn)
      .then((data) => {
        if (seq !== seqRef.current) return;
        setPreview(data);
      })
      .catch((e) => {
        if (seq !== seqRef.current) return;
        setPreview(null);
        setErr((e as Error).message);
      })
      .finally(() => {
        if (seq !== seqRef.current) return;
        setLoading(false);
      });
    return () => {
      seqRef.current += 1;
    };
  }, [characterId, reload, getFn]);

  return (
    <div className="field">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <label>프롬프트 미리보기</label>
        {characterId ? (
          <button
            type="button"
            className="btn sm ghost"
            disabled={loading}
            onClick={() => setReload((n) => n + 1)}
          >
            새로고침
          </button>
        ) : null}
      </div>
      {!characterId ? (
        <div className="muted small">{UNSAVED_CHARACTER_PROMPT_PREVIEW_HINT}</div>
      ) : err ? (
        <div className="banner err" role="alert">{err}</div>
      ) : preview ? (
        <CharacterPromptPreviewView preview={preview} />
      ) : (
        <div className="muted small">불러오는 중…</div>
      )}
    </div>
  );
}
