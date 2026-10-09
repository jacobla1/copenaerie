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
- **N** switches between dusk and night

Phones and tablets get a lighter city so the browser doesn't run out of graphics memory: no kerbs, parked cars or bikes, half-resolution aerial photo tiles and smaller shadow maps. Add `?lite=1` or `?lite=0` to the URL to force either version.

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
| ~740 km of kerb lines and ~5,900 street posts (lamp, sign and signal masts) | GeoDanmark `VEJKANT` and `MAST`, read from Klimadatastyrelsen's GeoDanmark map service and traced back into lines and points |
| Squares and pedestrian areas (cobbles), parking areas and bicycle parking | OpenStreetMap (`place=square`, `highway=pedestrian`, `amenity=parking`, `amenity=bicycle_parking`) |

Each roof is meshed from the laser heights inside its footprint (`tools/roofs.mjs`): the eave line is sampled just inside every wall, then interior points are added wherever the surface misses the scan by more than 0.8 m, and the lot is joined by a constrained Delaunay triangulation. That gives about 670,000 roof triangles for 10,950 buildings. The other ~800 buildings, mostly newer than the scan, keep a generated roof. The aerial photo is draped over roofs and ground. It was flown near midday, so its hard shadows are lifted in preprocessing, and its haze is countered in the shader with extra contrast and saturation.

Facade colours come from Klimadatastyrelsen's 2025 oblique aerial photos (`tools/fetch_oblique.py`, `tools/facades_dk.py`). Every wall is projected into the north, east, south and west photos that face it, views blocked in the laser surface model are dropped, and the median colour of the clearest view is kept. About 54 % of wall segments get a real colour, and the rest (mostly courtyards) fall back to a palette chosen from BBR material and year. Windows, frames with glazing bars, sills, surrounds, doors, shopfronts with sign boards, brick courses, plinths, cornices and the shadow under the eaves are drawn in the shader. The windows sit back in the wall: the shader finds where the view ray meets the set-back glass, draws the opening's inner sides and lets the opening shade the glass. Behind the glass are curtains, blinds and lit rooms, and the panes reflect the sky or the street. A screen-space ambient occlusion pass darkens corners and the foot of each wall on desktop. Vor Frelsers Kirke's church body uses the laser-scanned roof instead of OpenStreetMap's boxes, and its gilded spiral spire and Børsen's dragon-tail spire are modelled by hand, and about 1,600 street lamps hang on wires between facing buildings along OpenStreetMap's streets. Nyhavn's ships are placed procedurally along the measured canal.

Roofs carry about 17,000 chimneys, found where the raw laser scan stands well above the filtered roof surface. Pitched roofs run 0.45 m past the wall and end in a dark gutter, except where the house next door shares the wall. Bay windows go on the apartment blocks built from 1885 to 1935, balconies on modern blocks, and a gabled frontispiece over the canal on Nyhavn's old houses. The Marble Church, Christiansborg's tower with its three crowns, City Hall's tower, the Round Tower and the Opera's roof are modelled by hand around the laser scan's measurements.

At street level, kerbs follow GeoDanmark's kerb lines, with the road side worked out from the nearest street centreline. About 21,000 cars are parked along ordinary streets and in OpenStreetMap's parking areas, and about 10,600 bicycles stand at its bicycle parking. Squares, pedestrian areas and the quays are cobbled close up. The quays have granite coping and iron bollards, and Nyhavn has café tables under market umbrellas. This street detail is drawn only within about 600 m of the camera. Harbour buses run down the inner harbour, cyclists cross the longer bridges, and gulls circle over the water. Press N, or the Dusk button, for the same lap at night: lit windows, floodlit landmarks, pools of lamplight and stars.

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
python3 tools/fetch_oblique.py  # 522 oblique photos at 1/8 size into tools/raw/dk/sk/ (about 1 GB)
python3 tools/fetch_geodk.py    # GeoDanmark kerb lines and masts into tools/raw/dk/ (needs scikit-image)
node tools/build.mjs            # first pass writes tools/raw/walls.json
python3 tools/facades_dk.py     # facade colours into tools/raw/facades.json
node tools/build.mjs            # writes data/city.json (3.8 MB, 1.3 MB gzipped) and data/roofs.bin.gz (4.1 MB)
node tools/course.mjs           # checks the race course against the roofs and draws tools/raw/course*.png
```

Without the height model, `build.mjs` still runs and every roof stays generated.

The course control points live in `tools/course-points.mjs`. They are mirrored in the `COURSE` constant in `index.html`.

## Attribution

- Contains data from Klimadatastyrelsen: GeoDanmark ortofoto forår 2025, skråfoto 2025, GeoDanmark vector data (kerbs and masts) and Danmarks Højdemodel (DHM/Overflade and DHM/Terræn).
- Contains data from Københavns Kommune (kbhkort) and GeoDanmark, including BBR building data.
- Landmark, bridge, street, square and parking geometry © OpenStreetMap contributors, available under the Open Database License (ODbL).
- Three.js r149 is loaded from jsDelivr.
