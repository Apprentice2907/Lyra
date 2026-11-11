/* Music source settings.
   apiBases: instances of https://github.com/sumitkolhe/jiosaavn-api, tried in
   order. Put your own deployment (Vercel / Cloudflare Workers) first if you
   host one. Sources are JioSaavn playlist ids, each with a search query used
   if the playlist is unavailable. */
window.VINYL_CONFIG = {
  apiBases: [
    'https://saavn.sumit.co/api',
    'https://saavn.dev/api'
  ],

  // Home: famous songs, in this order (songs already shown above are skipped)
  home: [
    { title: 'Superhits',     style: 'carousel', playlist: '1134548194', query: 'bollywood superhits' },
    { title: 'Evergreen 90s', style: 'carousel', playlist: '3379491',    query: '90s hindi hits' },
    { title: 'Most loved',    style: 'list',     playlist: '1139074020', query: 'romantic hindi hits' }
  ],

  // Saved › Playlists: ready-made playlists of well-known songs
  featured: ['10301457', '903166403', '4144832', '1214335916'],

  // Explore before it knows your taste: random songs from these playlists
  explorePool: ['1134548194', '3379491', '1139074020', '903166403', '4144832', '1214335916', '10301457']
};
