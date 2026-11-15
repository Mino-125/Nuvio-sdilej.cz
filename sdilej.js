// Sdílej.cz provider pre Nuvio (Local Scrapers / Plugins)
// Port Streamlet doplnku "sdilej" (autor: Sároš)
// Zámerne bez async/await – iba Promise reťazce kvôli kompatibilite s runtime Nuvia.

var TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c'; // nahraď vlastným kľúčom z themoviedb.org
var TMDB_BASE = 'https://api.themoviedb.org/3';
var SEARCH_URL = 'https://sdilej.cz/api/api_kodi.php?process=search&pagination=100&term=';
var RESOLVER_URL = 'https://app-8886.rostiapp.cz/sdilej?u=';
var HEADERS = { 'accept': '*/*' };

function pad(n) {
  n = parseInt(n, 10) || 0;
  return n < 10 ? '0' + n : String(n);
}

function fetchJson(url) {
  return fetch(url, { headers: HEADERS }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
    return r.json();
  });
}

// Z TMDB získa CZ, SK, anglický aj originálny názov + rok
function getTitles(tmdbId, mediaType) {
  var type = mediaType === 'tv' ? 'tv' : 'movie';
  var base = TMDB_BASE + '/' + type + '/' + tmdbId + '?api_key=' + TMDB_API_KEY;
  var langs = ['cs-CZ', 'sk-SK', 'en-US'];

  return Promise.all(langs.map(function (l) {
    return fetchJson(base + '&language=' + l).catch(function () { return null; });
  })).then(function (res) {
    var titles = [];
    var year = '';
    res.forEach(function (d) {
      if (!d) return;
      var t = d.title || d.name;
      var o = d.original_title || d.original_name;
      if (t && titles.indexOf(t) === -1) titles.push(t);
      if (o && titles.indexOf(o) === -1) titles.push(o);
      var date = d.release_date || d.first_air_date;
      if (!year && date) year = date.substring(0, 4);
    });
    return { titles: titles, year: year };
  });
}

// Ekvivalent "itemsKey": "search.file"
function extractFiles(json) {
  var files = json && json.search && json.search.file;
  if (!files) return [];
  return Array.isArray(files) ? files : [files];
}

function searchSdilej(term) {
  return fetchJson(SEARCH_URL + encodeURIComponent(term))
    .then(extractFiles)
    .catch(function (e) {
      console.log('[Sdilej] search error: ' + e.message);
      return [];
    });
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function matchesEpisode(filename, season, episode) {
  var s = parseInt(season, 10);
  var e = parseInt(episode, 10);
  var f = normalize(filename);
  var patterns = [
    new RegExp('s0*' + s + ' ?e0*' + e + '(?![0-9])'),
    new RegExp('(^|[^0-9])0*' + s + 'x0*' + e + '(?![0-9])'),
    new RegExp('(^|[^0-9])' + s + pad(e) + '(?![0-9])')
  ];
  return patterns.some(function (p) { return p.test(f); });
}

function matchesTitle(filename, titles) {
  var f = normalize(filename);
  return titles.some(function (t) {
    var words = normalize(t).split(' ').filter(function (w) { return w.length > 1; });
    if (!words.length) return false;
    return words.every(function (w) { return f.indexOf(w) !== -1; });
  });
}

function parseQuality(name) {
  var n = String(name).toLowerCase();
  if (/2160p|4k|uhd/.test(n)) return '4K';
  if (/1080p|fullhd|fhd/.test(n)) return '1080p';
  if (/720p|hdrip/.test(n)) return '720p';
  if (/480p|dvdrip|sd/.test(n)) return '480p';
  return 'Unknown';
}

function formatSize(val) {
  if (val === undefined || val === null || val === '') return '';
  var num = Number(val);
  if (isNaN(num)) return String(val);
  if (num > 1073741824) return (num / 1073741824).toFixed(2) + ' GB';
  if (num > 1048576) return (num / 1048576).toFixed(0) + ' MB';
  return num + ' B';
}

function langTag(name) {
  var n = String(name).toLowerCase();
  var tags = [];
  if (/\bcz\b|cesky|czech|cz dabing|cz\.dab/.test(n)) tags.push('CZ');
  if (/\bsk\b|slovensky|slovak/.test(n)) tags.push('SK');
  if (/tit|sub/.test(n)) tags.push('titulky');
  return tags.join(' / ');
}

function getStreams(tmdbId, mediaType, season, episode) {
  var isTv = mediaType === 'tv';

  return getTitles(tmdbId, mediaType).then(function (info) {
    if (!info.titles.length) return [];

    var terms = [];
    info.titles.forEach(function (t) {
      if (isTv) {
        terms.push(t + ' S' + pad(season) + 'E' + pad(episode));
        terms.push(t + ' ' + season + 'x' + pad(episode));
      } else {
        terms.push(t);
        if (info.year) terms.push(t + ' ' + info.year);
      }
    });

    return Promise.all(terms.map(searchSdilej)).then(function (results) {
      var seen = {};
      var streams = [];

      results.forEach(function (files) {
        files.forEach(function (file) {
          // mapping zo Streamletu
          var id = file.download_url;
          var name = file.filename || '';
          if (!id || seen[id]) return;
          if (!matchesTitle(name, info.titles)) return;
          if (isTv && !matchesEpisode(name, season, episode)) return;
          seen[id] = true;

          var size = formatSize(file.data && file.data.value);
          var lang = langTag(name);
          var quality = parseQuality(name);

          streams.push({
            name: 'Sdílej ' + (quality !== 'Unknown' ? quality : ''),
            title: name + (lang ? '\n🌐 ' + lang : '') + (size ? '\n💾 ' + size : ''),
            url: RESOLVER_URL + encodeURIComponent(id),
            quality: quality,
            size: size,
            headers: HEADERS,
            provider: 'sdilej'
          });
        });
      });

      var order = { '4K': 4, '1080p': 3, '720p': 2, '480p': 1, 'Unknown': 0 };
      streams.sort(function (a, b) { return order[b.quality] - order[a.quality]; });
      return streams;
    });
  }).catch(function (e) {
    console.error('[Sdilej] Error: ' + e.message);
    return [];
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  global.getStreams = getStreams;
}
