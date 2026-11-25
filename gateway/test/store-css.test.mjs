// Theme CSS from the Design Store must never load anything external.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafeThemeCss } from "../dist/store.js";

test("theme CSS filter", () => {
  const evil = "url(https://attacker.example/t.png)";
  for (const css of [
    `body{background:${evil}}`,
    `body{background:\\75rl(https://attacker.example/t.png)}`,
    `body{background:image-set("https://attacker.example/t.png" 1x)}`,
    `a{content:"/*"}body{background:${evil}}b{content:"*/"}`,
    `a{--x:\\/*}body{background:${evil}}b{--y:*/}`,
    `body{background:-webkit-image-set("https://attacker.example/t.png" 1x)}`,
  ]) assert.equal(isSafeThemeCss(css), false, css);
  for (const css of [
    ":root{--bg:#123}body{color:red}a:hover{opacity:.5}",
    "body{background:url(data:image/png;base64,AAAA)}",
    "/* a comment */ body{color:red}",
  ]) assert.equal(isSafeThemeCss(css), true, css);
});
