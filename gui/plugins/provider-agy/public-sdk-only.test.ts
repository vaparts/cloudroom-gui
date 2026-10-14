import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { experimental_scanPublicSdkOnly as scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

const scan = scanPublicSdkOnly(dirname(fileURLToPath(import.meta.url)), {
  allow: [/^(?:\.\.\/)+vitest\.shared\.js$/u],
});

const isShipped = (file: string) =>
  (file === "server.ts" ||
    file === "host.ts" ||
    file.startsWith(`src${"/"}`)) &&
  !/\.test\.ts$/u.test(file);

describe("the agy provider imports only the public SDK", () => {
  it("scans the plugin's source files", () => {
    expect(scan.files).toContain("server.ts");
    expect(scan.files).toContain("host.ts");
    expect(scan.files).toContain(join("src", "provider-bridge.ts"));
  });

  it("ships nothing outside the public SDK allowlist", () => {
    expect(
      scan.violations.filter((violation) => isShipped(violation.file)),
    ).toEqual([]);
  });

  it("has no private, out-of-package or dynamic import anywhere", () => {
    expect(
      scan.violations.filter(
        (violation) => violation.reason !== "outside-allowlist",
      ),
    ).toEqual([]);
  });

  it("declares no @cloudroom/* dependency in package.json", () => {
    expect(scan.privateDependencies).toEqual([]);
  });
});
