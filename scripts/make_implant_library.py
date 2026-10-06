"""Build public/implant-library/ for the peek abut tab from airdental's copy of EZCAD's implant
library: the interface (1-piece, 2-piece) and Ti-base STLs of every Inteware system, and an
index.json listing them as system -> type -> subtype (read by src/utils/function/peek/peekBase.js).

    python scripts/make_implant_library.py SOURCE public/implant-library

SOURCE is airdental's client/default/airdesign/constants/scanbody-library/ImplantAbutment.

public/ is not in git, so each instance that should offer the library needs this run once.
Every Inteware system's AxisOcclusal is +Z, which the viewer relies on (asserted below).
"""
import json
import shutil
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

src = Path(sys.argv[1])  # .../scanbody-library/ImplantAbutment
dst = Path(sys.argv[2])
dst.mkdir(parents=True, exist_ok=True)
systems = []
copied = 0
for folder in sorted(p for p in src.iterdir() if p.is_dir() and p.name.startswith('Inteware ')):
    root = ET.parse(folder / 'config.xml').getroot()
    axis = root.find('AxisOcclusal')
    assert [axis.find(k).text.strip() for k in 'XYZ'] == ['0', '0', '1'], folder
    types = []
    for type_el in root.iter('ImplantTypeConfig'):
        subtypes = []
        for sub_el in type_el.iter('ImplantSubtypeConfig'):
            iface = (sub_el.findtext('InterfaceFilename') or '').strip()
            tibase = (sub_el.findtext('TibaseFilename') or '').strip()
            if not iface or not (folder / iface).exists():
                continue
            entry = {'name': sub_el.findtext('SubtypeInformation').strip(), 'interface': iface}
            if tibase and (folder / tibase).exists():
                entry['tibase'] = tibase
            subtypes.append(entry)
        if subtypes:
            types.append({'name': type_el.findtext('TypeInformation').strip(), 'subtypes': subtypes})
    if not types:
        continue
    (dst / folder.name).mkdir(exist_ok=True)
    for t in types:
        for st in t['subtypes']:
            for key in ('interface', 'tibase'):
                if key in st and not (dst / folder.name / st[key]).exists():
                    shutil.copyfile(folder / st[key], dst / folder.name / st[key])
                    copied += 1
    systems.append({'name': folder.name, 'folder': folder.name, 'types': types})
index = {
    'source': 'airdental client/default/airdesign/constants/scanbody-library/ImplantAbutment '
              '(EZCAD StdDataBase ImplantAbutment), Inteware systems, interface and Ti-base parts only',
    'frame': 'implant platform at the origin, occlusal +Z (AxisOcclusal of every system)',
    'systems': systems,
}
(dst / 'index.json').write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding='utf-8')
print('systems', len(systems), 'types', sum(len(s['types']) for s in systems),
      'subtypes', sum(len(t['subtypes']) for s in systems for t in s['types']), 'files', copied)
