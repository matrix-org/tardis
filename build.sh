#!/bin/bash -eu
yarn build # dumps to ./dist
git checkout gh-pages # we gitignore ./dist so the directory is carried over to this branch
git ls-files -z | xargs -0 rm -f # remove previous release
cp -r ./dist/* . # dump dist files at the root
git add assets/ index.html # add them
git status # show the user so they can commit