const express = require('express');
const cors = require('cors');
const { execFile, exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', function(req, res) {
  res.sendFile('/opt/muzik/public/index.html');
});

app.get('/health', function(req, res) {
  res.json({ status: 'ok' });
});

// Deezer'da arayip streamrip ile indiren yardimci fonksiyon
function deezerSearchAndDownload(searchQuery, fallbackName, ripDir, res) {
  var https = require('https');
  var encodedQuery = encodeURIComponent(searchQuery);

  https.get('https://api.deezer.com/search?q=' + encodedQuery + '&limit=1', function(dRes) {
    var body = '';
    dRes.on('data', function(c) { body += c; });
    dRes.on('end', function() {
      var dData;
      try { dData = JSON.parse(body); } catch(e) {
        fs.rmSync(ripDir, { recursive: true, force: true });
        return res.status(500).json({ error: 'Deezer API parse hatasi' });
      }

      if (!dData.data || !dData.data.length) {
        fs.rmSync(ripDir, { recursive: true, force: true });
        return res.status(422).json({ error: 'MANUAL_SEARCH', message: 'Deezer\'da sonuc bulunamadi: "' + searchQuery + '". Sarki adini manuel girin.' });
      }

      var dTrack = dData.data[0];
      var deezerUrl = 'https://www.deezer.com/track/' + dTrack.id;
      var fileName = (dTrack.artist ? dTrack.artist.name : '') + ' - ' + (dTrack.title || fallbackName);

      var setCfg = "python3 -c \"import tomllib,tomli_w;cfg='/root/.config/streamrip/config.toml';d=tomllib.load(open(cfg,'rb'));d['downloads']['folder']='" + ripDir + "';tomli_w.dump(d,open(cfg,'wb'))\"";
      var step3 = setCfg + ' && rip -ndb url "' + deezerUrl + '"';
      exec(step3, { timeout: 120000 }, function(err3, stdout3, stderr3) {
        var restoreCfg = "python3 -c \"import tomllib,tomli_w;cfg='/root/.config/streamrip/config.toml';d=tomllib.load(open(cfg,'rb'));d['downloads']['folder']='/tmp/streamrip';tomli_w.dump(d,open(cfg,'wb'))\"";
        exec(restoreCfg, { timeout: 5000 }, function() {});

        var files = [];
        try {
          files = fs.readdirSync(ripDir).filter(function(f) {
            return f.endsWith('.mp3') || f.endsWith('.flac') || f.endsWith('.ogg') || f.endsWith('.wav') || f.endsWith('.m4a');
          });
        } catch(e) {}

        if (!files.length) {
          fs.rmSync(ripDir, { recursive: true, force: true });
          return res.status(500).json({ error: 'Deezer indirme basarisiz', detail: (stderr3 || '') + (stdout3 || '') });
        }

        var filePath = path.join(ripDir, files[0]);
        var ext = path.extname(files[0]);
        var dlName = fileName + ext;
        res.setHeader('Content-Disposition', 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(dlName));
        res.setHeader('Content-Type', 'audio/mpeg');
        var stream = fs.createReadStream(filePath);
        stream.pipe(res);
        stream.on('end', function() { fs.rmSync(ripDir, { recursive: true, force: true }); });
        stream.on('error', function() { fs.rmSync(ripDir, { recursive: true, force: true }); });
      });
    });
  }).on('error', function(e) {
    fs.rmSync(ripDir, { recursive: true, force: true });
    res.status(500).json({ error: 'Deezer API baglanti hatasi', detail: e.message });
  });
}

// YouTube basligini temizleyip artist + title parse eden yardimci
function parseYtTitle(rawTitle) {
  var cleanTitle = rawTitle
    .replace(/\s*[\(\[].*?[\)\]]/g, '')
    .replace(/\s*(?:official\s*(?:video|audio|music\s*video|lyric\s*video)|lyrics?|hd|hq|4k|remaster(?:ed)?|audio|video|clip|mv)\s*/gi, '')
    .trim();

  if (cleanTitle.includes(' - ')) {
    var parts = cleanTitle.split(' - ');
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  }
  return { artist: '', title: cleanTitle || rawTitle };
}

