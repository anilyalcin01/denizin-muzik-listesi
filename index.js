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

// YouTube URL'inden video ID cikaran yardimci
function extractYouTubeId(url) {
  if (!url) return '';
  var m;
  m = url.match(/[?&]v=([A-Za-z0-9_-]{11})/); if (m) return m[1];
  m = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/); if (m) return m[1];
  m = url.match(/\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/); if (m) return m[1];
  return '';
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

  // Fallback zinciri: ytsearch1 -> --get-title -> --print -> spoofed yt-dlp -> HTML scrape
  function fallbackSearch() {
    // Fallback 0: --flat-playlist ytsearch1:<videoId> (bot-detection bypass)
    // Search endpoint'i player API'yi tetiklemiyor, dolayisiyla "Sign in to confirm" hatasini atliyor
    var videoId = extractYouTubeId(url);
    if (!videoId) return legacyFallbacks();

    execFile('yt-dlp', [
      '--flat-playlist', '--dump-json', 'ytsearch1:' + videoId
    ], { timeout: 20000, maxBuffer: 1024 * 1024 }, function(err0, stdout0) {
      var meta0;
      try { meta0 = JSON.parse(stdout0); } catch(e) { meta0 = null; }
      if (meta0 && meta0.title) {
        // Unicode ayirici karakterleri normalize et ki parseYtTitle artist/title'i ayirabilsin
        var rawTitle = meta0.title
          .replace(/[–—|·•]/g, ' - ')
          .replace(/\s{2,}/g, ' ')
          .trim();
        var parsed = parseYtTitle(rawTitle);
        var channel = (meta0.channel || meta0.uploader || '')
          .replace(/\s*-\s*Topic\s*$/i, '')
          .replace(/VEVO$/i, '')
          .replace(/\bOfficial\b/gi, '')
          .replace(/\s{2,}/g, ' ')
          .trim();
        // parseYtTitle " - " uzerinden basariyla ayirdiysa channel gereksiz; ayiramadiysa channel artist olarak kullanilir
        var artist = parsed.artist || channel;
        var q = (artist + ' ' + parsed.title).trim();
        return searchAndDownload(q, parsed.title || rawTitle);
      }
      legacyFallbacks();
    });
  }

  function legacyFallbacks() {
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

function parseSpotifyPlaylistId(url) {
  try {
    var parsed = new URL(url);
    var m = parsed.pathname.match(/\/(?:intl-[a-z]{2}\/)?playlist\/([a-zA-Z0-9]+)/);
    if (m) return m[1];
    return null;
  } catch(e) { return null; }
}

function downloadIsrcToDir(isrc, ripDir) {
  return new Promise(function(resolve) {
    const https = require('https');
    https.get('https://api.deezer.com/2.0/track/isrc:' + isrc, function(dRes) {
      var body = '';
      dRes.on('data', function(c) { body += c; });
      dRes.on('end', function() {
        var dData;
        try { dData = JSON.parse(body); } catch(e) { return resolve({ ok: false, reason: 'deezer-parse' }); }
        if (!dData.id) return resolve({ ok: false, reason: 'deezer-not-found' });
        var deezerUrl = 'https://www.deezer.com/track/' + dData.id;
        var setCfg = "python3 -c \"import tomllib,tomli_w;cfg='/root/.config/streamrip/config.toml';d=tomllib.load(open(cfg,'rb'));d['downloads']['folder']='" + ripDir + "';tomli_w.dump(d,open(cfg,'wb'))\"";
        var step = setCfg + ' && rip -ndb url "' + deezerUrl + '"';
        exec(step, { timeout: 120000 }, function(err) {
          resolve({ ok: !err, reason: err ? 'rip-failed' : null });
        });
      });
    }).on('error', function() { resolve({ ok: false, reason: 'deezer-net' }); });
  });
}

app.post('/spotify', function(req, res) {
  const url = req.body.url;
  if (!url) return res.status(400).json({ error: 'URL gerekli' });
  if (!url.includes('spotify.com')) return res.status(400).json({ error: 'Geçerli Spotify URL girin' });

  // Playlist URL'si ise: tüm track'leri çek, sırayla indir, zip olarak dön
  var playlistId = parseSpotifyPlaylistId(url);
  if (playlistId) return handleSpotifyPlaylist(playlistId, res);

  const ripDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripdl-'));

  // 1) spotipy ile Spotify URL'den ISRC al
  var trackId = parseSpotifyTrackId(url);
  if (!trackId) {
    fs.rmSync(ripDir, { recursive: true, force: true });
    return res.status(400).json({ error: 'Gecersiz Spotify URL — track ID bulunamadi' });
  }

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

async function handleSpotifyPlaylist(playlistId, res) {
  const ripDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripdl-pl-'));
  const cleanup = function() { try { fs.rmSync(ripDir, { recursive: true, force: true }); } catch(e) {} };

  // Response can be slow (100 tracks * ~20s). Disable socket timeout.
  if (res.setTimeout) res.setTimeout(0);

  // 1) Playlist'teki track'leri ve ISRC'leri al
  var meta;
  try {
    meta = await new Promise(function(resolve, reject) {
      execFile('python3', ['/opt/muzik/spotify_playlist.py', playlistId], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, function(err, stdout, stderr) {
        if (err) return reject(new Error(stderr || err.message));
        try { resolve(JSON.parse(stdout.trim())); } catch(e) { reject(e); }
      });
    });
  } catch(e) {
    cleanup();
    return res.status(500).json({ error: 'Playlist metadata alinamadi', detail: e.message });
  }

  if (!Array.isArray(meta) || !meta.length) {
    cleanup();
    return res.status(404).json({ error: 'Playlist bos veya track bulunamadi' });
  }

  // 2) Sırayla her track'i indir (ISRC olmayanları atla)
  var ok = 0, failed = [];
  for (var i = 0; i < meta.length; i++) {
    var t = meta[i];
    if (!t.isrc) { failed.push({ name: t.name, artist: t.artist, reason: 'no-isrc' }); continue; }
    var result = await downloadIsrcToDir(t.isrc, ripDir);
    if (result.ok) ok++;
    else failed.push({ name: t.name, artist: t.artist, reason: result.reason });
  }

  // Restore default streamrip folder
  var restoreCfg = "python3 -c \"import tomllib,tomli_w;cfg='/root/.config/streamrip/config.toml';d=tomllib.load(open(cfg,'rb'));d['downloads']['folder']='/tmp/streamrip';tomli_w.dump(d,open(cfg,'wb'))\"";
  exec(restoreCfg, { timeout: 5000 }, function() {});

  if (!ok) {
    cleanup();
    return res.status(500).json({ error: 'Hicbir track indirilemedi', total: meta.length, failed: failed });
  }

  // 3) İçeriği zip'le ve stream et
  var zipPath = ripDir + '.zip';
  exec('cd "' + ripDir + '" && zip -rq "' + zipPath + '" .', { timeout: 120000 }, function(zErr) {
    if (zErr) { cleanup(); try { fs.unlinkSync(zipPath); } catch(e) {} return res.status(500).json({ error: 'Zip olusturulamadi' }); }
    var zipName = 'spotify-playlist-' + playlistId + '.zip';
    res.setHeader('Content-Disposition', 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(zipName));
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('X-Playlist-Total', String(meta.length));
    res.setHeader('X-Playlist-Ok', String(ok));
    res.setHeader('X-Playlist-Failed', String(failed.length));
    var stream = fs.createReadStream(zipPath);
    stream.pipe(res);
    var finish = function() { cleanup(); try { fs.unlinkSync(zipPath); } catch(e) {} };
    stream.on('end', finish);
    stream.on('error', finish);
  });
}

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

app.post('/chat', function(req, res) {
  var messages = req.body.messages;
  var system = req.body.system || '';
  var model = req.body.model || 'claude-sonnet-4-20250514';
  var terminalOutput = req.body.terminal_output;

  // Terminal ciktisi analizi modu
  if (terminalOutput) {
    system = 'Kullanici sunucuda bir komut calistirdi. Terminal ciktisini analiz et, Turkce acikla, onemli noktalari vurgula, varsa hata veya uyarilari belirt. Kisa ve net cevap ver.';
    if (!messages || !messages.length) {
      messages = [{ role: 'user', content: 'Komut ciktisi:\n```\n' + terminalOutput + '\n```' }];
    }
  }

  if (!messages || !messages.length) return res.status(400).json({ error: 'messages gerekli' });

  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY ayarlanmamis' });

  var https = require('https');
  var payload = JSON.stringify({
    model: model,
    max_tokens: 4096,
    system: system,
    messages: messages
  });

  var options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  var apiReq = https.request(options, function(apiRes) {
    var body = '';
    apiRes.on('data', function(c) { body += c; });
    apiRes.on('end', function() {
      try {
        var data = JSON.parse(body);
        if (data.error) {
          return res.status(apiRes.statusCode || 500).json({ error: data.error.message || 'API hatasi', type: data.error.type });
        }
        res.json(data);
      } catch(e) {
        res.status(500).json({ error: 'API yaniti parse edilemedi', detail: body.substring(0, 300) });
      }
    });
  });

  apiReq.on('error', function(e) {
    res.status(500).json({ error: 'Anthropic API baglanti hatasi', detail: e.message });
  });

  apiReq.setTimeout(60000, function() {
    apiReq.destroy();
    res.status(504).json({ error: 'API timeout (60s)' });
  });

  apiReq.write(payload);
  apiReq.end();
});

app.listen(3002, function() {
  console.log('Muzik calisiyor: 3002');
});

// ── Soru Kütüphanesi API ──
const { Pool } = require('pg');
const pgPool = new Pool({host:'localhost',database:'prome',user:'prome_user',password:'prome2026'});

app.get('/sorular', async (req,res) => {
  try {
    const {ders,konu,zorluk,durum,kaynak,q,limit=50,offset=0} = req.query;
    let where = [], params = [];
    if(ders){params.push(ders);where.push(`ders=$${params.length}`);}
    if(konu){params.push(`%${konu}%`);where.push(`konu ILIKE $${params.length}`);}
    if(zorluk){params.push(zorluk);where.push(`zorluk=$${params.length}`);}
    if(durum){params.push(durum);where.push(`durum=$${params.length}`);}
    if(kaynak){params.push(kaynak);where.push(`kaynak=$${params.length}`);}
    if(q){params.push(`%${q}%`);where.push(`soru_metni ILIKE $${params.length}`);}
    const whereStr = where.length ? 'WHERE '+where.join(' AND ') : '';
    params.push(parseInt(limit)); params.push(parseInt(offset));
    const result = await pgPool.query(
      `SELECT * FROM sorular ${whereStr} ORDER BY olusturulma DESC LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );
    const count = await pgPool.query(`SELECT COUNT(*) FROM sorular ${whereStr}`, params.slice(0,-2));
    res.json({sorular:result.rows, toplam:parseInt(count.rows[0].count)});
  } catch(e){res.status(500).json({error:e.message});}
});

app.get('/sorular/stats', async (req,res) => {
  try {
    const stats = await pgPool.query(`
      SELECT
        COUNT(*) as toplam,
        COUNT(*) FILTER (WHERE durum='onaylı') as onaylı,
        COUNT(*) FILTER (WHERE durum='taslak') as taslak,
        COUNT(*) FILTER (WHERE kaynak='eba') as eba,
        COUNT(*) FILTER (WHERE kaynak='ai_uretimi') as ai,
        COUNT(*) FILTER (WHERE zorluk='kolay') as kolay,
        COUNT(*) FILTER (WHERE zorluk='orta') as orta,
        COUNT(*) FILTER (WHERE zorluk='zor') as zor
      FROM sorular`);
    res.json(stats.rows[0]);
  } catch(e){res.status(500).json({error:e.message});}
});

app.put('/sorular/:id', async (req,res) => {
  try {
    const {soru_metni,secenek_a,secenek_b,secenek_c,secenek_d,dogru_cevap,cozum_aciklamasi,zorluk,durum,konu,katex_formul} = req.body;
    await pgPool.query(
      `UPDATE sorular SET soru_metni=$1,secenek_a=$2,secenek_b=$3,secenek_c=$4,secenek_d=$5,
       dogru_cevap=$6,cozum_aciklamasi=$7,zorluk=$8,durum=$9,konu=$10,katex_formul=$11,guncelleme=NOW()
       WHERE id=$12`,
      [soru_metni,secenek_a,secenek_b,secenek_c,secenek_d,dogru_cevap,cozum_aciklamasi,zorluk,durum,konu,katex_formul,req.params.id]
    );
    res.json({ok:true});
  } catch(e){res.status(500).json({error:e.message});}
});

app.delete('/sorular/:id', async (req,res) => {
  try {
    await pgPool.query('DELETE FROM sorular WHERE id=$1',[req.params.id]);
    res.json({ok:true});
  } catch(e){res.status(500).json({error:e.message});}
});

app.post('/sorular/uret', async (req,res) => {
  try {
    const {konu,zorluk,sinif,adet=3} = req.body;
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();
    const response = await client.messages.create({
      model:'claude-opus-4-5', max_tokens:3000,
      messages:[{role:'user',content:`TYMM Biyoloji ${sinif||9}. Sınıf - "${konu}" konusunda ${zorluk||'orta'} seviyede ${adet} çoktan seçmeli soru üret.
JSON array döndür:
[{"soru_metni":"...","secenek_a":"...","secenek_b":"...","secenek_c":"...","secenek_d":"...","dogru_cevap":"A","cozum_aciklamasi":"...","zorluk":"${zorluk||'orta'}","konu":"${konu}"}]`}]
    });
    const text = response.content[0].text.replace(/```json|```/g,'').trim();
    const start = text.indexOf('['), end = text.lastIndexOf(']')+1;
    const yeniSorular = JSON.parse(text.substring(start,end));
    const ids = [];
    for(const s of yeniSorular){
      const r = await pgPool.query(
        `INSERT INTO sorular (kaynak,ders,konu,sinif,sinav_turu,zorluk,soru_metni,secenek_a,secenek_b,secenek_c,secenek_d,dogru_cevap,cozum_aciklamasi,durum,etiketler)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        ['ai_uretimi','Biyoloji',s.konu,sinif||'9','TYMM',s.zorluk,s.soru_metni,s.secenek_a,s.secenek_b,s.secenek_c,s.secenek_d,s.dogru_cevap,s.cozum_aciklamasi,'taslak',['biyoloji','tymm','ai']]
      );
      ids.push(r.rows[0].id);
    }
    res.json({ok:true, adet:yeniSorular.length, ids});
  } catch(e){res.status(500).json({error:e.message});}
});

// ── PDF Upload & TYMM Yönetimi ──
const multer = require('multer');

const pdfStorage = multer.diskStorage({
  destination: '/opt/tymm/pdfs/',
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._\-\s]/g, '_');
    cb(null, safe);
  }
});
const pdfUpload = multer({
  storage: pdfStorage,
  fileFilter: (req, file, cb) => {
    cb(null, file.mimetype === 'application/pdf');
  },
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.post('/tymm/upload', pdfUpload.single('pdf'), (req, res) => {
  if(!req.file) return res.status(400).json({error:'PDF değil veya dosya yok'});
  res.json({ok:true, filename: req.file.filename, size: req.file.size});
});

app.get('/tymm/pdfs', (req, res) => {
  const fs = require('fs');
  try {
    const files = fs.readdirSync('/opt/tymm/pdfs/').filter(f=>f.endsWith('.pdf'));
    const list = files.map(f => {
      const stat = fs.statSync(`/opt/tymm/pdfs/${f}`);
      return { name: f, size: stat.size, date: stat.mtime };
    });
    res.json(list);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.delete('/tymm/pdfs/:filename', (req, res) => {
  const fs = require('fs');
  const safe = path.basename(req.params.filename);
  try {
    fs.unlinkSync(`/opt/tymm/pdfs/${safe}`);
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/tymm/ingest/:filename', (req, res) => {
  const { exec } = require('child_process');
  const safe = path.basename(req.params.filename);
  exec(`python3 /opt/tymm/ingest.py "${safe}"`, (err, stdout, stderr) => {
    if(err) return res.status(500).json({error:stderr});
    res.json({ok:true, output: stdout});
  });
});

