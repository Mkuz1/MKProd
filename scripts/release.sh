#!/usr/bin/env bash
# Publishes a new version of everything: bumps the single VERSION file (and the Windows
# package.json that mirrors it), commits and pushes. GitHub Actions then rebuilds the Mac, Windows
# and Android apps under the new version number and deploys the website.
#
#   scripts/release.sh 1.2.0            # explicit version
#   scripts/release.sh patch|minor|major
set -euo pipefail
cd "$(dirname "$0")/.."
cur=$(tr -d '[:space:]' < VERSION)
IFS=. read -r MA MI PA <<< "$cur"
case "${1:-}" in
  major) new="$((MA + 1)).0.0" ;;
  minor) new="$MA.$((MI + 1)).0" ;;
  patch) new="$MA.$MI.$((PA + 1))" ;;
  "") echo "Current version: $cur"; echo "Usage: $0 <version|patch|minor|major>"; exit 1 ;;
  *) new="$1" ;;
esac
[[ "$new" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Not a version: $new"; exit 1; }
if [ -n "$(git status --porcelain)" ]; then echo "Commit or stash your changes first."; exit 1; fi
echo "$new" > VERSION
# Only the version line changes, so the file keeps its formatting.
sed -i.bak -E "s/(\"version\": *\")[0-9]+\.[0-9]+\.[0-9]+(\")/\1$new\2/" desktop/package.json && rm -f desktop/package.json.bak
git add VERSION desktop/package.json
git commit -q -m "Release $new"
git push
echo "Released $new: watch https://github.com/Mkuz1/MKProd/actions (Mac, Windows, Android, Deploy site)."