app.post('/download', function(req, res) {
  const url = req.body.url;
  const format = req.body.format || 'mp3';
  const quality = req.body.quality || '192';
  if (!url) return res.status(400).json({ error: 'URL gerekli' });

  const ripDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripdl-'));

  // Deezer aramasini baslatan fonksiyon
  function searchAndDownload(searchQuery, fallbackName) {
    deezerSearchAndDownload(searchQuery, fallbackName, ripDir, res);
  }

  // Fallback zinciri: --get-title -> --print -> spoofed yt-dlp -> HTML scrape
  function fallbackSearch() {
    // Fallback 1: --get-title
    execFile('yt-dlp', ['--get-title', '--no-playlist', url], { timeout: 15000 }, function(err2, stdout2) {
      var fallbackTitle = (stdout2 || '').trim();
      if (fallbackTitle) {
        var parsed = parseYtTitle(fallbackTitle);
        var q = (parsed.artist + ' ' + parsed.title).trim();
        return searchAndDownload(q, parsed.title || fallbackTitle);
      }
      // Fallback 2: --print uploader + title
      execFile('yt-dlp', ['--skip-download', '--no-playlist', '--print', '%(uploader)s %(title)s', url], { timeout: 15000 }, function(err3, stdout3) {
        var printResult = (stdout3 || '').trim();
        if (printResult) {
          var parsed = parseYtTitle(printResult);
          var q = (parsed.artist + ' ' + parsed.title).trim();
          return searchAndDownload(q, parsed.title || printResult);
        }
        // Fallback 3: spoofed user-agent ile yt-dlp --dump-json
        execFile('yt-dlp', [
          '--dump-json', '--no-playlist', '--no-check-certificates',
          '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          url
        ], { timeout: 30000, maxBuffer: 1024 * 1024 }, function(err4, stdout4) {
          var meta4;
          try { meta4 = JSON.parse(stdout4); } catch(e) { meta4 = null; }
          if (meta4 && meta4.title) {
            var parsed = parseYtTitle(meta4.title);
            var artist4 = parsed.artist || (meta4.uploader || '').replace(/ - Topic$/i, '');
            var q = (artist4 + ' ' + parsed.title).trim();
            return searchAndDownload(q, parsed.title || meta4.title);
          }
          // Fallback 4: YouTube sayfasindan title tag'i scrape et
          exec('python3 /opt/muzik/yt_title_scrape.py "' + url.replace(/"/g, '') + '"',
            { timeout: 15000 }, function(err5, stdout5) {
              var scrapedTitle = (stdout5 || '').trim();
              if (scrapedTitle) {
                var parsed = parseYtTitle(scrapedTitle);
                var q = (parsed.artist + ' ' + parsed.title).trim();
                return searchAndDownload(q, parsed.title || scrapedTitle);
              }
              // Gercekten hicbir sey bulunamadi — yine de bos sorgu gonderme, genel arama yap
              fs.rmSync(ripDir, { recursive: true, force: true });
              return res.status(422).json({ error: 'MANUAL_SEARCH', message: 'Bu video icin bilgi alinamadi. Sarki adini manuel girin.' });
            }
          );
        });
      });
    });
  }

  // 1) yt-dlp --dump-json ile metadata al
  execFile('yt-dlp', ['--dump-json', '--no-playlist', url], { timeout: 30000, maxBuffer: 1024 * 1024 }, function(err1, stdout1, stderr1) {
    var meta;
    try { meta = JSON.parse(stdout1); } catch(e) {
      // dump-json basarisiz — fallback zinciri
      return fallbackSearch();
    }

    var rawTitle = (meta.title || '').trim();
    var track = (meta.track || '').trim();
    var artist = (meta.artist || meta.creator || '').trim();
    var uploader = (meta.uploader || '').trim().replace(/ - Topic$/i, '');

    var title, searchArtist;
    if (track) {
      title = track;
      searchArtist = artist || uploader;
    } else if (rawTitle) {
      var parsed = parseYtTitle(rawTitle);
      title = parsed.title;
      searchArtist = parsed.artist || artist || uploader;
    } else {
      // Baslik yok — fallback
      return fallbackSearch();
    }

    var query = (searchArtist + ' ' + title).trim();
    if (!query) return fallbackSearch();

    searchAndDownload(query, title);
  });
});

app.post('/search', function(req, res) {
  var query = (req.body.query || '').trim();
  if (!query) return res.status(400).json({ error: 'query gerekli' });
  var ripDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripdl-'));
  deezerSearchAndDownload(query, query, ripDir, res);
});

function parseSpotifyTrackId(url) {
  try {
    var parsed = new URL(url);
    // highlight parametresinden track ID al (album/playlist linkleri)
    var highlight = parsed.searchParams.get('highlight');
    if (highlight) {
      var hMatch = highlight.match(/spotify:track:([a-zA-Z0-9]+)/);
      if (hMatch) return hMatch[1];
    }
    // Path'den track ID al: /track/XXX veya /intl-XX/track/XXX
    var pathMatch = parsed.pathname.match(/\/(?:intl-[a-z]{2}\/)?track\/([a-zA-Z0-9]+)/);
    if (pathMatch) return pathMatch[1];
    return null;
  } catch(e) { return null; }
}

app.post('/spotify', function(req, res) {
  const url = req.body.url;
  if (!url) return res.status(400).json({ error: 'URL gerekli' });
  if (!url.includes('spotify.com')) return res.status(400).json({ error: 'Geçerli Spotify URL girin' });

  const ripDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripdl-'));

  // 1) spotipy ile Spotify URL'den ISRC al
  var trackId = parseSpotifyTrackId(url);
  if (!trackId) return res.status(400).json({ error: 'Gecersiz Spotify URL — track ID bulunamadi' });

  exec('python3 /opt/muzik/spotify_isrc.py "' + trackId + '"', { timeout: 15000 }, function(err1, stdout1, stderr1) {
    var meta;
    try { meta = JSON.parse(stdout1.trim()); } catch(e) {
      fs.rmSync(ripDir, { recursive: true, force: true });
      return res.status(500).json({ error: 'Spotify metadata alinamadi', detail: (stderr1 || '') + ' ' + (e.message || '') });
    }

    if (!meta.isrc) {
      fs.rmSync(ripDir, { recursive: true, force: true });
      return res.status(500).json({ error: 'ISRC bulunamadi' });
    }

    const isrc = meta.isrc;
    const trackName = meta.name || 'track';
    const artistName = meta.artist || 'artist';

    // 2) Deezer API ile ISRC -> Deezer track ID
    const https = require('https');
    https.get('https://api.deezer.com/2.0/track/isrc:' + isrc, function(dRes) {
      var body = '';
      dRes.on('data', function(c) { body += c; });
      dRes.on('end', function() {
        var dData;
        try { dData = JSON.parse(body); } catch(e) {
          fs.rmSync(ripDir, { recursive: true, force: true });
          return res.status(500).json({ error: 'Deezer API parse hatasi' });
        }
        if (!dData.id) {
          fs.rmSync(ripDir, { recursive: true, force: true });
          return res.status(500).json({ error: 'Deezer karsiligi bulunamadi', isrc: isrc });
        }

        var deezerUrl = 'https://www.deezer.com/track/' + dData.id;

        // 3) streamrip ile Deezer'dan indir (config'deki folder'i geçici değiştir)
        var setCfg = "python3 -c \"import tomllib,tomli_w;cfg='/root/.config/streamrip/config.toml';d=tomllib.load(open(cfg,'rb'));d['downloads']['folder']='" + ripDir + "';tomli_w.dump(d,open(cfg,'wb'))\"";
        var step3 = setCfg + ' && rip -ndb url "' + deezerUrl + '"';
        exec(step3, { timeout: 120000 }, function(err3, stdout3, stderr3) {
          // Restore default folder
          var restoreCfg = "python3 -c \"import tomllib,tomli_w;cfg='/root/.config/streamrip/config.toml';d=tomllib.load(open(cfg,'rb'));d['downloads']['folder']='/tmp/streamrip';tomli_w.dump(d,open(cfg,'wb'))\"";
          exec(restoreCfg, { timeout: 5000 }, function() {});

          var files = [];
          try {
            files = fs.readdirSync(ripDir).filter(function(f) {
              return f.endsWith('.mp3') || f.endsWith('.flac') || f.endsWith('.ogg') || f.endsWith('.wav') || f.endsWith('.m4a');
            });
          } catch(e) {}

          if (!files.length) {
            fs.rmSync(ripDir, { recursive: true, force: true });
            return res.status(500).json({ error: 'Deezer indirme basarisiz', detail: (stderr3 || '') + (stdout3 || '') });
          }

          var filePath = path.join(ripDir, files[0]);
          var fileName = artistName + ' - ' + trackName + path.extname(files[0]);
          res.setHeader('Content-Disposition', 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(fileName));
          res.setHeader('Content-Type', 'audio/mpeg');
          var stream = fs.createReadStream(filePath);
          stream.pipe(res);
          stream.on('end', function() { fs.rmSync(ripDir, { recursive: true, force: true }); });
          stream.on('error', function() { fs.rmSync(ripDir, { recursive: true, force: true }); });
        });
      });
    }).on('error', function(e) {
      fs.rmSync(ripDir, { recursive: true, force: true });
      res.status(500).json({ error: 'Deezer API baglanti hatasi', detail: e.message });
    });
  });
});

app.post('/exec', function(req, res) {
  const cmd = req.body.cmd;
  if (!cmd) return res.status(400).json({ error: 'cmd gerekli' });

  exec(cmd, { timeout: 30000, maxBuffer: 1024 * 512 }, function(err, stdout, stderr) {
    const output = (stdout || '') + (stderr || '');
    if (err && !output) {
      return res.json({ output: '', error: 'Komut başarısız (exit ' + err.code + ')' });
    }
    res.json({ output: output, error: err ? 'exit ' + err.code : null });
  });
});

app.listen(3002, function() {
  console.log('Muzik calisiyor: 3002');
});
