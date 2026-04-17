import sys, json, spotipy
from spotipy.oauth2 import SpotifyClientCredentials

sp = spotipy.Spotify(auth_manager=SpotifyClientCredentials(
    client_id='cf887d73972b41108b4007572943ec47',
    client_secret='710b68f92111424dbb910f6cf08b3faa'
))

album_id = sys.argv[1]

track_ids = []
results = sp.album_tracks(album_id, limit=50)
while results:
    for t in results['items']:
        if t and t.get('id'):
            track_ids.append(t['id'])
    results = sp.next(results) if results.get('next') else None

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
