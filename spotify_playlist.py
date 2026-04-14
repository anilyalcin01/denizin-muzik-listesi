import sys, json, re, urllib.request, spotipy
from spotipy.oauth2 import SpotifyClientCredentials

sp = spotipy.Spotify(auth_manager=SpotifyClientCredentials(
    client_id='cf887d73972b41108b4007572943ec47',
    client_secret='710b68f92111424dbb910f6cf08b3faa'
))

playlist_id = sys.argv[1]

# Spotify Client Credentials flow no longer returns user playlist items (Nov 2024).
# Workaround: scrape track URIs from the public embed page, then batch-fetch ISRCs.
req = urllib.request.Request(
    'https://open.spotify.com/embed/playlist/' + playlist_id,
    headers={'User-Agent': 'Mozilla/5.0'}
)
with urllib.request.urlopen(req, timeout=15) as r:
    html = r.read().decode('utf-8', errors='ignore')

m = re.search(r'__NEXT_DATA__" type="application/json">(.+?)</script>', html)
if not m:
    print(json.dumps([]))
    sys.exit(0)

data = json.loads(m.group(1))
entity = data.get('props', {}).get('pageProps', {}).get('state', {}).get('data', {}).get('entity', {}) or {}
track_list = entity.get('trackList', []) or []

track_ids = []
for t in track_list:
    uri = t.get('uri', '')
    if uri.startswith('spotify:track:'):
        track_ids.append(uri.split(':')[2])

out = []
for tid in track_ids:
    try:
        t = sp.track(tid)
    except Exception:
        continue
    out.append({
        'name': t.get('name', ''),
        'artist': (t.get('artists') or [{}])[0].get('name', ''),
        'isrc': (t.get('external_ids') or {}).get('isrc', '')
    })

print(json.dumps(out))
