// A YouTube "watch" link cannot be shown inside an <iframe> (YouTube answers
// "www.youtube.com refused to connect"). It must be turned into an /embed/ link first.

const parseStartSeconds = (value: string | null): number => {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return parseInt(value, 10); // "90"
  const m = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/); // "1h2m3s", "1m30s", "45s"
  if (!m) return 0;
  return (parseInt(m[1] || '0', 10) * 3600) + (parseInt(m[2] || '0', 10) * 60) + parseInt(m[3] || '0', 10);
};

/**
 * Returns an embeddable URL for any YouTube link
 * (watch?v=, youtu.be/, /shorts/, /live/, /embed/, playlist), or null if it is not YouTube.
 */
export const getYouTubeEmbedUrl = (rawUrl?: string | null): string | null => {
  if (!rawUrl) return null;

  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^(www|m)\./, '');
  const isYouTube = host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'youtu.be';
  if (!isYouTube) return null;

  const list = url.searchParams.get('list');

  // playlist only: youtube.com/playlist?list=...
  if (url.pathname === '/playlist' && list) {
    return `https://www.youtube.com/embed/videoseries?list=${encodeURIComponent(list)}`;
  }

  let id: string | null = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1] || null;
  } else if (url.pathname === '/watch') {
    id = url.searchParams.get('v');
  } else {
    const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]+)/);
    id = m ? m[1] : null;
  }

  if (!id || !/^[\w-]{6,}$/.test(id)) return null;

  const params = new URLSearchParams();
  if (list) params.set('list', list);
  const start = parseStartSeconds(url.searchParams.get('t') || url.searchParams.get('start'));
  if (start > 0) params.set('start', String(start));

  const qs = params.toString();
  return `https://www.youtube.com/embed/${id}${qs ? `?${qs}` : ''}`;
};
