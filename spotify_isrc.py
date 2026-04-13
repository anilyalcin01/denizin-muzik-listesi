import sys, json, spotipy
from spotipy.oauth2 import SpotifyClientCredentials

sp = spotipy.Spotify(auth_manager=SpotifyClientCredentials(
    client_id='cf887d73972b41108b4007572943ec47',
    client_secret='710b68f92111424dbb910f6cf08b3faa'
))
t = sp.track(sys.argv[1])
print(json.dumps({
    'name': t['name'],
    'artist': t['artists'][0]['name'],
    'isrc': t.get('external_ids', {}).get('isrc', '')
}))
