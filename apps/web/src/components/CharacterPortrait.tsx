import { useState } from 'react';

export function CharacterPortrait({ src, name }: { src: string; name: string }) {
  const [failed, setFailed] = useState(false);
  return <figure className="character-portrait">
    <div className="character-portrait-frame">
      {failed
        ? <span className="character-portrait-unavailable" role="status">이미지를 불러올 수 없습니다.</span>
        : <img src={src} alt={`${name}의 모습`} width={600} height={800} loading="lazy" decoding="async" onError={() => setFailed(true)} />}
    </div>
    <figcaption>{name}</figcaption>
  </figure>;
}
