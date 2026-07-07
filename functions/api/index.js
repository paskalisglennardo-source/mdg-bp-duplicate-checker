import { json } from '../_lib/duplicate.js';

export async function onRequestGet() {
  return json({ ok: true, service: 'MDG BP Duplicate Checker API', endpoints: ['/api/health', '/api/check'] });
}
