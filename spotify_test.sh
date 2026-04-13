#!/bin/bash
spotdl \
  --client-id cf887d73972b41108b4007572943ec47 \
  --client-secret 710b68f92111424dbb910f6cf08b3faa \
  --audio youtube-music \
  --output "/tmp/{title}.{ext}" \
  "$1"
