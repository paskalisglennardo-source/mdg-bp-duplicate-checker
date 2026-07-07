import { handleHealth, handleOptions } from '../_lib/duplicate.js';

export async function onRequestOptions() {
  return handleOptions();
}

export async function onRequestGet(context) {
  return handleHealth(context);
}
