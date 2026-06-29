const SLOT_COUNT = 5;

function buildSlots(container, sideClass) {
  for (let i = 0; i < SLOT_COUNT; i++) {
    const slot = document.createElement('div');
    slot.className = `slot ${sideClass}`;
    slot.id = `${sideClass}-${i}`;
    const fill = document.createElement('div');
    fill.className = 'fill';
    fill.style.width = '100%';
    slot.appendChild(fill);
    container.appendChild(slot);
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
