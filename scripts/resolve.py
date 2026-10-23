#!/usr/bin/env python3
"""Resolve workflow input (URLs or catalog slugs) to a matrix JSON list."""
import json, os, re, sys, urllib.request, urllib.parse
CATALOG = 'https://raw.githubusercontent.com/aigamedevs/Claude-vs-ChatGPT/main/data/grokgames.json'
raw = os.environ.get('GAMES_INPUT', '')
tokens = [t for t in re.split(r'[\s,]+', raw) if t]
games = json.load(urllib.request.urlopen(CATALOG, timeout=60))
games = games['games'] if isinstance(games, dict) else games
by_id = {g['id']: g for g in games}
by_url = {g.get('play_url', '').rstrip('/'): g for g in games if g.get('play_url')}
out, seen = [], set()
for t in tokens:
    if re.match(r'^https?://', t):
        g = by_url.get(t.rstrip('/'))
        if g: slug, title = g['id'], g['title']
        else:
            u = urllib.parse.urlparse(t)
            slug = re.sub(r'[^a-z0-9]+', '-', (u.netloc.replace('www.', '') + u.path).lower()).strip('-')[:60]
            title = u.netloc
        url = t
    elif t in by_id:
        g = by_id[t]; slug, url, title = t, g['play_url'], g['title']
    else:
        print(f'::warning::unknown slug {t}', file=sys.stderr); continue
    if slug in seen: continue
    seen.add(slug); out.append({'slug': slug, 'url': url, 'title': title})
if not out: sys.exit('no games resolved')
print(json.dumps(out))
