let trialStation = 'cocina';
const trialDisclosures = new Set();
const stationName = (station) => station === 'barra' ? 'Barra' : 'Cocina';
const partLabel = (status) => ({sent:'Pendiente',preparing:'En preparación',ready:'Listo'})[status] || status;
const portionLabel = q => q === 0.5 ? '½ porción' : `${q} ${q === 1 ? 'porción' : 'porciones'}`;
const pieceLabel = (q, name) => `${q} ${q === 1 ? ({'triángulos':'triángulo','rodajas':'rodaja','tostones':'tostón','tostadas':'tostada'}[name] || name) : name}`;
function trialDetails(item, station, part) {
  const modifiers = part.modifiers || [];
  const quantity = (m) => (item.unit_mode ? 1 : item.quantity) * m.quantity;
  const details = (part.details || []).map(text => `<div>${item.quantity} × ${escapeHtml(text)}</div>`).join('');
  const bread = (part.bread || []).map(b => `<div class="bread-portion"><b>${escapeHtml(b.name)}:</b> ${portionLabel(b.quantity)} · ${pieceLabel(b.quantity * b.pieces_per_portion, b.piece_name)}</div>`).join('');
  return bread + details + modifiers.map(m => `<div><b>${escapeHtml(m.group)}:</b> ${quantity(m)} × ${escapeHtml(m.name)}</div>`).join('');
}
function productionSummary(parts) {
  return ['cocina','barra'].filter(station => trialStation === 'todos' || trialStation === station).map(station => {
    const tasks = new Map();
    const add = (label, quantity, entry, bread = null) => {
      const note = entry.item.note || '';
      const key = `${label}\n${note}\n${bread?.pieces_per_portion || ''}\n${bread?.piece_name || ''}`;
      const row = tasks.get(key) || {label, note, quantity:0, bread, tables:new Set()};
      row.quantity += quantity; row.tables.add(entry.table.name); tasks.set(key,row);
    };
    parts.filter(entry => entry.station === station && entry.part.status !== 'ready').forEach(entry => {
      const {item,part} = entry;
      for (const b of part.bread || []) add(b.name, b.quantity, entry, b);
      const modifiers = part.modifiers || [];
      const size = modifiers.find(m => m.group === 'Tamaño');
      if (size) add(`${item.name} · ${size.name}`,item.quantity,entry);
      for (const text of part.details || []) {
        if (size && text === item.name) continue;
        if (modifiers.some(m => m.group === 'Tostado') && text === 'Tostado de jamón, queso, tomate y orégano') continue;
        add(text,item.quantity,entry);
      }
      for (const m of modifiers) {
        if (m.group === 'Tamaño') continue;
        add(m.name,(item.unit_mode ? 1 : item.quantity) * m.quantity,entry);
      }
    });
    return `<section class="production-summary"><h2>${stationName(station)} · A preparar</h2><p>Incluye pendientes y en preparación. Las cantidades listas se descuentan.</p>${[...tasks.values()].map(row => `<div class="summary-task"><strong>${row.bread ? (row.quantity === 0.5 ? "½" : row.quantity) + " porc." : row.quantity + "×"}</strong><div><b>${escapeHtml(row.label)}${row.bread?.piece_name === "tostadas" ? " · Avocado" : ""}</b>${row.bread?`<p class="bread-total">${pieceLabel(row.quantity * row.bread.pieces_per_portion, row.bread.piece_name)} en total</p>`:""}${row.note?`<p class="summary-note">Nota: ${escapeHtml(row.note)}</p>`:''}<small>${[...row.tables].map(escapeHtml).join(' · ')}</small></div></div>`).join('') || '<p>✓ Sin preparaciones pendientes</p>'}</section>`;
  }).join('');
}
renderKitchen = function () {
  const tables = state.tables.filter(t => t.status === 'open' && t.items.some(i => i.production && ['sent','preparing','suspended'].includes(i.status)));
  tables.sort((a,b) => {
    const oldest = t => Math.min(...t.items.filter(i=>i.production && ['sent','preparing','suspended'].includes(i.status)).map(i=>Date.parse(i.sent_at)||0));
    const priority = t => t.items.some(i=>i.priority && ['sent','preparing','suspended'].includes(i.status));
    return Number(priority(b))-Number(priority(a)) || oldest(a)-oldest(b);
  });
  const parts = tables.flatMap(table => table.items.filter(i => i.production && ['sent','preparing','suspended'].includes(i.status)).flatMap(item => Object.entries(item.production).map(([station,part])=>({table,item,station,part}))));
  const pending = station => parts.filter(p => p.station === station && p.part.status !== 'ready').length;
  const cards = tables.map(table => {
    const items = table.items.filter(i=>i.production && ['sent','preparing','suspended'].includes(i.status) && (trialStation==='todos' || i.production[trialStation]?.status !== 'ready' && i.production[trialStation]));
    if (!items.length) return '';
    const oldest = items.reduce((a,b)=>Date.parse(a.sent_at)<Date.parse(b.sent_at)?a:b);
    const timing = kitchenTiming(oldest.sent_at);
    const rows = items.map(item => {
      const all = Object.entries(item.production);
      const other = all.filter(([station])=>trialStation!=='todos' && station!==trialStation).map(([station,p])=>`${stationName(station)}: ${partLabel(p.status)}`).join(' · ');
      const panels = all.filter(([station])=>trialStation==='todos'||station===trialStation).map(([station,part]) => `<section class="station-part ${part.status==='ready'?'part-ready':''}"><div class="station-part-head"><strong>${stationName(station)}</strong><span>${partLabel(part.status)}</span></div><div class="station-details">${trialDetails(item,station,part)}</div>${part.status==='ready'?'<p class="part-done">✓ Esta parte ya está lista</p>':`<button class="button button-primary" data-trial-status="${part.status==='sent'?'preparing':'ready'}" data-station="${station}" data-trial-table="${escapeHtml(table.id)}" data-item="${escapeHtml(item.id)}">${part.status==='sent'?'Empezar':'Marcar listo'} · ${stationName(station)}</button>`}</section>`).join('');
      return `<article class="trial-product"><h3><span>${item.quantity}×</span> ${escapeHtml(item.name)}</h3>${item.order_round > 1 ? `<div class="new-order-badge">NUEVO · Pedido ${item.order_round}</div>` : ""}<p class="trial-wait">${kitchenTiming(item.sent_at).minutes} min${item.priority?' · PRIORIDAD':''}</p><div class="station-panels">${panels}</div>${item.note?`<p class="ticket-note"><b>Nota:</b> ${escapeHtml(item.note)}</p>`:''}<details class="trial-extra" data-disclosure="${escapeHtml(item.id)}" ${trialDisclosures.has(item.id)?'open':''}><summary>Ver detalles</summary><p>Enviado: ${kitchenSentTime(item.sent_at)}${item.order_round ? ` · Pedido ${item.order_round}` : ''}</p>${other?`<p class="other-station">${escapeHtml(other)}</p>`:''}<p class="trial-coordination">El aviso al mozo llega cuando todos los sectores terminan.</p></details></article>`;
    }).join('');
    return `<section class="kitchen-ticket"><header class="ticket-head ${timing.className}"><div class="ticket-heading-main"><div class="ticket-heading-top"><span>${escapeHtml(tableZone(table))}</span><strong>${timing.minutes} min</strong></div><h2>${escapeHtml(table.name)}</h2><p>${items.length} productos en curso</p></div></header><div>${rows}</div></section>`;
  }).join('');
  appRoot.innerHTML = `<div class="kitchen-board-heading"><div><p class="eyebrow">Producción por sector</p><h1>${trialStation==='todos'?'Barra y cocina':stationName(trialStation)}</h1></div></div><nav class="trial-stations" aria-label="Sector de producción">${[['todos','Vista general',parts.filter(p=>p.part.status!=='ready').length],['barra','Barra',pending('barra')],['cocina','Cocina',pending('cocina')]].map(([id,label,count])=>`<button class="button ${trialStation===id?'button-primary':'button-secondary'}" data-trial-station="${id}">${label} <b>${count}</b></button>`).join('')}</nav><details class="summary-disclosure" data-disclosure="summary" ${trialDisclosures.has("summary")?"open":""}><summary>Ver cantidades a preparar</summary><div class="production-summary-grid">${productionSummary(parts)}</div></details><div class="kitchen-grid">${cards||'<section class="section-panel"><h2>Sector al día</h2><p>No hay preparaciones pendientes en este sector. Podés ver el aviso de retiro en Mesas.</p></section>'}</div>`;
};
document.addEventListener('click', async (event) => {
  const sector = event.target.closest('[data-trial-station]');
  if (sector) { trialStation=sector.dataset.trialStation; renderKitchen(); }
  const button = event.target.closest('[data-trial-status]');
  if (button) {
    button.disabled=true;
    await sendAction({type:'station_status',table_id:button.dataset.trialTable,item_id:button.dataset.item,station:button.dataset.station,status:button.dataset.trialStatus},'Sector actualizado.');
  }
});


document.addEventListener('toggle', event => {
  const key = event.target.dataset?.disclosure;
  if (key) { if (event.target.open) trialDisclosures.add(key); else trialDisclosures.delete(key); }
}, true);
