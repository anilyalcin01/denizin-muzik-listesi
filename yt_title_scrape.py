import requests, re, html, sys, json

url = sys.argv[1]
title = ''

# 1) oEmbed API — en guvenilir, bot korumasindan etkilenmez
try:
    r = requests.get(
        'https://www.youtube.com/oembed?url=' + url + '&format=json',
        headers={'User-Agent': 'Mozilla/5.0'},
        timeout=10
    )
    if r.status_code == 200:
        data = r.json()
        author = data.get('author_name', '')
        t = data.get('title', '')
        if t:
            # Eger title zaten "Artist - Title" formatindaysa oldugu gibi kullan
            if ' - ' in t:
                title = t
            elif author:
                title = author + ' - ' + t
            else:
                title = t
except Exception:
    pass

# 2) Fallback: HTML sayfasindan <title> tag'i
if not title:
    try:
        r = requests.get(url, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
        }, cookies={'CONSENT': 'PENDING+987'}, timeout=10)
        m = re.search(r'<title>(.+?)</title>', r.text)
        if m:
            t = html.unescape(m.group(1))
            t = re.sub(r'\s*[-–]\s*YouTube$', '', t).strip()
            if t:
                title = t
    except Exception:
        pass

if title:
    print(title)
