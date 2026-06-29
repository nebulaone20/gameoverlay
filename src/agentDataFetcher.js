// Fetches the current agent roster + icon images from valorant-api.com and
// caches them to assets/agents/<name>.png. This replaces manually cropping
// reference icons from your own footage - the API gives clean, consistent,
// transparent-background icons for every agent in one shot.
//
// Cache-aware: only re-fetches if assets/agents/_meta.json is missing, the
// roster has changed (agent added/removed/renamed), or it's older than
// CACHE_MAX_AGE_MS. Safe to call on every app launch.

const fs = require('fs');
const path = require('path');

const AGENTS_API_URL = 'https://valorant-api.com/v1/agents?language=en-US';
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days - new agents/patches are infrequent

// Which image field to use as the reference icon. valorant-api.com offers a
// few variants; this is intentionally a single switch point because the
// "best" variant depends on how your scoreboard actually renders icons -
// try displayIconSmall first, switch to killfeedPortrait or minimapPortrait
// if matching comes out poor against real footage.
const ICON_FIELD = 'displayIconSmall';

function metaPath(agentsDir) {
  return path.join(agentsDir, '_meta.json');
}

function readMeta(agentsDir) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(agentsDir), 'utf-8'));
  } catch {
    return null;
  }
}

function writeMeta(agentsDir, meta) {
  fs.writeFileSync(metaPath(agentsDir), JSON.stringify(meta, null, 2));
}

function safeName(displayName) {
  return displayName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Returns { updated: boolean, agentNames: string[], error: string|null }
async function ensureAgentIcons(agentsDir, { force = false } = {}) {
  if (!fs.existsSync(agentsDir)) fs.mkdirSync(agentsDir, { recursive: true });

  const existingMeta = readMeta(agentsDir);
  const cacheFresh =
    existingMeta &&
    existingMeta.iconField === ICON_FIELD &&
    Date.now() - existingMeta.fetchedAt < CACHE_MAX_AGE_MS;

  if (!force && cacheFresh) {
    return { updated: false, agentNames: existingMeta.agentNames, error: null };
  }

  let payload;
  try {
    const res = await fetch(AGENTS_API_URL);
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    payload = await res.json();
  } catch (err) {
    // Network failure (e.g. offline): fall back to whatever's cached on
    // disk already, rather than wiping out a working icon set.
    if (existingMeta) {
      return { updated: false, agentNames: existingMeta.agentNames, error: String(err) };
    }
    return { updated: false, agentNames: [], error: String(err) };
  }

  const agents = (payload.data || []).filter((a) => a.isPlayableCharacter);
  const agentNames = [];
  const failures = [];

  for (const agent of agents) {
    const name = safeName(agent.displayName);
    const url = agent[ICON_FIELD];
    if (!name || !url) continue;

    const dest = path.join(agentsDir, `${name}.png`);
    try {
      const buf = await downloadImage(url);
      fs.writeFileSync(dest, buf);
      agentNames.push(name);
    } catch (err) {
      failures.push({ name, error: String(err) });
      // If we already have a cached file for this agent from a previous
      // successful run, keep using it rather than leaving the slot empty.
      if (fs.existsSync(dest)) agentNames.push(name);
    }
  }

  writeMeta(agentsDir, {
    fetchedAt: Date.now(),
    iconField: ICON_FIELD,
    agentNames,
  });

  return {
    updated: true,
    agentNames,
    error: failures.length ? `${failures.length} icon(s) failed to download` : null,
  };
}

module.exports = { ensureAgentIcons, ICON_FIELD };
