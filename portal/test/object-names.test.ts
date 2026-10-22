import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

import { changeName, payloadName } from "@/lib/changes-view";

test("lists name a branding profile, an imported ADMX file and an app relationship by their own fields", () => {
  assert.equal(payloadName({ profileName: "Sales devices", displayName: "Contoso IT" }, "intuneBrandingProfile"), "Sales devices");
  assert.equal(payloadName({ displayName: "Contoso IT" }, "intuneBrandingProfile"), null);
  assert.equal(payloadName({ fileName: "chrome.admx" }, "groupPolicyUploadedDefinitionFile"), "chrome.admx");
  assert.equal(
    payloadName({ "@odata.type": "#microsoft.graph.mobileAppDependency", sourceDisplayName: "Company app", targetDisplayName: ".NET runtime", targetType: "child" }, "mobileAppRelationship"),
    "Company app needs .NET runtime",
  );
  // Never an id, and other kinds keep their displayName.
  assert.equal(payloadName({ profileName: "8a0f3c1e-2b4d-4c6e-9f10-112233445566" }, "intuneBrandingProfile"), null);
  assert.equal(payloadName({ displayName: "Finance" }), "Finance");
  const profileId = "12345678-1234-4234-8234-123456789abc";
  const name = payloadName({ profileName: "Sales devices", displayName: "Contoso IT" }, "intuneBrandingProfile");
  assert.equal(changeName({ naturalKey: `intuneBrandingProfile:${profileId}`, resourceType: "intuneBrandingProfile", name }), "Sales devices");
});

// Every name a page shows comes from engine/cir/objectName.mjs, so a kind named by
// another field (a branding profile's profileName) is named the same way everywhere.
test("no portal or engine query reads a name field by hand", () => {
  const root = join(__dirname, "..", "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs)$/.test(entry) && !/\.test\.|\/test\//.test(path)) files.push(path);
    }
  };
  for (const dir of ["portal/lib", "portal/app", "portal/components", "engine/govern", "engine/policy", "engine/query"]) walk(join(root, dir));
  const offenders = files.filter((path) => /payload\s*->>\s*'(displayName|name|title)'/.test(readFileSync(path, "utf8")))
    .map((path) => relative(root, path));
  assert.deepEqual(offenders, [], "name saved objects with objectName / objectNameSql from engine/cir/objectName.mjs");
});
