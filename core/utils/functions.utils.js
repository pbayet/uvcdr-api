/**
 * Parse une valeur JSON de façon sûre.
 * @param {*} str
 * @returns {*|false} La valeur parsée, ou `false` si le parsing échoue.
 */
export function parseToJSON(str) {
  if (str == null) return false;
  if (typeof str !== "string") return str;
  try {
    return JSON.parse(str);
  } catch {
    return false;
  }
}

/**
 * Tronque une chaîne à `maxLength` caractères (filet de sécurité avant un
 * INSERT dans une colonne SQL à longueur fixe, ex: NVarChar(300)). Ne lève
 * jamais — retourne `null` tel quel pour ne pas gêner un paramètre optionnel.
 * @param {*} value
 * @param {number} maxLength
 * @returns {string|null}
 */
export function truncate(value, maxLength) {
  if (value == null) return value;
  const str = String(value);
  return str.length > maxLength ? str.slice(0, maxLength) : str;
}
