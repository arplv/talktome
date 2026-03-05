import { randomUUID } from "node:crypto";

export const PROTOCOL_VERSION = 1;

export function nowIso() {
  return new Date().toISOString();
}

export function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

export function clampInt(value, { min, max, fallback }) {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function makeId() {
  return randomUUID();
}

export function toJson(obj) {
  return JSON.stringify(obj);
}
