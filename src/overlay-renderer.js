const SLOT_COUNT = 5;

function buildSlots(container, sideClass) {
  for (let i = 0; i < SLOT_COUNT; i++) {
    const wrap = document.createElement('div');
    wrap.className = 'slotWrap';

    const slot = document.createElement('div');
    slot.className = `slot ${sideClass}`;
    slot.id = `${sideClass}-${i}`;
    const fill = document.createElement('div');
    fill.className = 'fill';
    fill.style.width = '100%';
    slot.appendChild(fill);

    const tag = document.createElement('div');
    tag.className = 'agentTag unknown';
    tag.id = `${sideClass}-agent-${i}`;
    tag.textContent = '—';

    wrap.appendChild(slot);
    wrap.appendChild(tag);
    container.appendChild(wrap);
  }
}

buildSlots(document.getElementById('atk'), 'atk');
buildSlots(document.getElementById('def'), 'def');

window.bridge.onHealthUpdate((data) => {
  for (const entry of data.atk) updateSlot('atk', entry);
  for (const entry of data.def) updateSlot('def', entry);
});

function updateSlot(side, entry) {
  const slotEl = document.getElementById(`${side}-${entry.slot}`);
  if (!slotEl) return;
  const fillEl = slotEl.querySelector('.fill');
  fillEl.style.width = entry.health + '%';
  slotEl.classList.toggle('dead', !entry.alive);
}

// Agent icon updates arrive as { rows: [{row, team, agent, confidence}, ...],
// tabOpen, ts }. "team" is 'mine' or 'enemy' - the scoreboard groups by
// team membership, which is a different concept from atk/def (health bars'
// grouping), since atk/def sides swap at halftime but team membership
// doesn't. Mapping which team membership corresponds to which atk/def
// overlay slots is environment-specific (depends on which side you're on
// this half), so it's intentionally a simple, easily-swapped mapping below:
// 'mine' -> atk slots, 'enemy' -> def slots. Swap the two applyAgentTeam(...)
// calls if your testing shows the opposite once you check which side you're on.
window.bridge.onAgentUpdate((data) => {
  const mine = data.rows.filter((r) => r.team === 'mine');
  const enemy = data.rows.filter((r) => r.team === 'enemy');
  applyAgentTeam('atk', mine, data.tabOpen);
  applyAgentTeam('def', enemy, data.tabOpen);
});

function applyAgentTeam(sideClass, rows, tabOpen) {
  for (const entry of rows) {
    const tagEl = document.getElementById(`${sideClass}-agent-${entry.row}`);
    if (!tagEl) continue;

    if (entry.agent) {
      tagEl.textContent = entry.agent;
      tagEl.classList.remove('unknown');
    } else {
      tagEl.textContent = '—';
      tagEl.classList.add('unknown');
    }
    tagEl.classList.toggle('stale', !tabOpen);
  }
}
