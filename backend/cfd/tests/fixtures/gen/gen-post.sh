#!/bin/bash
# Regenerates ../post/ from a kept run-case directory (README.md):
#   docker run --rm -v "$PWD":/fx -v CASE_PARENT:/run -w /fx/gen <image> bash gen-post.sh /run/run-case 300 /run/input.json
set -e
python3 gen_post.py "$1" "$2" "$3" /fx/post
