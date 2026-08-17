import { readFileSync } from 'node:fs';

function stripComment(line) {
  let quote = '';
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      escaped = true;
      continue;
    }
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? '' : char;
      continue;
    }
    if (char === '#' && !quote) return line.slice(0, i);
  }
  return line;
}

function parseValue(raw, lineNumber) {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`invalid quoted string on line ${lineNumber}`);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value.startsWith('[') && value.endsWith(']')) {
    try {
      const parsed = JSON.parse(value.replace(/,\s*]/, ']'));
      if (!Array.isArray(parsed) || parsed.some((item) => !['string', 'number', 'boolean'].includes(typeof item))) {
        throw new Error('only scalar arrays are supported');
      }
      return parsed;
    } catch {
      throw new Error(`invalid scalar array on line ${lineNumber}`);
    }
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  throw new Error(`unsupported TOML value on line ${lineNumber}`);
}

// Strict parser for the scalar TOML subset used by PicoGallery. It preserves
// table and array-table boundaries, unlike the former global regular expressions.
export function parsePicoConfig(raw) {
  const result = {};
  let table = result;
  const lines = String(raw || '').split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const lineNumber = i + 1;
    const line = stripComment(lines[i]).trim();
    if (!line) continue;

    const arrayTable = line.match(/^\[\[([A-Za-z0-9_.-]+)\]\]$/);
    if (arrayTable) {
      const key = arrayTable[1];
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error(`prototype pollution vector blocked on line ${lineNumber}`);
      if (key.includes('.')) throw new Error(`nested array tables are not supported on line ${lineNumber}`);
      if (!result[key]) result[key] = [];
      if (!Array.isArray(result[key])) throw new Error(`table ${key} is already defined`);
      table = {};
      result[key].push(table);
      continue;
    }

    const namedTable = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (namedTable) {
      const parts = namedTable[1].split('.');
      table = result;
      for (const part of parts) {
        if (part === '__proto__' || part === 'constructor' || part === 'prototype') throw new Error(`prototype pollution vector blocked on line ${lineNumber}`);
        if (!table[part]) table[part] = {};
        if (typeof table[part] !== 'object' || Array.isArray(table[part])) {
          throw new Error(`table ${namedTable[1]} conflicts with an existing value`);
        }
        table = table[part];
      }
      continue;
    }

    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!assignment) throw new Error(`invalid TOML syntax on line ${lineNumber}`);
    const key = assignment[1];
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error(`prototype pollution vector blocked on line ${lineNumber}`);
    if (Object.hasOwn(table, key)) {
      throw new Error(`duplicate key ${key} on line ${lineNumber}`);
    }
    table[key] = parseValue(assignment[2], lineNumber);
  }
  return result;
}

export function loadPicoConfig(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    return { raw, config: parsePicoConfig(raw), path };
  } catch (error) {
    if (error?.code === 'ENOENT') return { raw: '', config: {}, path };
    throw new Error(`cannot load ${path}: ${error.message}`, { cause: error });
  }
}

export function selectPhotoPrismSource(config) {
  const sources = Array.isArray(config?.sources) ? config.sources : [];
  const enabled = sources.filter((source) => source?.enabled !== false && source?.name === 'photoprism');
  if (enabled.length > 1) throw new Error('multiple enabled photoprism sources are not supported');
  return enabled[0] || null;
}
