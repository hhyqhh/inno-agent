# Word editor font notices

Fonts are bundled from @betteroffice/fonts 0.4.0 and @betteroffice/fonts-cjk 0.4.0 through Vite. Font binaries are SIL OFL 1.1; loader code is Apache-2.0. The corresponding copyright notices and license texts accompany this application in the subdirectories below.

Chinese Word font names use Noto substitutes; these are not the proprietary Microsoft font files.
When the desktop/server runs on the user's machine, the editor prefers the real
system fonts (see /api/system/fonts) and only falls back to these substitutes
for families the OS does not install.

Additionally, `src/react/office/fonts/` bundles the Noto Sans SC Bold and Noto Serif SC Bold faces (the same Noto CJK Subset-SC builds the Regular faces above come from, SIL OFL 1.1, license text alongside). @betteroffice/fonts-cjk 0.4.0 ships the Chinese faces in Regular only, so without these the editor measures bold Chinese text correctly but paints it with regular-weight outlines. The wrapper in `src/react/office/word-fonts.ts` serves the Bold faces for bold requests of the Chinese alias families.
