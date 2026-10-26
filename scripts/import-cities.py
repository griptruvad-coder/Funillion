"""Refresh the India directory from GeoNames (CC BY 4.0).
Usage: python scripts/import-cities.py path/to/cities500.zip path/to/admin1CodesASCII.txt
Downloads: https://download.geonames.org/export/dump/
"""
import json
import sys
import zipfile
from pathlib import Path

states = {}
for line in Path(sys.argv[2]).read_text(encoding='utf-8').splitlines():
    cols = line.split('\t')
    if cols[0].startswith('IN.'):
        states[cols[0][3:]] = cols[1]
rows = []
with zipfile.ZipFile(sys.argv[1]) as archive:
    for line in archive.read('cities500.txt').decode('utf-8').splitlines():
        c = line.split('\t')
        if c[8] != 'IN' or c[6] != 'P' or c[7] in ('PPLX', 'PPLH', 'PPLQ', 'PPLW'):
            continue
        state = states.get(c[10])
        if not state:
            continue
        aliases = list(dict.fromkeys(a for a in c[3].split(',') if a and len(a) <= 80))
        rows.append([int(c[0]), c[1], c[2], state, float(c[4]), float(c[5]), int(c[14]), aliases])
rows.sort(key=lambda r: (-r[6], r[2], r[0]))
target = Path(__file__).resolve().parent.parent / 'server' / 'cities-india.json'
target.write_text(json.dumps(rows, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
print(f'{len(rows)} cities/towns, {len(set(r[3] for r in rows))} states/UTs -> {target}')
