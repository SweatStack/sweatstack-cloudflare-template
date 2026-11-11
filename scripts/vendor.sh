#!/usr/bin/env sh
# Downloads the browser libraries in public/vendor/ at pinned versions, and records their SHA-256.
# To upgrade one: change its version below, run `sh scripts/vendor.sh`, test, and commit the result.
set -eu

HTMX_VERSION=2.0.11
UPLOT_VERSION=1.6.32

dir="$(dirname "$0")/../public/vendor"
mkdir -p "$dir"

fetch() { curl -fsSL "https://cdn.jsdelivr.net/npm/$1" -o "$dir/$2"; }

fetch "htmx.org@$HTMX_VERSION/dist/htmx.min.js" htmx.min.js
fetch "uplot@$UPLOT_VERSION/dist/uPlot.esm.js" uplot.esm.js
fetch "uplot@$UPLOT_VERSION/dist/uPlot.min.css" uplot.min.css

{
  echo "# Vendored browser libraries"
  echo
  echo "Downloaded by \`scripts/vendor.sh\`. Don't edit these files; change the version there and re-run it."
  echo
  echo "| File | Package | Version | SHA-256 |"
  echo "|---|---|---|---|"
  for f in htmx.min.js uplot.esm.js uplot.min.css; do
    case "$f" in htmx*) pkg=htmx.org; v=$HTMX_VERSION ;; *) pkg=uplot; v=$UPLOT_VERSION ;; esac
    echo "| $f | $pkg | $v | \`$(shasum -a 256 "$dir/$f" | cut -d' ' -f1)\` |"
  done
  echo
  echo "Licenses: htmx (0BSD), uPlot (MIT)."
} > "$dir/VERSIONS.md"
echo "Vendored files updated in public/vendor/"
