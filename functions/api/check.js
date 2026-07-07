import { handleCheck, handleOptions, json } from '../_lib/duplicate.js';

export async function onRequestOptions() {
  return handleOptions();
}

export async function onRequestPost(context) {
  return handleCheck(context);
}

export async function onRequestGet() {
  return json({ ok: true, endpoint: '/api/check', method: 'POST' });
}
