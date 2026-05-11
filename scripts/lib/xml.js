import fs from 'node:fs';
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  allowBooleanAttributes: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ['Song', 'Link', 'Poi'].includes(name),
});

export function readDatabase(filePath) {
  const xml = fs.readFileSync(filePath, 'utf8');
  const parsed = parser.parse(xml);
  const root = parsed.VirtualDJ_Database ?? parsed.virtualDJ_Database ?? parsed;
  const version = root.Version ?? null;
  const songs = Array.isArray(root.Song) ? root.Song : root.Song ? [root.Song] : [];
  return { version, songs, raw: parsed };
}
