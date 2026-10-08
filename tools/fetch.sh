#!/bin/sh
# Downloads the raw city data into tools/raw/. Run from the repo root: sh tools/fetch.sh
#
# Sources
#   Københavns Kommune, kbhkort WFS (https://wfs-kbhkort.kk.dk/k101/ows)
#     bygning          GeoDanmark building footprints joined with BBR (storeys, roof and wall
#                      material, year) and an estimated gutter height per building
#     vand_oversigtskort  harbour and lakes          landflade_uden_frb  land outline
#     vejflade         road surfaces                 dp_graes            lawns and verges
#     park_groent_omr_oversigtskort  parks
#     automatisk_detekterede_traeer_kk_beta  detected trees with height and crown area
#   OpenStreetMap via the Overpass API (© OpenStreetMap contributors, ODbL)
#     tall building:parts, spires and domes, plus building/roof colour tags; bridge outlines and the roads across them
set -e
cd "$(dirname "$0")/raw"
BBOX_LL="12.555,55.662,12.615,55.698"
OSM_BBOX="55.662,12.555,55.698,12.615"
WFS="https://wfs-kbhkort.kk.dk/k101/ows?service=WFS&version=1.0.0&request=GetFeature&outputFormat=json&srsName=EPSG:25832&bbox=$BBOX_LL,EPSG:4326"

for L in vand_oversigtskort landflade_uden_frb vejflade dp_graes park_groent_omr_oversigtskort havn automatisk_detekterede_traeer_kk_beta; do
  echo "kbhkort: $L"
  curl -sS -m 300 "$WFS&typeName=k101:$L" -o "$L.json"
done
echo "kbhkort: bygning"
curl -sS -m 600 "$WFS&typeName=k101:bygning&propertyName=wkb_geometry,tagrendehoejde_estimat,antaletager,tagdaekningsmateriale,ydervaeggensmateriale,bygningensanvendelse,opfoerelselsaar,byg_kort_areal,bygningstype" -o bygning.json

UA="copenaerie/1.0 (https://github.com/jacobla1/copenaerie)"
echo "overpass: tall parts and spires"
curl -sS -m 180 -A "$UA" --data-urlencode "data=[out:json][timeout:120];(way[\"building:part\"]($OSM_BBOX);way[\"building\"][\"height\"]($OSM_BBOX);way[\"building\"][\"roof:shape\"~\"pyramidal|conical|spire|onion|dome|tented\"]($OSM_BBOX);way[\"man_made\"~\"tower|spire\"]($OSM_BBOX);relation[\"building\"][\"height\"]($OSM_BBOX););out tags geom;" https://overpass-api.de/api/interpreter -o osm_parts.json
echo "overpass: colour tags"
curl -sS -m 180 -A "$UA" --data-urlencode "data=[out:json][timeout:120];(way[\"building\"][\"building:colour\"]($OSM_BBOX);way[\"building\"][\"roof:colour\"]($OSM_BBOX);way[\"building\"][\"roof:material\"]($OSM_BBOX););out tags center;" https://overpass-api.de/api/interpreter -o osm_colours.json
echo "overpass: bridges"
curl -sS -m 180 -A "$UA" --data-urlencode "data=[out:json][timeout:120];(way[\"bridge\"][\"bridge\"!=\"no\"]($OSM_BBOX);way[\"man_made\"=\"bridge\"]($OSM_BBOX);relation[\"man_made\"=\"bridge\"]($OSM_BBOX););out body geom;" https://overpass-api.de/api/interpreter -o osm_bridges.json
echo done
