# CopenAerie

A small glider run through central Copenhagen at golden hour, built from the city's own open data. It opens with a self-running cinematic flyby. Press **Enter** (or click **Fly the city**) to race a 21-gate lap: down Christianshavns Kanal, across the inner harbour to the Opera, over Amalienborg and the Marble Church, down Bredgade, through Nyhavn, over Knippelsbro and round the Christiansborg tower.

This is the city sibling of [Aerie](https://github.com/jacobla1/aerie). The glider is scaled down to a 3.6 m model so it fits Copenhagen's streets and canals.

## Run

The page loads `data/city.json`, so serve the folder over HTTP rather than opening the file directly:

```sh
python3 -m http.server 8765
# open http://localhost:8765
```

## Controls

- Mouse, arrow keys or WASD to steer; drag on touch screens
- **Esc** returns to the flyby
- **M** toggles sound

Append `#debug` to the URL to expose `window.__step(seconds)` and `window.__dbg.look(position, target, fov)` for stepping the simulation and framing stills.

## Where the city comes from

| What | Source |
| --- | --- |
| ~11,800 building footprints, gutter heights, storeys, roof and wall materials, construction year | Københavns Kommune's kbhkort WFS, layer `bygning` (GeoDanmark footprints joined with BBR) |
| Harbour, canals and lakes; land outline; road surfaces; lawns; parks; bridge decks | kbhkort layers `vand_oversigtskort`, `landflade_uden_frb`, `vejflade`, `dp_graes`, `park_groent_omr_oversigtskort`, `bro` |
| ~17,900 trees with height and crown area | kbhkort layer `automatisk_detekterede_traeer_kk_beta` |
| Towers, spires and domes (Christiansborg, City Hall, Vor Frelsers Kirke, the Marble Church and others), plus building and roof colours where tagged | OpenStreetMap via the Overpass API |

Facade colours, windows and roof shapes are generated from the BBR materials and year, since no open dataset has textures. Nyhavn's ships are placed procedurally along the measured canal.

**Google Earth** was not used. Its 3D tiles need an API key, and Google's terms don't allow extracting or storing them. **bbr.dk** itself is a lookup site; its data is already included through the `bygning` layer above.

## Rebuilding the data

```sh
sh tools/fetch.sh          # downloads raw layers into tools/raw/ (git-ignored)
node tools/build.mjs       # writes data/city.json (about 1.9 MB, 0.7 MB gzipped)
node tools/course.mjs      # checks the race course against building heights and draws tools/raw/course*.png
```

The course control points live in `tools/course-points.mjs`. They are mirrored in the `COURSE` constant in `index.html`.

## Attribution

- Contains data from Københavns Kommune (kbhkort) and GeoDanmark, including BBR building data.
- Landmark geometry © OpenStreetMap contributors, available under the Open Database License (ODbL).
- Three.js r149 is loaded from jsDelivr.
