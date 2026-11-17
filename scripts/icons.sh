#!/bin/sh
# Régénère les icônes PNG de l'app à partir des SVG de assets/ (nécessite rsvg-convert).
set -e
cd "$(dirname "$0")/.."
rsvg-convert -w 180 -h 180 assets/app-icon.svg -o app/icons/apple-touch-icon.png
rsvg-convert -w 192 -h 192 assets/app-icon.svg -o app/icons/icon-192.png
rsvg-convert -w 512 -h 512 assets/app-icon.svg -o app/icons/icon-512.png
rsvg-convert -w 512 -h 512 assets/maskable.svg -o app/icons/maskable-512.png
