import { describe, it, expect } from "vitest";
import { sanitizeUrl, generateRoutePattern } from "../../../core/utils/logs.utils.js";

describe("core/utils/logs.utils :: sanitizeUrl", () => {
  it("masque le mot de passe dans la query string", () => {
    expect(sanitizeUrl("/api/auth?email=test@test.com&password=1234")).toBe(
      "/api/auth?email=test%40test.com&password=******",
    );
  });

  it("masque plusieurs alias de mot de passe (pwd, pass, secret, token)", () => {
    const out = sanitizeUrl("/login?pwd=abc&secret=xyz&token=jwt123&other=ok");
    expect(out).not.toContain("abc");
    expect(out).not.toContain("xyz");
    expect(out).not.toContain("jwt123");
    expect(out).toContain("other=ok");
  });

  it("est insensible à la casse de la clé", () => {
    const out = sanitizeUrl("/login?PASSWORD=secretvalue");
    expect(out).not.toContain("secretvalue");
  });

  it("laisse les URLs sans paramètre sensible inchangées", () => {
    expect(sanitizeUrl("/api/ticketing?TCKNUM=TCK-000100")).toBe("/api/ticketing?TCKNUM=TCK-000100");
  });

  it("retourne l'entrée telle quelle si ce n'est pas une chaîne", () => {
    expect(sanitizeUrl(null)).toBeNull();
    expect(sanitizeUrl(undefined)).toBeUndefined();
  });

  it("retombe sur un remplacement regex si l'URL n'est pas parseable", () => {
    // Une chaîne qui ferait échouer `new URL()` même avec une base factice
    const weird = "http://[::1";
    const out = sanitizeUrl(`${weird}?password=abc`);
    expect(out).not.toContain("abc");
  });
});

describe("core/utils/logs.utils :: generateRoutePattern", () => {
  it("matche un chemin littéral exact", () => {
    const pattern = generateRoutePattern("/api/ticketing/note");
    expect(pattern.test("/api/ticketing/note")).toBe(true);
    expect(pattern.test("/api/ticketing/notex")).toBe(false);
    expect(pattern.test("/api/ticketing/note/extra")).toBe(false);
  });

  it("matche un segment :param par n'importe quelle valeur non vide", () => {
    const pattern = generateRoutePattern("/api/ticketing/categories/:catid");
    expect(pattern.test("/api/ticketing/categories/12")).toBe(true);
    expect(pattern.test("/api/ticketing/categories/ABC")).toBe(true);
    expect(pattern.test("/api/ticketing/categories/")).toBe(false);
    expect(pattern.test("/api/ticketing/categories")).toBe(false);
  });

  it("gère plusieurs :param dans un même chemin", () => {
    const pattern = generateRoutePattern(
      "/api/ticketing/categories/:catid/sc1/:sc1id",
    );
    expect(pattern.test("/api/ticketing/categories/5/sc1/9")).toBe(true);
    expect(pattern.test("/api/ticketing/categories/5/sc1")).toBe(false);
  });

  it("tolère un slash final optionnel", () => {
    const pattern = generateRoutePattern("/api/files/upload");
    expect(pattern.test("/api/files/upload/")).toBe(true);
  });

  it("échappe les caractères spéciaux regex d'un segment littéral", () => {
    const pattern = generateRoutePattern("/api/usersmanager/last-version-details/opened");
    expect(pattern.test("/api/usersmanager/last-version-details/opened")).toBe(true);
    // Le "-" ne doit pas être interprété comme un opérateur regex
    expect(pattern.test("/api/usersmanagerXlast-version-detailsXopened")).toBe(false);
  });
});
