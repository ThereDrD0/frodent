import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { colors } = JSON.parse(readFileSync(new URL('../docs/palette.json', import.meta.url)));
function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map(s => parseInt(s, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
for (const mode of ['light', 'dark']) {
  test(`${mode} text pairs meet WCAG AA contrast of 4.5:1`, () => {
    for (const [fg, bg] of [['on_surface', 'surface_container_lowest'], ['on_surface_variant', 'surface_container_low'], ['on_primary', 'primary'], ['on_primary_container', 'primary_container'], ['on_secondary_container', 'secondary_container']]) {
      const a = luminance(colors[fg][mode].color), b = luminance(colors[bg][mode].color);
      assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, `${fg}/${bg}`);
    }
  });
}
