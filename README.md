# CopenAerie

A small glider run through central Copenhagen at golden hour, built from Denmark's open map data: real building footprints, laser-scanned roofs and the 2025 aerial photo. It opens with a self-running cinematic flyby. Press **Enter** (or click **Fly the city**) to race a 21-gate lap: down Christianshavns Kanal, across the inner harbour to the Opera, over Amalienborg and the Marble Church, down Bredgade, through Nyhavn, over Knippelsbro and round the Christiansborg tower.

This is the city sibling of [Aerie](https://github.com/jacobla1/aerie). The glider is scaled down to a 3.6 m model so it fits Copenhagen's streets and canals, and you can fly under the bridges: 39 of them, from the canal bridges of Christianshavn and Slotsholmen to Knippelsbro, Langebro and Inderhavnsbroen.

## Run

The page loads `data/city.json`, `data/roofs.bin.gz` and the aerial photo tiles in `data/ortho/`, so serve the folder over HTTP rather than opening the file directly:

```sh
python3 -m http.server 8765
# open http://localhost:8765
```

## Controls

- Mouse, arrow keys or WASD to steer; drag on touch screens
- **Esc** returns to the flyby
- **M** toggles sound

Append `#debug` to the URL to expose `window.__step(seconds)`, `window.__dbg.look(position, target, fov)` and `window.__dbg.place(position, yaw)` for stepping the simulation, framing stills and dropping the glider anywhere (for example just short of a bridge). Set `window.__hold = true` to pause the normal frame loop.

## Where the city comes from

| What | Source |
| --- | --- |
| ~11,800 building footprints, gutter heights, storeys, roof and wall materials, construction year | Københavns Kommune's kbhkort WFS, layer `bygning` (GeoDanmark footprints joined with BBR) |
| Roof shapes: ridges, gables, dormers, towers and the height of every building | Danmarks Højdemodel surface and terrain models (0.4 m laser scan), Klimadatastyrelsen via Dataforsyningen |
| Streets, squares, quays, parks and every roof's colour and detail | GeoDanmark spring orthophoto 2025 (10 cm), Klimadatastyrelsen via Dataforsyningen |
| Harbour, canals and lakes | kbhkort layer `vand_oversigtskort` |
| ~17,900 trees with height and crown area | kbhkort layer `automatisk_detekterede_traeer_kk_beta` |
| Towers, spires and domes (Christiansborg, City Hall, Vor Frelsers Kirke, the Marble Church and others), plus building and roof colours where tagged | OpenStreetMap via the Overpass API |
| Bridge outlines and the roads across them, which set each deck's direction | OpenStreetMap (`man_made=bridge`, ways tagged `bridge`) |

Each roof is meshed from the laser heights inside its footprint (`tools/roofs.mjs`): the eave line is sampled just inside every wall, then interior points are added wherever the surface misses the scan by more than 0.8 m, and the lot is joined by a constrained Delaunay triangulation. That gives about 670,000 roof triangles for 10,950 buildings. The other ~800 buildings, mostly newer than the scan, keep a generated roof. The aerial photo is draped over roofs and ground. It was flown near midday, so its hard shadows are lifted in preprocessing, and its haze is countered in the shader with extra contrast and saturation.

Facades are still generated from the BBR wall material and construction year, since an aerial photo can't see them. Nyhavn's ships are placed procedurally along the measured canal.

The municipal water layer stops at each bridge face, so the build puts the water back under every OpenStreetMap bridge outline and raises the deck in a hump from street level to its clearance. Harbour spans over 55 m get about 5.4 m of clearance and piers roughly every 40 m. The canal bridges really clear only about 2.2–2.5 m, which a glider can't thread when the quays sit 2 m above the water, so in the game they get 3.4 m. Bridges aren't in any open dataset with heights, so these are approximations.

**Google Earth** was not used. Its 3D tiles need an API key and per-visit billing, and Google's terms don't allow extracting or storing them. **bbr.dk** itself is a lookup site; its data is already included through the `bygning` layer above.

## Rebuilding the data

The aerial photo and height model need a free [Dataforsyningen](https://dataforsyningen.dk) token, saved in `tools/.dataforsyningen-token` (git-ignored). The Python steps need numpy, opencv and tifffile.

```sh
sh tools/fetch.sh               # municipal and OpenStreetMap layers into tools/raw/ (git-ignored)
python3 tools/fetch_dk.py       # aerial photo and height-model tiles into tools/raw/dk/ (about 600 MB)
python3 tools/mosaic_dk.py      # stitches the heights above terrain into one grid
python3 tools/ortho_dk.py       # writes data/ortho/: 90 photo tiles (about 36 MB) and an overview
(cd tools && npm install)       # cdt2d, for the roof triangulation
node tools/build.mjs            # writes data/city.json (1.6 MB) and data/roofs.bin.gz (4.1 MB)
node tools/course.mjs           # checks the race course against the roofs and draws tools/raw/course*.png
```

Without the height model, `build.mjs` still runs and every roof stays generated.

The course control points live in `tools/course-points.mjs`. They are mirrored in the `COURSE` constant in `index.html`.

## Attribution

- Contains data from Klimadatastyrelsen: GeoDanmark ortofoto forår 2025 and Danmarks Højdemodel (DHM/Overflade and DHM/Terræn).
- Contains data from Københavns Kommune (kbhkort) and GeoDanmark, including BBR building data.
- Landmark and bridge geometry © OpenStreetMap contributors, available under the Open Database License (ODbL).
- Three.js r149 is loaded from jsDelivr.
