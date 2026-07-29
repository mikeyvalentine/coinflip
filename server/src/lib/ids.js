// ids.js — opaque, unguessable, sortable-enough ids.
// Player-visible ids must not leak the Google subject or a sequence position.

import { randomBytes } from './crypto.js';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford-ish, no i l o u

function encode(bytes) {
  let out = '';
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
}

export function newId(prefix, length = 22) {
  return `${prefix}_${encode(randomBytes(length))}`;
}

export const newUserId = () => newId('usr');
export const newRoundId = () => newId('rnd');
export const newImportId = () => newId('imp');
