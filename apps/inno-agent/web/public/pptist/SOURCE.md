# PPTist embedded build

PPTist is licensed under AGPL-3.0; see [LICENSE](./LICENSE).
Upstream source: https://github.com/pipipi-pikachu/PPTist/tree/04e06cb397b7f146c6e3e4f62ccddc0b72c041d2
Source archive: https://codeload.github.com/pipipi-pikachu/PPTist/tar.gz/04e06cb397b7f146c6e3e4f62ccddc0b72c041d2
Inno Agent modifications: https://github.com/hhyqhh/inno-agent/blob/refactor/scripts/patches/pptist-embed.patch
Rebuild: run scripts/prepare-pptist.sh from the Inno Agent repository.
The upstream lockfile pins dependencies; the patch adds the host bridge,
import completion/error signals, export correlation, and the crop correction.
