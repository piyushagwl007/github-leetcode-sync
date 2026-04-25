import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

describe("icon SVG", () => {
  test("source SVG exists at the expected path", () => {
    expect(existsSync("src/icons/icon.svg")).toBe(true);
  });

  test("SVG is well-formed and has the expected viewBox", () => {
    const svg = readFileSync("src/icons/icon.svg", "utf-8");
    expect(svg).toContain('<svg');
    expect(svg).toContain('viewBox="0 0 128 128"');
    expect(svg).toContain("</svg>");
  });

  test("SVG uses GitHub success-green for the background tile", () => {
    const svg = readFileSync("src/icons/icon.svg", "utf-8");
    // #1a7f37 is GitHub's --success color, used in the contribution graph
    expect(svg.toLowerCase()).toContain("#1a7f37");
  });

  test("SVG renders to PNG at all required sizes without throwing", () => {
    const svg = readFileSync("src/icons/icon.svg", "utf-8");
    for (const size of [16, 48, 128]) {
      const resvg = new Resvg(svg, {
        fitTo: { mode: "width", value: size },
        background: "rgba(0,0,0,0)",
      });
      const png = resvg.render().asPng();
      expect(png.length).toBeGreaterThan(0);
      // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
      expect(png[0]).toBe(0x89);
      expect(png[1]).toBe(0x50);
      expect(png[2]).toBe(0x4e);
      expect(png[3]).toBe(0x47);
    }
  });
});

describe("manifest icon declarations", () => {
  const manifest = JSON.parse(readFileSync("manifest.json", "utf-8"));

  test("declares top-level icons at all three standard sizes", () => {
    expect(manifest.icons).toBeDefined();
    expect(manifest.icons["16"]).toBe("icons/icon-16.png");
    expect(manifest.icons["48"]).toBe("icons/icon-48.png");
    expect(manifest.icons["128"]).toBe("icons/icon-128.png");
  });

  test("toolbar action declares default_icon at all three sizes", () => {
    expect(manifest.action.default_icon).toBeDefined();
    expect(manifest.action.default_icon["16"]).toBe("icons/icon-16.png");
    expect(manifest.action.default_icon["48"]).toBe("icons/icon-48.png");
    expect(manifest.action.default_icon["128"]).toBe("icons/icon-128.png");
  });
});
