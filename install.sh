#!/bin/zsh
# Copy the plugin into a vault. There is no build step — main.js is the source.
#
# Target: $1, or the path in .dev-vault, e.g.
#   <vault>/.obsidian/plugins/tags-view
set -e
cd "$(dirname "$0")"
dest=${1:-$( [[ -f .dev-vault ]] && < .dev-vault )}
[[ -n $dest ]] || { print -u2 "usage: ./install.sh <vault>/.obsidian/plugins/tags-view"; exit 1; }
mkdir -p "$dest"
cp main.js manifest.json styles.css "$dest/"
print "installed to $dest"
