/**
 * 点歌：网易 163 搜索，取列表第一首播放地址（与 system-Core 点歌.js 逻辑一致）
 * 返回 .mp3 地址，支持 ffmpeg 转 opus 流（mp3/mp4 均可转）
 */
const SEARCH_API = 'https://music.163.com/api/search/get';
const SONG_URL_API = 'https://music.163.com/song/media/outer/url';
const LIMIT = 5;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Referer: 'https://music.163.com/'
};

/**
 * 按关键词搜索，返回第一首的播放 URL 与信息
 * @param {string} keyword - 歌名或关键词
 * @returns {Promise<{ url: string, name: string, artists: string }|null>}
 */
export async function searchFirstSong(keyword) {
  if (!keyword?.trim()) return null;
  const res = await fetch(`${SEARCH_API}?s=${encodeURIComponent(keyword.trim())}&type=1&limit=${LIMIT}`, {
    headers: HEADERS
  });
  const data = await res.json();
  const songs = data.result?.songs;
  if (!songs?.length) return null;
  const first = songs[0];
  const url = `${SONG_URL_API}?id=${first.id}.mp3`;
  return {
    url,
    name: first.name,
    artists: first.artists?.map((a) => a.name).join('、') || ''
  };
}
