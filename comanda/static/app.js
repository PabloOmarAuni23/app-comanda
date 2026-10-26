const appRoot = document.querySelector("#app");
const dialog = document.querySelector("#dialog");
const dialogForm = document.querySelector("#dialogForm");
const dialogBody = document.querySelector("#dialogBody");
const dialogActions = document.querySelector("#dialogActions");
const toastElement = document.querySelector("#toast");
const syncElement = document.querySelector("#syncState");
const waiterInput = document.querySelector("#waiterName");
const readyNoticeElement = document.querySelector("#readyNotice");

let state = null;
let activeView = "home";
let activeTableId = null;
let activeCategory = "Todas";
let productSearch = "";
let activeProductPreview = null;
let kitchenTimingFilter = "all";
let currentRole = "";
try { currentRole = localStorage.getItem("comandaRole") || ""; } catch (error) { currentRole = ""; }
let lastToastTimer;
let deferredInstallPrompt = null;
let requestPending = false;

waiterInput.value = "";
waiterInput.addEventListener("change", () => {
  const name = waiterInput.value.trim().slice(0, 40);
  waiterInput.value = name;
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function money(value) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(Number(value) || 0);
}

function tableTotal(table) {
  return table.items.reduce((sum, item) => sum + (item.status === "canceled" ? 0 : item.price * item.quantity), 0);
}

function itemModifierParts(item) {
  return (item.modifiers || []).map((modifier) => {
    if (item.unit_mode) return { group: "", option: `${modifier.name} ${modifier.quantity}` };
    const quantity = modifier.quantity * item.quantity;
    return { group: String(modifier.group ?? ""), option: quantity > 1 ? `${quantity} × ${modifier.name}` : String(modifier.name ?? "") };
  });
}

function itemModifierLines(item) {
  return itemModifierParts(item).map((part) => `${part.group ? `${escapeHtml(part.group)}: ` : ""}${escapeHtml(part.option)}`);
}

function itemModifierSummary(item) {
  return itemModifierLines(item).join(" · ");
}

function itemModifierText(item) {
  return itemModifierParts(item).map((part) => `${part.group ? `${part.group}: ` : ""}${part.option}`).join(" · ");
}

function guestsSuffix(table) {
  const guests = Number(table.guests);
  if (!Number.isFinite(guests) || guests < 1) return "";
  return ` · ${guests} ${guests === 1 ? "persona" : "personas"}`;
}

function orderFlow(table) {
  const counts = { draft: 0, sent: 0, preparing: 0, suspended: 0, ready: 0 };
  table.items.forEach((item) => { if (item.status in counts) counts[item.status] += 1; });
  const chips = [];
  if (counts.draft) chips.push(["flow-draft", `${counts.draft} sin enviar`]);
  if (counts.sent) chips.push(["flow-sent", `${counts.sent} en cocina`]);
  if (counts.preparing) chips.push(["flow-preparing", `${counts.preparing} preparando`]);
  if (counts.suspended) chips.push(["flow-suspended", `${counts.suspended} demorado${counts.suspended > 1 ? "s" : ""}`]);
  if (counts.ready) chips.push(["flow-ready", `${counts.ready} listo${counts.ready > 1 ? "s" : ""}`]);
  return chips.length ? `<span class="flow-chips">${chips.map(([cls, label]) => `<b class="flow-chip ${cls}">${label}</b>`).join("")}</span>` : "";
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, "\"\"")}"`;
}

function downloadTableReport(table) {
  const header = ["Mesa", "Comensales", "Atiende", "Producto", "Cantidad", "Detalle (agregados, acompañamientos)", "Nota para cocina", "Prioridad", "Estado", "Precio unitario", "Importe", "Agregado por", "Enviado a cocina"];
  const rows = table.items.map((item) => [
    table.name,
    Number(table.guests) > 0 ? table.guests : "",
    table.opened_by,
    item.name,
    item.quantity,
    itemModifierText(item),
    item.note || "",
    item.priority ? "Sí" : "No",
    statusLabel(item.status),
    item.price,
    item.price * item.quantity,
    item.added_by || "",
    item.sent_at || "",
  ]);
  const totalUnits = table.items.reduce((sum, item) => sum + item.quantity, 0);
  rows.push(["TOTAL", "", "", "", totalUnits, "", "", "", "", "", tableTotal(table), "", ""]);
  const csv = "\uFEFF" + [header, ...rows].map((row) => row.map(csvCell).join(";")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const slug = table.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "mesa";
  link.href = url;
  link.download = `comanda-${slug}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function statusLabel(status) {
  return ({ free: "Libre", open: "Abierta", cleaning: "Para limpiar", draft: "Sin enviar", sent: "En cocina", preparing: "En proceso", ready: "Listo", suspended: "Demorado" })[status] || status;
}

function showToast(message, error = false) {
  toastElement.textContent = message;
  toastElement.style.background = error ? "#9e4034" : "#171b1a";
  toastElement.classList.add("show");
  clearTimeout(lastToastTimer);
  lastToastTimer = setTimeout(() => toastElement.classList.remove("show"), 2600);
}

function setSyncStatus(online) {
  syncElement.classList.toggle("online", online);
  syncElement.classList.toggle("offline", !online);
  syncElement.lastElementChild.textContent = online ? "Sincronizado" : "Sin conexión";
}

async function loadState(forceRender = false) {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error("No se pudo leer la comanda.");
    const nextState = await response.json();
    const changed = !state || nextState.updated_at !== state.updated_at;
    state = nextState;
    setSyncStatus(true);
    if (changed || forceRender) render();
  } catch (error) {
    setSyncStatus(false);
  }
}

async function sendAction(action, successMessage) {
  if (requestPending) return;
  requestPending = true;
  try {
    const response = await fetch("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "No se pudo guardar el cambio.");
    state = result;
    setSyncStatus(true);
    render();
    if (successMessage) showToast(successMessage);
    return true;
  } catch (error) {
    showToast(error.message || "Revisá la conexión e intentá de nuevo.", true);
    await loadState(true);
    return false;
  } finally {
    requestPending = false;
  }
}

function volatileBanner() {
  if (!state?.storage_volatile) return "";
  return `<div class="storage-warning" role="alert"><strong>⚠ Los datos no se están guardando</strong><span>Este servidor gratuito borra la carta, las mesas y las ventas cada vez que se reinicia o se actualiza. Conectá una base de datos (ver README) para que queden guardados.</span></div>`;
}

function pageHeading(eyebrow, title, subtitle, button = "") {
  return `<div class="page-heading"><div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div>${button}</div>`;
}

function renderReadyNotice() {
  if (!["mozo", "barra"].includes(currentRole)) {
    readyNoticeElement.hidden = true;
    readyNoticeElement.innerHTML = "";
    return;
  }
  const readyTables = state.tables
    .filter((table) => table.status === "open")
    .map((table) => ({ ...table, readyItems: table.items.filter((item) => item.status === "ready") }))
    .filter((table) => table.readyItems.length);
  const readyItems = readyTables.flatMap((table) => table.readyItems.map((item) => ({ table, item })));

  readyNoticeElement.hidden = readyItems.length === 0;
  if (!readyItems.length) {
    readyNoticeElement.innerHTML = "";
    return;
  }

  const previewItems = readyItems.slice(0, 3);
  const preview = previewItems.map(({ table, item }) => `${escapeHtml(table.name)} · ${item.quantity} × ${escapeHtml(item.name)}`).join(" &nbsp; | &nbsp; ");
  const remaining = readyItems.length - previewItems.length;
  const readyTableCount = readyTables.length;
  const summary = `${readyTableCount} ${readyTableCount === 1 ? "mesa" : "mesas"} · ${readyItems.length} ${readyItems.length === 1 ? "producto listo" : "productos listos"} para retirar`;
  const targetTable = readyTables[0];

  readyNoticeElement.dataset.tableId = targetTable.id;
  readyNoticeElement.setAttribute("aria-label", `${summary}. Ir a ${targetTable.name} para retirar el pedido.`);
  readyNoticeElement.innerHTML = `<span class="ready-notice-icon" aria-hidden="true">!</span><span class="ready-notice-copy"><strong>¡Hay pedidos listos para retirar!</strong><span>${summary}</span><span class="ready-notice-items">${preview}${remaining ? ` &nbsp; | &nbsp; y ${remaining} más` : ""}</span></span><span class="ready-notice-action">Ir a buscar →</span>`;
}

const SHIFT_LABELS = { morning: "mañana", afternoon: "tarde" };

function formatTimeOfDay(timestamp) {
  return new Intl.DateTimeFormat("es-AR", { hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
}

function closureMessage(closure) {
  const label = SHIFT_LABELS[closure.shift] || closure.shift;
  const when = (timestamp) => new Date(timestamp).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
  const lines = closure.items.map((item) => `• ${item.name}: ${item.quantity}`);
  return [
    `CIERRE TURNO ${label.toUpperCase()}`,
    closure.started_at ? `Inicio: ${when(closure.started_at)}` : "",
    `Cierre: ${when(closure.closed_at)}`,
    "",
    `Ventas cobradas: ${money(closure.total_amount || 0)} (${closure.tickets || 0} ${closure.tickets === 1 ? "cobro" : "cobros"})`,
    "",
    "Productos vendidos:",
    ...(lines.length ? lines : ["(sin ventas)"]),
    "",
    `Total de unidades: ${closure.total_units}`,
  ].filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n");
}

function whatsappUrl(closure) {
  return `https://wa.me/?text=${encodeURIComponent(closureMessage(closure))}`;
}

function showShiftClosedDialog(closure) {
  const label = SHIFT_LABELS[closure.shift] || closure.shift;
  const body = `<div class="shift-summary"><div><span>Ventas cobradas</span><strong>${money(closure.total_amount || 0)}</strong></div><div><span>Cobros</span><strong>${closure.tickets || 0}</strong></div><div><span>Unidades</span><strong>${closure.total_units}</strong></div></div><p class="dialog-hint">Mandá las estadísticas del turno por WhatsApp. También podés enviarlas más tarde desde Estadística.</p>`;
  showDialog({ eyebrow: "Turno cerrado", title: `Turno ${label}`, body, submitLabel: "Enviar estadísticas por WhatsApp", cancelLabel: "Ahora no", onSubmit: () => {
    window.open(whatsappUrl(closure), "_blank");
    return true;
  } });
}

function renderShiftStart() {
  readyNoticeElement.hidden = true;
  readyNoticeElement.innerHTML = "";
  const closures = Array.isArray(state.sales_closures) ? state.sales_closures : [];
  const last = closures[closures.length - 1];
  const lastText = last ? `Último cierre: turno ${SHIFT_LABELS[last.shift] || last.shift} · ${new Date(last.closed_at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}` : "Todavía no hay turnos cerrados.";
  const suggested = new Date().getHours() < 15 ? "morning" : "afternoon";
  const card = (shift, icon, title, hours) => `<button class="role-card ${shift === suggested ? "suggested" : ""}" type="button" data-action="shift-start" data-shift="${shift}"><span class="role-icon" aria-hidden="true">${icon}</span><strong>${title}</strong><span>${hours}</span></button>`;
  appRoot.innerHTML = `${volatileBanner()}<section class="role-screen"><div class="role-brand"><span class="brand-mark" aria-hidden="true">C</span><p class="eyebrow">Comanda del bar</p><h1>Iniciar turno</h1><p>Elegí el turno para abrir el negocio. Los datos se mantienen hasta que cierres el turno.</p></div><div class="role-grid">${card("morning", "☀", "Turno mañana", "Desayunos y meriendas")}${card("afternoon", "🌙", "Turno tarde", "Tarde y noche")}</div><p class="order-meta shift-last">${escapeHtml(lastText)}</p></section>`;
}

function applyRoleUi() {
  const picking = !currentRole;
  const kitchenOnly = currentRole === "cocina";
  const shift = state?.shift;
  const shiftBadge = document.querySelector("#shiftBadge");
  shiftBadge.hidden = picking || !shift;
  if (shift) shiftBadge.textContent = `Turno ${SHIFT_LABELS[shift.type] || shift.type}`;
  document.querySelector(".main-nav").hidden = picking || kitchenOnly || (Boolean(state) && !shift);
  document.querySelector(".waiter-field").hidden = picking || kitchenOnly;
  document.querySelector("#roleButton").hidden = picking;
  document.querySelectorAll(".nav-button").forEach((button) => {
    if (picking) button.classList.remove("active");
    else if (kitchenOnly) button.classList.toggle("active", button.dataset.view === "kitchen");
    else {
      const currentView = activeView === "table-detail" ? "tables" : activeView;
      button.classList.toggle("active", button.dataset.view === currentView && (!button.dataset.zone || button.dataset.zone === activeZone));
    }
  });
}

function renderRolePicker() {
  applyRoleUi();
  readyNoticeElement.hidden = true;
  readyNoticeElement.innerHTML = "";
  appRoot.innerHTML = `<section class="role-screen"><div class="role-brand"><span class="brand-mark" aria-hidden="true">C</span><p class="eyebrow">Comanda del bar</p><h1>¿Cómo entrás hoy?</h1><p>Elegí un perfil para empezar. Podés cambiarlo cuando quieras con el botón ⇄ de la barra superior.</p></div><div class="role-grid role-profile-grid"><button class="role-card" type="button" data-role="mozo"><span class="role-icon" aria-hidden="true">🍽</span><strong>Mozo / Moza</strong><span>Ves todo: mesas, carta, cocina, estado de los pedidos y descarga del detalle de cada mesa.</span></button><button class="role-card" type="button" data-role="barra"><span class="role-icon" aria-hidden="true">▤</span><strong>Barra / Cajero</strong><span>Mesas, pedidos, cobros, carta, estadísticas y seguimiento de barra y cocina.</span></button><button class="role-card" type="button" data-role="cocina"><span class="role-icon" aria-hidden="true">♨</span><strong>Cocina</strong><span>Solo la producción: comandas, agregados, notas, prioridades y estados.</span></button></div></section>`;
}

function render() {
  if (!currentRole) { renderRolePicker(); return; }
  if (!state) return;
  if (currentRole === "cocina") activeView = "kitchen";
  applyRoleUi();
  if (!state.shift) { renderShiftStart(); return; }
  renderReadyNotice();
  if (activeView === "home") renderHome();
  if (activeView === "tables") renderTables();
  if (activeView === "table-detail") renderTableDetail();
  if (activeView === "kitchen") renderKitchen();
  if (activeView === "statistics") renderStatistics();
  if (activeView === "menu") renderMenu();
}

function renderHome() {
  const openTables = state.tables.filter((table) => table.status === "open");
  const billableUnits = (table) => table.items.filter((item) => item.status !== "canceled").reduce((sum, item) => sum + item.quantity, 0);
  const openTotal = openTables.reduce((sum, table) => sum + tableTotal(table), 0);
  const openUnits = openTables.reduce((sum, table) => sum + billableUnits(table), 0);
  const tickets = Array.isArray(state.pending_tickets) ? state.pending_tickets : [];
  const closedTotal = tickets.reduce((sum, ticket) => sum + Number(ticket.total || 0), 0);
  const closedUnits = tickets.reduce((sum, ticket) => sum + Number(ticket.units || 0), 0);
  const cooking = state.tables.flatMap((table) => table.items).filter((item) => ["sent", "preparing", "suspended"].includes(item.status)).length;
  const ready = state.tables.flatMap((table) => table.items).filter((item) => item.status === "ready").length;
  const plural = (count, singular, pluralForm) => `${count} ${count === 1 ? singular : pluralForm}`;
  const liveOrders = openTables.filter((table) => table.items.length);
  const openRows = liveOrders.length ? liveOrders.map((table) => `<button class="order-row" data-table="${escapeHtml(table.id)}"><span><span class="order-name">${escapeHtml(table.name)}</span><br><span class="order-meta">${plural(table.items.length, "producto", "productos")} · ${escapeHtml(table.opened_by)}${guestsSuffix(table)}</span></span>${orderFlow(table) || `<span class="status open">En curso</span>`}<span class="order-price">${money(tableTotal(table))}</span></button>`).join("") : `<div class="activity-empty"><div class="empty-mark">⌂</div>Las mesas abiertas van a aparecer acá.</div>`;
  const formatTime = (timestamp) => new Intl.DateTimeFormat("es-AR", { hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
  const closedRows = tickets.length ? tickets.slice().reverse().map((ticket) => `<div class="order-row"><span><span class="order-name">${escapeHtml(ticket.table_name)}</span><br><span class="order-meta">${plural(Number(ticket.units) || 0, "unidad", "unidades")} · ${formatTime(ticket.paid_at)}</span></span><span class="status ready">Cobrada</span><span class="order-price">${money(ticket.total)}</span></div>`).join("") : `<div class="activity-empty"><div class="empty-mark">$</div>Los cobros del turno van a aparecer acá.</div>`;

  appRoot.innerHTML = `${volatileBanner()}${pageHeading(`Turno ${SHIFT_LABELS[state.shift.type] || state.shift.type} · desde ${formatTimeOfDay(state.shift.started_at)}`, "Ventas del turno", `Total ${money(openTotal + closedTotal)} · cobrado y por cobrar, actualizado en todos los dispositivos.`, `<div class="page-heading-buttons"><button class="button button-secondary" data-go="statistics">Estadística</button><button class="button button-secondary" data-action="shift-correct">Corregir turno</button><button class="button button-primary" data-action="shift-close">Cerrar turno</button></div>`)}
    <section class="stats" aria-label="Resumen de ventas y cocina">
      <div class="stat"><div class="stat-label">Ventas abiertas</div><div class="stat-value">${money(openTotal)}</div><div class="stat-sub">${plural(openTables.length, "mesa", "mesas")} · ${plural(openUnits, "unidad", "unidades")}</div></div>
      <div class="stat"><div class="stat-label">Ventas cerradas</div><div class="stat-value">${money(closedTotal)}</div><div class="stat-sub">${plural(tickets.length, "cobro", "cobros")} · ${plural(closedUnits, "unidad", "unidades")}</div></div>
      <div class="stat"><div class="stat-label">En cocina</div><div class="stat-value accent">${cooking}</div><div class="stat-sub">productos en preparación</div></div>
      <div class="stat"><div class="stat-label">Listos para retirar</div><div class="stat-value">${ready}</div><div class="stat-sub">esperando al mozo</div></div>
    </section>
    <div class="home-grid">
      <section class="section-panel"><div class="section-title"><h2>Ventas abiertas</h2><button class="text-button" data-go="kitchen">Abrir cocina →</button></div><div class="order-list">${openRows}</div></section>
      <section class="section-panel"><div class="section-title"><h2>Ventas cerradas</h2><button class="text-button" data-go="statistics">Estadística →</button></div><div class="order-list">${closedRows}</div></section>
    </div>`;
}
function renderStatistics() {
  const pendingSales = Array.isArray(state.pending_sales) ? state.pending_sales : [];
  const closures = Array.isArray(state.sales_closures) ? state.sales_closures : [];
  const totalUnits = pendingSales.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const saleRows = pendingSales.length
    ? pendingSales.map((item) => `<div class="sales-row"><span>${escapeHtml(item.name)}</span><strong>${Number(item.quantity) || 0}</strong></div>`).join("")
    : `<div class="empty-state">Todavía no hay ventas pendientes de cierre.</div>`;
  const history = closures.slice(-6).reverse().map((closure) => {
    const shiftLabel = closure.shift === "morning" ? "Mañana" : "Tarde";
    const closedDate = new Date(closure.closed_at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
    const items = closure.items.map((item) => `<span>${escapeHtml(item.name)} × ${Number(item.quantity) || 0}</span>`).join("");
    return `<article class="sales-closure"><div class="sales-closure-head"><strong>Turno ${shiftLabel}</strong><span>${closedDate}</span></div><div class="sales-closure-items">${items}</div><strong class="sales-closure-total">${money(closure.total_amount || 0)} · ${Number(closure.total_units) || 0} unidades</strong><button class="button button-secondary button-small" type="button" data-action="closure-whatsapp" data-closure-id="${escapeHtml(closure.id)}">Enviar por WhatsApp</button></article>`;
  }).join("");
  appRoot.innerHTML = `${pageHeading("Ventas", "Estadística", "Unidades de productos cobrados desde el inicio del turno.", `<button class="button button-secondary" data-go="home">← Inicio</button>`)}
    <section class="section-panel sales-summary"><div class="section-title"><div><h2>Turno en curso</h2><p class="order-meta">${pendingSales.length} productos · ${totalUnits} unidades</p></div></div><div class="sales-list">${saleRows}</div><div class="sales-close-actions"><button class="button button-primary" data-action="shift-close">Cerrar turno ${SHIFT_LABELS[state.shift.type] || ""} y enviar estadísticas</button></div></section>
    <section class="section-panel sales-history"><div class="section-title"><h2>Últimos cierres</h2></div>${history || `<p class="order-meta">Todavía no hay cierres guardados.</p>`}</section>`;
}

const TABLE_ZONES = ["Salón adentro", "Salón afuera"];
let activeZone = TABLE_ZONES[0];

function tableZone(table) {
  return TABLE_ZONES.includes(table.zone) ? table.zone : "Salón afuera";
}

function renderTables() {
  const createButton = `<button class="button button-primary" data-action="add-table">＋ <span>Mesa</span></button>`;
  const renderTile = (table) => {
    const description = table.status === "open" ? `${table.items.length} productos · ${money(tableTotal(table))}` : table.status === "cleaning" ? "Cobro registrado" : "Tocá para abrir";
    const caption = table.status === "open" ? `Atiende ${table.opened_by}${guestsSuffix(table)}` : statusLabel(table.status);
    return `<button class="table-tile ${table.status}" data-table="${escapeHtml(table.id)}"><span class="status ${table.status}">${statusLabel(table.status)}</span><strong>${escapeHtml(table.name)}</strong><span class="table-detail">${escapeHtml(description)}</span><span class="table-detail">${escapeHtml(caption)}</span>${table.status === "open" ? orderFlow(table) : ""}</button>`;
  };
  const zoneTables = state.tables.filter((table) => tableZone(table) === activeZone);
  const zoneOpen = zoneTables.filter((table) => table.status === "open").length;
  appRoot.innerHTML = `${pageHeading("Servicio", activeZone, `${zoneOpen} de ${zoneTables.length} ocupadas · tocá una mesa para abrirla o ver el pedido.`, createButton)}<div class="table-grid">${zoneTables.map(renderTile).join("")}</div>`;
}


function productArt(dish) {
  const text = `${dish.name || ""} ${dish.category || ""}`.toLowerCase();
  let kind = "breakfast";
  if (/tortilla/.test(String(dish.name || "").toLowerCase())) kind = "flatbread";
  else if (/bollito/.test(text)) kind = "bread";
  else if (/manteca|mantequilla/.test(text)) kind = "butter";
  else if (/mermelada|dulce de leche/.test(text)) kind = "jam";
  else if (/queso/.test(text) && !/jamón|sandwich|tostado/.test(text)) kind = "cheese";
  else if (/sandwich|tostado|jamón|avocado/.test(text)) kind = "sandwich";
  else if (/torta|factura|medialuna|tortilla|acompañar|dulce/.test(text)) kind = "pastry";
  else if (/bebidas en general|gaseosa|agua|licuado|refrescante|limonada/.test(text)) kind = "drink";
  else if (/café|cafetería|capuchino|expresso|cortado|macchiato|calientes|infusiones/.test(text)) kind = "coffee";
  const arts = {
    flatbread: `<ellipse cx="100" cy="132" rx="70" ry="11" fill="#c8b99b"/><ellipse cx="100" cy="104" rx="65" ry="24" fill="#ce914d"/><ellipse cx="100" cy="94" rx="65" ry="25" fill="#edc47e"/><path d="M53 89q47-25 94 0m-100 14q52-24 106 0" fill="none" stroke="#d29e59" stroke-width="5" stroke-linecap="round"/><path d="M73 77l8 8m25-10l8 8m17 7l8 8m-43-3l8 8m-32-3l7 8" stroke="#bd8447" stroke-width="3" stroke-linecap="round"/>`,
    bread: `<ellipse cx="100" cy="132" rx="72" ry="11" fill="#c5bda5"/><path d="M35 112q-9-53 39-53t35 53z" fill="#dfa75b"/><path d="M92 120q-9-63 38-63t39 63z" fill="#e4b86e"/><path d="M55 83l14-13m-2 26l17-16m32 5l15-15m-3 28l15-15" stroke="#f7dca7" stroke-width="7" stroke-linecap="round"/>`,
    butter: `<ellipse cx="100" cy="130" rx="68" ry="12" fill="#c3c5aa"/><path d="M33 117l25-33 97 5 17 28-66 19z" fill="#f0eee0"/><path d="M57 80l55-19 37 20v32l-58 15-34-18z" fill="#edc85d"/><path d="M57 80l55-19 37 20-58 17z" fill="#ffe6a0"/><path d="M91 98v30" stroke="#cda541" stroke-width="3"/>`,
    cheese: `<ellipse cx="100" cy="131" rx="67" ry="12" fill="#c6c4a4"/><path d="M43 91l87-44 29 53-83 32-33-18z" fill="#e4ad43"/><path d="M43 91l87-44 29 53-83 17z" fill="#f8d56f"/><path d="M76 117v15l83-32" fill="#d99837"/><ellipse cx="93" cy="86" rx="9" ry="5" fill="#dba744"/><ellipse cx="126" cy="95" rx="8" ry="5" fill="#dba744"/><ellipse cx="121" cy="67" rx="6" ry="4" fill="#dba744"/><circle cx="58" cy="107" r="5" fill="#c99132"/>`,
    jam: `<ellipse cx="100" cy="135" rx="47" ry="9" fill="#c7bca8"/><rect x="65" y="45" width="70" height="85" rx="15" fill="#9e4a3d"/><path d="M68 65h64v49q-31 17-64 0z" fill="#ba6451"/><rect x="71" y="76" width="58" height="35" rx="4" fill="#f0dfbe"/><path d="M99 83c-21-9-23 15 0 22 23-7 21-31 0-22" fill="#c3604e"/><path d="M99 84l7-9" stroke="#6f8d59" stroke-width="4"/><rect x="62" y="35" width="76" height="18" rx="5" fill="#d2b67e"/><path d="M72 39v10m10-10v10m10-10v10m10-10v10m10-10v10m10-10v10" stroke="#a78a56" stroke-width="2"/>`,
    coffee: `<ellipse cx="100" cy="128" rx="63" ry="12" fill="#a8c9ab"/><path d="M136 65h10c30 0 26 44-4 44h-9" fill="none" stroke="#f3d7b0" stroke-width="11"/><path d="M55 58h85l-8 55q-4 18-30 18h-11q-26 0-30-18z" fill="#f4dfc0"/><ellipse cx="97" cy="59" rx="42" ry="10" fill="#d5ad79"/><ellipse cx="97" cy="59" rx="33" ry="7" fill="#79503a"/><path d="M80 43c-12-15 13-15 2-30m23 30c-12-15 13-15 2-30" fill="none" stroke="#a8c9ab" stroke-width="4" stroke-linecap="round"/>`,
    pastry: `<ellipse cx="100" cy="132" rx="73" ry="10" fill="#cabb9a"/><path d="M30 106q-4-40 34-52l16 17q20-10 40 0l16-17q38 12 34 52l-21 14-20-20q-29-13-58 0l-20 20z" fill="#e9a14f" stroke="#ae6a35" stroke-width="3"/><path d="M64 54l7 46m9-29l4 24m36-24l-4 24m20-41l-7 46" stroke="#f9ce7d" stroke-width="8" stroke-linecap="round"/>`,
    drink: `<ellipse cx="100" cy="136" rx="47" ry="9" fill="#b0c4a1"/><path d="M66 41h68l-9 90H75z" fill="#e7f0dc"/><path d="M71 65h58l-7 62H78z" fill="#eda34e"/><path d="M105 94l16-77h25" fill="none" stroke="#6e927a" stroke-width="6" stroke-linecap="round"/><path d="M85 74l12 3-3 13-12-3zm20 25l12 3-3 13-12-3z" fill="#f9d89d"/><circle cx="137" cy="57" r="21" fill="#f6d46d" stroke="#fff0ab" stroke-width="4"/><path d="M137 39v36m-18-18h36m-31-13l26 26m0-26l-26 26" stroke="#fff0ab" stroke-width="2"/>`,
    sandwich: `<ellipse cx="100" cy="134" rx="72" ry="10" fill="#bdc7a7"/><path d="M34 107l66-61 66 61-66 27z" fill="#d7964c"/><path d="M32 93l68-45 68 45-68 29z" fill="#729a58"/><path d="M34 83l66-44 66 44-66 28z" fill="#e9b96a"/><path d="M34 76l66-48 66 48-66 26z" fill="#f3d7a0" stroke="#cc9d64" stroke-width="3"/><path d="M60 69l35-25m-15 35l35-25m-15 35l35-25" stroke="#d4a16a" stroke-width="5" stroke-linecap="round"/>`,
    breakfast: `<ellipse cx="103" cy="116" rx="83" ry="29" fill="#c1ceba"/><ellipse cx="103" cy="111" rx="73" ry="24" fill="#eaf0df"/><path d="M38 110l14-35 47 10-9 35z" fill="#d29350" stroke="#f4cc8b" stroke-width="7"/><path d="M115 70h43l-5 37q-2 10-18 10t-18-10z" fill="#f6dec0"/><ellipse cx="136" cy="70" rx="21" ry="6" fill="#81563c"/><path d="M156 78c25-5 22 25-2 20" fill="none" stroke="#f6dec0" stroke-width="6"/><path d="M67 55l14 10-11 22-20-8z" fill="#dda044"/><path d="M130 56q-12-9 0-19" fill="none" stroke="#9bac96" stroke-width="3" stroke-linecap="round"/>`
  };
  return `<span class="food-art art-${kind}" aria-hidden="true"><svg viewBox="0 0 200 160" focusable="false">${arts[kind]}</svg></span>`;
}

function normalizeSearch(value) {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function productCards(dishes) {
  return dishes.map((dish) => `<button class="kiosk-product" data-add-product="${escapeHtml(dish.id)}">${productArt(dish)}<span class="kiosk-product-copy"><small>${escapeHtml(dish.category)}</small><strong>${escapeHtml(dish.name)}</strong><span>${escapeHtml(dish.description || "Preparado a tu gusto")}</span><span class="kiosk-product-bottom"><b>${dish.modifier_groups?.some((group) => group.name === "Tamaño") ? "Desde " : ""}${money(dish.price)}</b><span class="product-plus" aria-hidden="true">+</span></span></span></button>`).join("");
}

function filterKioskProducts() {
  const query = normalizeSearch(productSearch.trim());
  const dishes = state.menu.filter((dish) => dish.available && (activeCategory === "Todas" || dish.category === activeCategory) && normalizeSearch(`${dish.name} ${dish.description || ""} ${dish.category}`).includes(query));
  const grid = appRoot.querySelector("#kioskProducts");
  if (grid) grid.innerHTML = productCards(dishes) || `<div class="empty-state"><h2>No encontramos productos</h2><p>Probá otro nombre o cambiá de categoría.</p></div>`;
  const count = appRoot.querySelector("#catalogCount");
  if (count) count.textContent = `${dishes.length} productos`;
}

function fitOrderPanel() {
  const panel = appRoot.querySelector(".kiosk-cart");
  if (!panel || window.innerWidth <= 760) return;
  const top = Math.max(16, Math.round(panel.getBoundingClientRect().top));
  panel.style.setProperty("--cart-offset-top", `${top}px`);
}

window.addEventListener("scroll", fitOrderPanel, { passive: true });
window.addEventListener("resize", fitOrderPanel);

function renderTableDetail() {
  const table = state.tables.find((entry) => entry.id === activeTableId);
  if (!table) { activeView = "tables"; renderTables(); return; }
  if (table.status === "cleaning") {
    appRoot.innerHTML = `${pageHeading("Mesa cobrada", table.name, "La cuenta está cerrada. Cuando terminen de limpiar, liberá la mesa.", `<button class="button button-primary" data-action="clean-table" data-table-id="${escapeHtml(table.id)}">✓ Mesa limpia</button>`)}<section class="section-panel"><div class="empty-state"><div class="empty-mark">✓</div><h2>Cuenta cobrada</h2><p>Esta mesa queda visible para todo el equipo hasta marcarla limpia.</p></div></section>`;
    return;
  }
  if (table.status !== "open") { activeView = "tables"; renderTables(); return; }
  activeZone = tableZone(table);
  const categories = ["Todas", ...new Set(state.menu.filter((dish) => dish.available).map((dish) => dish.category))];
  if (!categories.includes(activeCategory)) activeCategory = "Todas";
  const dishes = state.menu.filter((dish) => dish.available && (activeCategory === "Todas" || dish.category === activeCategory));
  const categoryButtons = categories.map((category) => `<button class="category-button ${category === activeCategory ? "active" : ""}" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`).join("");
  const products = productCards(dishes);
  const billableItems = table.items.filter((item) => item.status !== "canceled");
  const orderRows = billableItems.length ? billableItems.map((item) => {
    const canceled = item.status === "canceled";
    const controls = canceled
      ? `<button class="button button-secondary button-small" data-action="item-cancel" data-table-id="${escapeHtml(table.id)}" data-item-id="${escapeHtml(item.id)}">Reactivar</button>`
      : `<button class="button button-secondary button-small" data-action="item-edit" data-table-id="${escapeHtml(table.id)}" data-item-id="${escapeHtml(item.id)}">Editar</button><button class="button button-danger button-small" data-action="item-cancel" data-table-id="${escapeHtml(table.id)}" data-item-id="${escapeHtml(item.id)}">Cancelar</button>`;
    return `<div class="order-row ${item.status === "ready" ? "ready-order" : ""} ${canceled ? "canceled-order" : ""}"><div><div class="order-name">${item.quantity} × ${escapeHtml(item.name)}</div>${itemModifierSummary(item) ? `<div class="order-note">${itemModifierSummary(item)}</div>` : ""}${item.note ? `<div class="order-note">${escapeHtml(item.note)}</div>` : ""}<div class="order-meta">${item.status === "draft" ? `Agregado por ${escapeHtml(item.added_by)}` : `Tomado por ${escapeHtml(item.added_by)}`}</div><div class="order-controls">${controls}</div></div><span class="status ${item.status}">${item.status === "ready" ? "Listo para retirar" : statusLabel(item.status)}</span><span class="order-price">${money(canceled ? 0 : item.price * item.quantity)}</span></div>`;
  }).join("") : `<div class="empty-state"><div class="empty-mark">＋</div><h2>La mesa está abierta</h2><p>Agregá productos de la carta para empezar.</p></div>`;
  const hasDraft = billableItems.some((item) => item.status === "draft");
  const sendButton = hasDraft ? `<button class="button button-primary" data-action="send-order" data-table-id="${escapeHtml(table.id)}">Enviar a cocina</button>` : "";
  const canPay = billableItems.length > 0 && !hasDraft && billableItems.every((item) => item.status === "ready");
  const separateButton = billableItems.some((item) => item.status === "ready") ? `<button class="button button-primary" data-action="pay-items" data-table-id="${escapeHtml(table.id)}">Cobrar por separado</button>` : "";
  const payButton = canPay ? `<button class="button button-secondary" data-action="pay-table" data-table-id="${escapeHtml(table.id)}">Cobrar ${money(tableTotal(table))}</button>` : "";
  const disabledPayMessage = !billableItems.length && table.items.length
    ? `<p class="order-meta">Agregá productos para armar el pedido.</p>`
    : billableItems.length && !canPay
      ? `<p class="order-meta">${hasDraft ? "Enviá los productos nuevos a cocina para cobrar." : "Podés cobrar cuando todos los productos estén listos."}</p>`
      : "";
  const units = billableItems.reduce((sum, item) => sum + item.quantity, 0);
  const draftUnits = billableItems.filter((item) => item.status === "draft").reduce((sum, item) => sum + item.quantity, 0);
  appRoot.innerHTML = `<div class="kiosk-screen">
    <header class="kiosk-heading"><div><p class="eyebrow">${escapeHtml(tableZone(table))} · ${escapeHtml(table.opened_by)}${guestsSuffix(table)}</p><h1>${escapeHtml(table.name)}<span class="kiosk-open">En servicio</span></h1><p>¿Qué vamos a servir hoy?</p></div><button class="button button-secondary" data-go="tables">← Mesas</button></header>
    <div class="kiosk-layout"><section class="kiosk-catalog" aria-label="Elegir productos">
      <div class="catalog-heading"><div><h2>Armá el pedido</h2><p>Tocá un producto para elegir sus opciones.</p></div><button class="text-button" data-go="menu">Editar carta ↗</button></div>
      <label class="catalog-search"><span aria-hidden="true">⌕</span><input id="productSearch" type="search" placeholder="Buscar café, desayuno, bebida…" aria-label="Buscar productos" value="${escapeHtml(productSearch)}" autocomplete="off"></label>
      <div class="kiosk-browser"><nav class="kiosk-categories" aria-label="Categorías">${categoryButtons}</nav><div class="kiosk-products-area"><div class="catalog-label"><h3>${escapeHtml(activeCategory === "Todas" ? "Nuestra carta" : activeCategory)}</h3><span id="catalogCount">${dishes.length} productos</span></div><div class="kiosk-products" id="kioskProducts">${products}</div></div></div>
    </section>
    <aside class="table-section section-panel kiosk-cart" id="tableOrder" aria-label="Pedido de la mesa"><div class="section-title"><div><p class="eyebrow">${escapeHtml(table.name)}</p><h2>Tu pedido <span class="cart-count">${units}</span></h2></div><span class="cart-symbol" aria-hidden="true">≡</span></div><div class="cart-progress"><span class="${hasDraft || !units ? "current" : ""}">1. Elegir</span><span class="${units && !hasDraft ? "current" : ""}">2. Cocina</span><span>3. Servir</span></div><div class="order-list">${orderRows}</div><footer class="cart-footer"><div class="cart-total"><span>Total de la mesa<small>${units} unidades${draftUnits ? ` · ${draftUnits} sin enviar` : ""}</small></span><strong>${money(tableTotal(table))}</strong></div><div class="dialog-actions">${disabledPayMessage}${sendButton}${payButton}${separateButton}</div><p class="cart-footnote">${hasDraft ? "Revisá el pedido y envialo a cocina." : units ? "Podés seguir agregando productos a esta mesa." : "Los productos que elijas aparecerán acá."}</p></footer></aside></div>
    <button class="mobile-order-bar" data-action="view-order"><span>Ver pedido · ${units} unidades</span><strong>${money(tableTotal(table))} ↑</strong></button>
  </div>`;
  filterKioskProducts();
  fitOrderPanel();
}

function kitchenTiming(timestamp) {
  const sentAt = Date.parse(timestamp || "");
  const elapsedMs = Number.isFinite(sentAt) ? Math.max(0, Date.now() - sentAt) : 0;
  const minutes = Math.floor(elapsedMs / 60000);

  if (elapsedMs <= 15 * 60000) return { minutes, className: "ticket-on-time", label: "A tiempo · hasta 15 min" };
  if (elapsedMs <= 25 * 60000) return { minutes, className: "ticket-delayed", label: "Con retraso · más de 15 y hasta 25 min" };
  if (elapsedMs <= 35 * 60000) return { minutes, className: "ticket-very-late", label: "Muy retrasado · más de 25 y hasta 35 min" };
  return { minutes, className: "ticket-cancel-risk", label: "Riesgo de cancelación · más de 35 min" };
}

function kitchenSentTime(timestamp) {
  const sentAt = Date.parse(timestamp || "");
  return Number.isFinite(sentAt)
    ? new Intl.DateTimeFormat("es-AR", { hour: "2-digit", minute: "2-digit" }).format(new Date(sentAt))
    : "--:--";
}

function groupKitchenItems(items) {
  const products = new Map();
  for (const item of items) {
    const productKey = String(item.menu_id || item.name).toLocaleLowerCase();
    if (!products.has(productKey)) products.set(productKey, { name: item.name, quantity: 0, variants: new Map() });
    const product = products.get(productKey);
    product.quantity += Number(item.quantity) || 0;
    const production = Object.entries(item.production || {}).map(([name, part]) => [name, part.status]).sort(([left], [right]) => left.localeCompare(right));
    const variantKey = JSON.stringify([item.status, Boolean(item.priority), item.note || "", production]);
    if (!product.variants.has(variantKey)) product.variants.set(variantKey, { item, items: [], quantity: 0, sentAt: item.sent_at });
    const variant = product.variants.get(variantKey);
    variant.items.push(item);
    variant.quantity += Number(item.quantity) || 0;
    if ((Date.parse(item.sent_at || "") || Infinity) < (Date.parse(variant.sentAt || "") || Infinity)) variant.sentAt = item.sent_at;
  }
  return [...products.values()].map((product) => ({
    ...product,
    variants: [...product.variants.values()].sort((left, right) => Number(Boolean(right.item.priority)) - Number(Boolean(left.item.priority)) || (Date.parse(left.sentAt || "") || 0) - (Date.parse(right.sentAt || "") || 0)),
  })).sort((left, right) => Number(Boolean(right.variants.some((variant) => variant.item.priority))) - Number(Boolean(left.variants.some((variant) => variant.item.priority))));
}

function renderKitchenVariant(variant, table) {
  const item = variant.item;
  const itemIds = variant.items.map((entry) => entry.id);
  const itemIdsAttribute = escapeHtml(JSON.stringify(itemIds));
  const timing = kitchenTiming(variant.sentAt);
  const modifiers = new Map();
  for (const source of variant.items) {
    for (const modifier of source.modifiers || []) {
      const key = `${modifier.group || ""}\u0000${modifier.name}`;
      const quantity = (Number(modifier.quantity) || 1) * (source.unit_mode ? 1 : Number(source.quantity) || 1);
      const existing = modifiers.get(key) || { group: modifier.group || "", name: modifier.name, quantity: 0 };
      existing.quantity += quantity;
      modifiers.set(key, existing);
    }
  }
  const modifierLines = [...modifiers.values()].map((modifier) => `${modifier.group ? `${escapeHtml(modifier.group)}: ` : ""}${modifier.quantity > 1 ? `${modifier.quantity} &#215; ` : ""}${escapeHtml(modifier.name)}`);
  const options = item.status === "sent" ? [["sent", "Pendiente"], ["preparing", "En preparaci\u00f3n"], ["ready", "Terminado"], ["suspended", "Demorado"]]
    : item.status === "preparing" ? [["preparing", "En preparaci\u00f3n"], ["ready", "Terminado"], ["suspended", "Demorado"]]
      : [["suspended", "Demorado"], ["preparing", "En preparaci\u00f3n"], ["ready", "Terminado"]];
  const optionMarkup = options.map(([value, label]) => `<option value="${value}" ${item.status === value ? "selected" : ""}>${label}</option>`).join("");
  const nextStatus = item.status === "preparing" ? "ready" : "preparing";
  const statusControls = `<select class="kitchen-state-select" aria-label="Estado de ${escapeHtml(item.name)}" data-action="item-status-select" data-table-id="${escapeHtml(table.id)}" data-item-ids="${itemIdsAttribute}">${optionMarkup}</select><button class="kitchen-advance" type="button" aria-label="${nextStatus === "preparing" ? "Empezar" : "Terminar"} ${escapeHtml(item.name)}" data-action="item-status" data-table-id="${escapeHtml(table.id)}" data-item-ids="${itemIdsAttribute}" data-status="${nextStatus}">${nextStatus === "preparing" ? "Empezar" : "Terminar"}</button>`;
  const priorityToggle = `<label class="priority-toggle"><input type="checkbox" data-action="item-priority" data-table-id="${escapeHtml(table.id)}" data-item-ids="${itemIdsAttribute}" ${item.priority ? "checked" : ""}><span>Prioridad</span></label>`;
  const editButton = `<button class="kitchen-advance" type="button" title="Editar una l\u00ednea de este grupo" aria-label="Editar una l\u00ednea de ${escapeHtml(item.name)}" data-action="item-edit" data-table-id="${escapeHtml(table.id)}" data-item-id="${escapeHtml(item.id)}">Editar</button>`;
  const cancelButton = `<button class="kitchen-advance kitchen-cancel" type="button" title="Cancelar este grupo" aria-label="Cancelar ${variant.quantity} de ${escapeHtml(item.name)}" data-action="item-cancel-group" data-table-id="${escapeHtml(table.id)}" data-item-ids="${itemIdsAttribute}" data-name="${escapeHtml(item.name)}" data-quantity="${variant.quantity}">Cancelar grupo</button>`;
  return `<div class="kitchen-variant ${item.priority ? "ticket-priority" : ""}"><div class="kitchen-variant-copy"><div class="ticket-product-meta"><span class="status ${item.status}">${statusLabel(item.status)}</span><span class="${timing.className}">${kitchenSentTime(variant.sentAt)} &#183; ${timing.minutes} min</span>${item.priority ? "<b>Prioridad</b>" : ""}</div>${modifierLines.length ? `<p class="ticket-modifiers">${modifierLines.join("<br>")}</p>` : ""}${item.note ? `<p class="ticket-note"><b>Nota:</b> ${escapeHtml(item.note)}</p>` : ""}</div><div class="kitchen-variant-controls">${statusControls}<div class="ticket-item-tools">${priorityToggle}${editButton}${cancelButton}</div></div></div>`;
}

function renderKitchen() {
  const tickets = state.tables.filter((table) => table.status === "open" && table.items.some((item) => ["sent", "preparing", "suspended"].includes(item.status)));
  tickets.sort((left, right) => {
    const leftPriority = left.items.some((item) => item.priority && ["sent", "preparing", "suspended"].includes(item.status));
    const rightPriority = right.items.some((item) => item.priority && ["sent", "preparing", "suspended"].includes(item.status));
    if (leftPriority !== rightPriority) return leftPriority ? -1 : 1;
    const leftSentAt = Math.min(...left.items.filter((item) => ["sent", "preparing", "suspended"].includes(item.status)).map((item) => Date.parse(item.sent_at || "") || 0));
    const rightSentAt = Math.min(...right.items.filter((item) => ["sent", "preparing", "suspended"].includes(item.status)).map((item) => Date.parse(item.sent_at || "") || 0));
    return leftSentAt - rightSentAt;
  });
  const activeItems = tickets.flatMap((table) => table.items.filter((item) => ["sent", "preparing", "suspended"].includes(item.status)).map((item) => ({ table, item, timing: kitchenTiming(item.sent_at) })));
  const countFor = (className) => activeItems.filter(({ timing }) => timing.className === className).reduce((sum, { item }) => sum + item.quantity, 0);
  const filters = [["all", "Todos", activeItems.reduce((sum, { item }) => sum + item.quantity, 0)], ["ticket-on-time", "A tiempo", countFor("ticket-on-time")], ["ticket-delayed", "Demorado", countFor("ticket-delayed")], ["ticket-very-late", "Muy demorado", countFor("ticket-very-late")], ["ticket-cancel-risk", "Crítico", countFor("ticket-cancel-risk")]]
    .map(([key, label, amount]) => `<button class="kitchen-filter ${key === kitchenTimingFilter ? "active" : ""} ${key === "all" ? "" : key}" data-kitchen-filter="${key}" type="button">${label} <span>${amount}</span></button>`).join("");
  const cards = tickets.map((table) => {
    const items = table.items.filter((item) => ["sent", "preparing", "suspended"].includes(item.status)).sort((left, right) => Number(Boolean(right.priority)) - Number(Boolean(left.priority)) || (Date.parse(left.sent_at || "") || 0) - (Date.parse(right.sent_at || "") || 0));
    const oldestItem = items.reduce((oldest, item) => (Date.parse(item.sent_at || "") || 0) < (Date.parse(oldest.sent_at || "") || 0) ? item : oldest);
    const timing = kitchenTiming(oldestItem.sent_at);
    if (kitchenTimingFilter !== "all" && !items.some((item) => kitchenTiming(item.sent_at).className === kitchenTimingFilter)) return "";
    const groupedProducts = groupKitchenItems(items);
    const renderedItems = groupedProducts.map((product) => `<article class="ticket-item kitchen-product-group"><div class="ticket-product"><span class="ticket-item-quantity">${product.quantity} &#215;</span><div><strong>${escapeHtml(product.name)}</strong><small class="kitchen-variant-count">${product.variants.length} variantes</small></div></div><div class="kitchen-product-variants">${product.variants.map((variant) => renderKitchenVariant(variant, table)).join("")}</div></article>`).join("");
    return `<section class="kitchen-ticket"><header class="ticket-head ${timing.className}"><div class="ticket-heading-main"><div class="ticket-heading-top"><span class="ticket-sent-time">${kitchenSentTime(oldestItem.sent_at)}</span><span class="kitchen-timer" role="timer" aria-label="Pedido hace ${timing.minutes} minutos: ${timing.label}"><strong>${timing.minutes} min</strong></span></div><h2>${escapeHtml(table.name)}</h2><p>${escapeHtml(tableZone(table))} · Atiende ${escapeHtml(table.opened_by)}${guestsSuffix(table)}</p></div><span class="status open">${groupedProducts.length} productos &#183; ${items.reduce((sum, item) => sum + item.quantity, 0)} unidades</span></header><div class="ticket-items">${renderedItems}</div><footer class="ticket-footer"><span class="ticket-footer-meta">${items.reduce((sum, item) => sum + item.quantity, 0)} unidades pendientes</span><button class="button button-finish-all" data-action="finish-ticket" data-table-id="${escapeHtml(table.id)}">Terminar todo</button></footer></section>`;
  }).join("");
  const readyCount = state.tables.reduce((sum, table) => sum + table.items.filter((item) => item.status === "ready").length, 0);
  appRoot.innerHTML = `<div class="kitchen-board-heading"><div><p class="eyebrow">Producción</p><h1>Cocina</h1><p class="kitchen-overview">${tickets.length} mesas · ${activeItems.reduce((sum, entry) => sum + entry.item.quantity, 0)} unidades pendientes · prioridades y pedidos más antiguos primero</p></div><span class="status ready">${readyCount} listos</span></div><div class="kitchen-toolbar" aria-label="Filtrar comandas">${filters}</div><div class="kitchen-grid">${cards || `<section class="section-panel kitchen-empty"><div class="empty-state"><div class="empty-mark">♨</div><h2>${activeItems.length ? "No hay pedidos en este filtro" : "Cocina al día"}</h2><p>${activeItems.length ? "Elegí otro tiempo para ver las comandas." : "Los pedidos enviados por los mozos van a aparecer acá."}</p></div></section>`}</div>`;
}

function renderMenu() {
  const addButton = `<div class="page-heading-buttons"><button class="button button-secondary" data-action="edit-catalog">Editar categorías</button><button class="button button-primary" data-action="add-product">＋ <span>Plato</span></button></div>`;
  const categories = [...new Set(state.menu.map((dish) => dish.category))];
  const rows = categories.map((category) => {
    const products = state.menu.filter((dish) => dish.category === category).map((dish) => `<article class="menu-row ${dish.available ? "" : "unavailable"}"><div><h3>${escapeHtml(dish.name)}</h3><p>${escapeHtml(dish.description || "Sin descripción")} · ${dish.available ? "Disponible" : "Pausado"}</p></div><strong>${money(dish.price)}</strong><div class="menu-actions"><button class="icon-button" data-action="edit-product" data-menu-id="${escapeHtml(dish.id)}" aria-label="Editar ${escapeHtml(dish.name)}" title="Editar">✎</button><button class="icon-button" data-action="delete-product" data-menu-id="${escapeHtml(dish.id)}" aria-label="Eliminar ${escapeHtml(dish.name)}" title="Eliminar">×</button></div></article>`).join("");
    return `<section class="table-section"><h2 class="menu-category">${escapeHtml(category)}</h2><div class="menu-list">${products}</div></section>`;
  }).join("");
  appRoot.innerHTML = `${volatileBanner()}${pageHeading("Productos y precios", "Carta del bar", `${state.menu.length} productos · los cambios se ven en todos los teléfonos.`, addButton)}${rows || `<section class="section-panel"><div class="empty-state"><h2>La carta está vacía</h2><p>Agregá el primer producto para empezar.</p></div></section>`}`;
}

function showDialog({ eyebrow = "", title, body, submitLabel = "Guardar", cancelLabel = "Cancelar", onSubmit }) {
  activeProductPreview = null;
  dialog.classList.remove("product-dialog", "payment-dialog");
  document.querySelector("#dialogEyebrow").textContent = eyebrow;
  document.querySelector("#dialogTitle").textContent = title;
  dialogBody.oninput = null;
  dialogBody.innerHTML = body;
  dialogActions.innerHTML = `<button class="button button-secondary" type="button" data-close-dialog>${escapeHtml(cancelLabel)}</button><button class="button button-primary" type="submit">${escapeHtml(submitLabel)}</button>`;
  dialogForm.onsubmit = async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(dialogForm).entries());
    const completed = await onSubmit(data);
    if (completed) dialog.close();
  };
  dialog.showModal();
  dialog.querySelector("input, textarea, select")?.focus();
}

function showSeparatePaymentDialog(table) {
  const items = table.items.filter((item) => item.status === "ready");
  showDialog({ eyebrow: table.name, title: "Cobrar por separado", submitLabel: "Elegí productos", body: `<p>Elegí lo que paga esta persona. El resto queda pendiente en la mesa.</p><div class="split-payment-list">${items.map((item, index) => `<div class="split-payment-row"><div><strong>${escapeHtml(item.name)}</strong><p>${itemModifierSummary(item)}</p><small>${money(item.price)} por unidad · ${item.quantity} pendientes</small></div><div class="split-payment-quantity"><span>Cantidad</span><div class="quantity-stepper"><button type="button" class="quantity-step" data-quantity-step="-1" aria-label="Disminuir cantidad a cobrar de ${escapeHtml(item.name)}">−</button><input data-payment-index="${index}" type="number" min="0" max="${item.quantity}" step="1" value="0" inputmode="numeric" aria-label="Cantidad a cobrar de ${escapeHtml(item.name)}"><button type="button" class="quantity-step" data-quantity-step="1" aria-label="Aumentar cantidad a cobrar de ${escapeHtml(item.name)}">+</button></div></div></div>`).join("")}</div><div class="cart-total"><span>A cobrar ahora</span><strong id="splitPaymentTotal">${money(0)}</strong></div>`, onSubmit: async () => {
    const selected = [...dialogBody.querySelectorAll("[data-payment-index]")].map((input) => ({ item_id: items[Number(input.dataset.paymentIndex)].id, expected_quantity: items[Number(input.dataset.paymentIndex)].quantity, quantity: Number(input.value) })).filter((item) => item.quantity > 0);
    if (!selected.length) return false;
    return sendAction({ type: "items_paid", table_id: table.id, items: selected }, "Cobro registrado. El saldo pendiente se actualizó.");
  }});
  const update = () => {
    const total = [...dialogBody.querySelectorAll("[data-payment-index]")].reduce((sum, input) => sum + items[Number(input.dataset.paymentIndex)].price * (Number(input.value) || 0), 0);
    dialogBody.querySelector("#splitPaymentTotal").textContent = money(total);
    const button = dialogActions.querySelector('[type="submit"]');
    const chosen = [...dialogBody.querySelectorAll("[data-payment-index]")].some((input) => Number(input.value) > 0);
    button.disabled = !chosen;
    button.textContent = chosen ? `Cobrar ${money(total)}` : "Elegí productos";
  };
  dialog.classList.add("payment-dialog");
  dialogBody.oninput = update;
  update();
}

function showAddTableDialog() {
  showDialog({ eyebrow: "Salón", title: "Agregar mesa", body: `<label class="dialog-field">Sector<select name="zone">${TABLE_ZONES.map((zone) => `<option value="${escapeHtml(zone)}" ${zone === activeZone ? "selected" : ""}>${escapeHtml(zone)}</option>`).join("")}</select></label><label class="dialog-field">Nombre o número<input name="name" maxlength="40" placeholder="Por ejemplo: Mesa 17" required></label>`, submitLabel: "Agregar mesa", onSubmit: (data) => sendAction({ type: "table_create", name: data.name, zone: data.zone }, "Mesa agregada.") });
}

function showOpenTableDialog(table) {
  const body = `<label class="dialog-field">¿Cuántas personas se sientan?<div class="quantity-stepper"><button class="quantity-step" type="button" data-quantity-step="-1" aria-label="Menos personas">−</button><input name="guests" type="number" min="1" max="30" value="2" inputmode="none" readonly required aria-live="polite"><button class="quantity-step" type="button" data-quantity-step="1" aria-label="Más personas">+</button></div></label><label class="dialog-field">Nombre del mozo o moza (opcional)<input name="waiter" maxlength="40" value="${escapeHtml(waiterInput.value)}" placeholder="Podés dejarlo vacío"></label>`;
  showDialog({ eyebrow: table.name, title: "Abrir mesa", body, submitLabel: "Abrir mesa", onSubmit: async (data) => {
    const waiter = data.waiter.trim().slice(0, 40);
    const guests = Math.max(1, Math.min(30, Number(data.guests) || 1));
    waiterInput.value = waiter;
    const opened = await sendAction({ type: "table_open", table_id: table.id, waiter, guests }, `${table.name} abierta · ${guests} ${guests === 1 ? "persona" : "personas"}${waiter ? ` · atiende ${waiter}` : ""}.`);
    if (opened) {
      activeTableId = table.id;
      activeView = "table-detail";
      render();
    }
    return opened;
  } });
}

function readModifierGroups() {
  const entries = [...dialogBody.querySelectorAll("[data-modifier-group]")].map((group) => ({
    name: group.querySelector("[data-group-name]").value.trim(),
    selection: group.querySelector("[data-group-selection]").value,
    required: group.querySelector("[data-group-required]").checked,
    includedQuantity: Number(group.querySelector("[data-group-included]")?.value || 0),
    showGroupIndex: group.querySelector("[data-group-show-group]")?.value ?? "",
    showOptionIndexes: [...group.querySelectorAll("[data-group-show-option]:checked")].map((checkbox) => Number(checkbox.value)),
    options: [...group.querySelectorAll("[data-modifier-option]")].map((option) => ({
      name: option.querySelector("[data-option-name]").value.trim(),
      price: option.querySelector("[data-option-price]").value,
    })),
  }));
  return entries.map((entry) => {
    const group = { name: entry.name, selection: entry.selection, required: entry.required, options: entry.options };
    if (entry.selection === "quantity" && entry.includedQuantity > 0) group.included_quantity = entry.includedQuantity;
    const dependency = entry.showGroupIndex === "" ? null : entries[Number(entry.showGroupIndex)];
    if (dependency && dependency.name && dependency.name !== entry.name) {
      const conditionOptions = entry.showOptionIndexes.map((index) => dependency.options[index]?.name).filter((name) => name);
      group.show_when = { group: dependency.name };
      if (conditionOptions.length) group.show_when.options = conditionOptions;
    }
    return group;
  });
}

function modifierGroupEditor(groups) {
  const groupRows = groups.map((group, groupIndex) => {
    const condition = group.show_when || null;
    const conditionIndex = condition ? groups.findIndex((entry) => entry.name === condition.group) : -1;
    const dependencyOptions = groups.map((entry, entryIndex) => entryIndex === groupIndex ? "" : `<option value="${entryIndex}" ${entryIndex === conditionIndex ? "selected" : ""}>${escapeHtml(entry.name || `Grupo ${entryIndex + 1}`)}</option>`).filter(Boolean).join("");
    let conditionFields = `<label class="dialog-field">Mostrar cuando<select data-group-show-group><option value="">Siempre visible</option>${dependencyOptions}</select></label>`;
    if (conditionIndex >= 0) {
      const dependency = groups[conditionIndex];
      const checkedOptions = new Set(condition.options || []);
      const optionChecks = dependency.options.map((option, optionIndex) => `<label class="modifier-condition-option"><input type="checkbox" data-group-show-option value="${optionIndex}" ${checkedOptions.has(option.name) ? "checked" : ""}><span>${escapeHtml(option.name || `Opción ${optionIndex + 1}`)}</span></label>`).join("");
      conditionFields += `<div class="modifier-condition-options"><p class="modifier-help">Se abre solo al marcar una de estas opciones de ${escapeHtml(dependency.name)}. Sin marcar ninguna, se abre con cualquier opción.</p>${optionChecks || `<p class="modifier-help">Este grupo todavía no tiene opciones.</p>`}</div>`;
    }
    return `<section class="modifier-group-editor" data-modifier-group>
    <div class="modifier-group-heading"><strong>Grupo de opciones</strong><button class="text-button" type="button" data-group-action="remove-group">Quitar grupo</button></div>
    <label class="dialog-field">Nombre del grupo<input data-group-name maxlength="60" value="${escapeHtml(group.name)}" placeholder="Ej.: Infusión" required></label>
    <label class="dialog-field">Cómo se elige<select data-group-selection><option value="single" ${group.selection === "single" ? "selected" : ""}>Una opción</option><option value="quantity" ${group.selection === "quantity" ? "selected" : ""}>Cantidades por opción</option></select></label>
    ${conditionFields}
    <label class="dialog-field">Unidades incluidas por producto (grupos de cantidades)<input data-group-included type="number" min="0" max="99" step="1" value="${group.included_quantity || 0}"></label>
    <label class="modifier-required"><input type="checkbox" data-group-required ${group.required ? "checked" : ""}><span>Obligatorio</span></label>
    <div class="modifier-options">${group.options.map((option) => `<div class="modifier-option" data-modifier-option><label class="dialog-field">Opción<input data-option-name maxlength="60" value="${escapeHtml(option.name)}" placeholder="Ej.: Mate cocido" required></label><label class="dialog-field modifier-price">Adicional<input data-option-price type="number" min="0" step="1" value="${escapeHtml(option.price ?? 0)}" required></label><button class="icon-button" type="button" data-group-action="remove-option" aria-label="Quitar opción">×</button></div>`).join("")}</div>
    <button class="text-button" type="button" data-group-action="add-option">＋ Agregar opción</button>
  </section>`;
  }).join("");
  return `<div class="modifier-editor"><h3>Opciones para el pedido</h3><p class="modifier-help">Se muestran al elegir este producto. Usá un adicional de $0 para opciones incluidas; solo los agregados con recargo aumentan el precio. Si todos los grupos son de cantidades y sus opciones cuestan $0 o lo mismo que el producto (por ejemplo, las variedades de una tortilla), no se pide la cantidad aparte: cada unidad que se elija se cobra al precio del producto. Con «Mostrar cuando» el grupo se abre recién al marcar la opción que lo activa, por ejemplo los acompañamientos al elegir la infusión.</p>${groupRows || `<p class="modifier-empty">Sin opciones configuradas.</p>`}<button class="button button-secondary" type="button" data-group-action="add-group">＋ Agregar grupo</button></div>`;
}

function showCatalogDialog() {
  let groups = structuredClone(state.modifier_catalog || []);
  const renderEditor = () => modifierGroupEditor(groups);
  showDialog({ eyebrow: "Carta compartida", title: "Categorías y opciones", body: renderEditor(), submitLabel: "Guardar para todos", onSubmit: () => sendAction({ type: "modifier_catalog_update", modifier_catalog: readModifierGroups() }, "Categorías actualizadas en todos los productos.") });
  dialogBody.onclick = (event) => {
    const button = event.target.closest("[data-group-action]");
    if (!button) return;
    groups = readModifierGroups();
    const section = button.closest("[data-modifier-group]");
    const gi = [...dialogBody.querySelectorAll("[data-modifier-group]")].indexOf(section);
    const oi = section ? [...section.querySelectorAll("[data-modifier-option]")].indexOf(button.closest("[data-modifier-option]")) : -1;
    if (button.dataset.groupAction === "add-group") groups.push({ name: "", selection: "single", required: false, options: [{ name: "", price: 0 }] });
    if (button.dataset.groupAction === "remove-group") groups.splice(gi, 1);
    if (button.dataset.groupAction === "add-option") groups[gi].options.push({ name: "", price: 0 });
    if (button.dataset.groupAction === "remove-option") groups[gi].options.splice(oi, 1);
    dialogBody.querySelector(".modifier-editor").outerHTML = renderEditor();
  };
}

function showProductDialog(dish = null) {
  const editing = Boolean(dish);
  const categories = [...new Set(state.menu.map((entry) => entry.category))];
  const categoryOptions = [...new Set([...categories, "Infusiones", "Para acompañar", "Bebidas"])].map((category) => `<option value="${escapeHtml(category)}" ${dish?.category === category ? "selected" : ""}>${escapeHtml(category)}</option>`).join("");
  const groups = dish?.modifier_groups || [];
  const sharedOptions = (state.modifier_catalog || []).map((group) => `<option value="${escapeHtml(group.name)}">${escapeHtml(group.name)}</option>`).join("");
  const body = `<label class="dialog-field">Nombre del producto<input name="name" maxlength="80" value="${escapeHtml(dish?.name || "")}" required></label><label class="dialog-field">Categoría<select name="category" required>${categoryOptions}<option value="__custom">Otra categoría…</option></select></label><label class="dialog-field custom-category" hidden>Nueva categoría<input name="custom_category" maxlength="40"></label><label class="dialog-field">Descripción<textarea name="description" maxlength="120" placeholder="Detalle opcional">${escapeHtml(dish?.description || "")}</textarea></label><label class="dialog-field">Precio en pesos<input name="price" type="number" min="0" step="1" value="${escapeHtml(dish?.price ?? "")}" required></label>${editing ? `<label class="dialog-field">Disponibilidad<select name="available"><option value="true" ${dish.available ? "selected" : ""}>Disponible</option><option value="false" ${!dish.available ? "selected" : ""}>Pausado</option></select></label>` : ""}${modifierGroupEditor(groups)}<div class="shared-category-picker"><label class="dialog-field">Usar categoría de la carta común<select data-shared-category>${sharedOptions}</select></label><button class="button button-secondary" type="button" data-action="add-shared-category">Agregar al producto</button></div>`;
  showDialog({ eyebrow: editing ? "Editar carta" : "Carta del bar", title: editing ? "Editar producto" : "Nuevo producto", body, submitLabel: editing ? "Guardar cambios" : "Agregar producto", onSubmit: (data) => {
    const category = data.category === "__custom" ? data.custom_category : data.category;
    const action = { type: editing ? "menu_update" : "menu_add", menu_id: dish?.id, name: data.name, category, description: data.description, price: data.price, available: data.available !== "false", modifier_groups: readModifierGroups() };
    return sendAction(action, editing ? "Producto actualizado." : "Producto agregado.");
  } });
  dialogBody.onclick = (event) => {
    if (event.target.closest('[data-action="add-shared-category"]')) {
      const selectedName = dialogBody.querySelector("[data-shared-category]").value;
      const shared = (state.modifier_catalog || []).find((entry) => entry.name === selectedName);
      const current = readModifierGroups();
      if (shared && !current.some((entry) => entry.name.toLowerCase() === shared.name.toLowerCase())) {
        current.push(structuredClone(shared));
        dialogBody.querySelector(".modifier-editor").outerHTML = modifierGroupEditor(current);
      }
      return;
    }
    const button = event.target.closest("[data-group-action]");
    if (!button) return;
    const updatedGroups = readModifierGroups();
    const group = button.closest("[data-modifier-group]");
    const groupIndex = [...dialogBody.querySelectorAll("[data-modifier-group]")].indexOf(group);
    const optionIndex = group ? [...group.querySelectorAll("[data-modifier-option]")].indexOf(button.closest("[data-modifier-option]")) : -1;
    if (button.dataset.groupAction === "add-group") updatedGroups.push({ name: "", selection: "quantity", required: false, options: [{ name: "", price: 0 }] });
    if (button.dataset.groupAction === "remove-group") updatedGroups.splice(groupIndex, 1);
    if (button.dataset.groupAction === "add-option") updatedGroups[groupIndex].options.push({ name: "", price: 0 });
    if (button.dataset.groupAction === "remove-option") updatedGroups[groupIndex].options.splice(optionIndex, 1);
    dialogBody.querySelector(".modifier-editor").outerHTML = modifierGroupEditor(updatedGroups);
  };
  dialogBody.onchange = (event) => {
    if (event.target.matches("[data-group-show-group]")) {
      const section = event.target.closest("[data-modifier-group]");
      section?.querySelectorAll("[data-group-show-option]").forEach((checkbox) => { checkbox.checked = false; });
      const updatedGroups = readModifierGroups();
      dialogBody.querySelector(".modifier-editor").outerHTML = modifierGroupEditor(updatedGroups);
      return;
    }
    if (event.target.matches("[data-group-name]")) {
      const groupIndex = [...dialogBody.querySelectorAll("[data-modifier-group]")].indexOf(event.target.closest("[data-modifier-group]"));
      const name = event.target.value.trim() || `Grupo ${groupIndex + 1}`;
      dialogBody.querySelectorAll(`[data-group-show-group] option[value="${groupIndex}"]`).forEach((option) => { option.textContent = name; });
      return;
    }
    if (event.target.matches("[data-option-name]")) {
      const section = event.target.closest("[data-modifier-group]");
      if (!section) return;
      const groupIndex = [...dialogBody.querySelectorAll("[data-modifier-group]")].indexOf(section);
      const optionIndex = [...section.querySelectorAll("[data-modifier-option]")].indexOf(event.target.closest("[data-modifier-option]"));
      const name = event.target.value.trim() || `Opción ${optionIndex + 1}`;
      dialogBody.querySelectorAll("[data-modifier-group]").forEach((otherSection, otherIndex) => {
        if (otherIndex === groupIndex) return;
        const dependencySelect = otherSection.querySelector("[data-group-show-group]");
        if (dependencySelect?.value !== String(groupIndex)) return;
        const checkbox = otherSection.querySelector(`[data-group-show-option][value="${optionIndex}"]`);
        if (checkbox?.nextElementSibling) checkbox.nextElementSibling.textContent = name;
      });
    }
  };
  dialogBody.querySelector('select[name="category"]')?.addEventListener("change", (event) => {
    dialogBody.querySelector(".custom-category").hidden = event.target.value !== "__custom";
    dialogBody.querySelector('input[name="custom_category"]').required = event.target.value === "__custom";
  });
}

function isUnitProduct(dish) {
  const groups = dish.modifier_groups || [];
  return dish.price > 0 && groups.length > 0 && groups.every((group) => group.selection === "quantity" && !group.included_quantity && group.options.every((option) => [0, Number(dish.price)].includes(Number(option.price))));
}

function modifierChoiceOrder(group, modifiers) {
  const selected = modifiers.filter((modifier) => modifier.group === group.name);
  if (!selected.some((modifier) => "included_quantity" in modifier)) return selected.flatMap((modifier) => Array(modifier.quantity).fill(modifier.name));
  return [
    ...selected.flatMap((modifier) => Array(modifier.included_quantity || 0).fill(modifier.name)),
    ...selected.flatMap((modifier) => Array(modifier.quantity - (modifier.included_quantity || 0)).fill(modifier.name)),
  ];
}

function includedChoices(wrapper, group) {
  const inputs = [...wrapper.querySelectorAll("[data-quantity-choice]")];
  const desired = new Map(inputs.map((input) => [input.dataset.quantityChoice, Number(input.value) || 0]));
  let previous = [];
  try { previous = JSON.parse(wrapper.dataset.choiceOrder || "[]"); } catch (error) {}
  const counts = new Map();
  const order = previous.filter((name) => {
    const used = counts.get(name) || 0;
    if (used >= (desired.get(name) || 0)) return false;
    counts.set(name, used + 1);
    return true;
  });
  desired.forEach((quantity, name) => {
    for (let index = counts.get(name) || 0; index < quantity; index += 1) order.push(name);
  });
  wrapper.dataset.choiceOrder = JSON.stringify(order);
  const included = new Map();
  order.slice(0, Number(group.included_quantity) || 0).forEach((name) => included.set(name, (included.get(name) || 0) + 1));
  return included;
}

function showAddItemDialog(table, dish, item = null) {
  const groups = dish.modifier_groups || [];
  const unitProduct = isUnitProduct(dish);
  const selectedModifiers = item?.modifiers || [];
  const modifierFields = groups.map((group, groupIndex) => {
    const condition = group.show_when || null;
    const wrapperAttributes = `data-modifier-wrapper data-choice-order="${escapeHtml(JSON.stringify(modifierChoiceOrder(group, selectedModifiers)))}" data-modifier-group-name="${escapeHtml(group.name)}"${condition ? ` data-conditional-group data-when-group="${escapeHtml(condition.group)}" data-when-options="${escapeHtml(JSON.stringify(condition.options || []))}"` : ""}`;
    const conditionHint = condition ? `<small class="modifier-condition-hint">Se abre al elegir ${escapeHtml(condition.group)}</small>` : "";
    const options = group.options.map((option, optionIndex) => {
      const surcharge = group.name === "Tamaño" && group.selection === "single" ? money(Number(dish.price) + Number(option.price)) : group.name === "Acompañamientos" && !group.included_quantity ? `${money(option.price)} c/u` : unitProduct ? `${money(dish.price)} c/u` : option.price ? `${group.included_quantity ? "Extra " : ""}+${money(option.price)}` : "Incluido";
      return group.selection === "single"
        ? `<option value="${escapeHtml(option.name)}" ${selectedModifiers.some((modifier) => modifier.group === group.name && modifier.name === option.name) ? "selected" : ""}>${escapeHtml(option.name)} · ${escapeHtml(surcharge)}</option>`
        : `<div class="modifier-quantity-row modifier-card">${productArt({ name: option.name, category: group.name })}<div class="modifier-card-copy"><strong>${escapeHtml(option.name)}</strong><small>${surcharge}</small></div><div class="quantity-stepper modifier-stepper"><button class="quantity-step" type="button" data-quantity-step="-1" aria-label="Disminuir ${escapeHtml(option.name)}">−</button><input name="modifier-${groupIndex}-${optionIndex}" data-quantity-choice="${escapeHtml(option.name)}" type="number" min="0" max="99" value="${selectedModifiers.find((modifier) => modifier.group === group.name && modifier.name === option.name)?.quantity || 0}" inputmode="none" readonly aria-label="Cantidad de ${escapeHtml(option.name)}"><button class="quantity-step" type="button" data-quantity-step="1" aria-label="Aumentar ${escapeHtml(option.name)}">+</button></div></div>`;
    }).join("");
    const singleChoice = group.selection === "single" ? `<label class="dialog-field modifier-dropdown-label">Elegir ${escapeHtml(group.name)}<select class="modifier-dropdown" name="modifier-group-${groupIndex}" data-single-choice ${group.required ? 'data-required="true" required' : ""}><option value="">${group.required ? "Seleccioná una opción" : "Sin selección"}</option>${options}</select></label>` : options;
    return `<fieldset class="modifier-selection" ${wrapperAttributes}><legend>${escapeHtml(group.name)}<small>${group.required ? "Obligatorio" : "Opcional"}</small></legend>${conditionHint}${group.name === "Acompañamientos" && !group.included_quantity ? `<p class="included-summary">Se cobra cada acompañamiento desde la primera unidad. Cantidades por café.</p>` : ""}${group.included_quantity ? `<p class="included-summary">${group.included_quantity} acompañamientos incluidos por combo. Los primeros dos que elegís están incluidos; los siguientes se cobran al precio de cada opción.<strong data-included-summary></strong></p>` : ""}${group.selection === "single" ? singleChoice : `<div class="quantity-options">${options}</div>`}</fieldset>`;
  }).join("");
  const quantityField = unitProduct ? "" : `<label class="dialog-field">Cantidad<div class="quantity-stepper"><button class="quantity-step" type="button" data-quantity-step="-1" aria-label="Menos">−</button><input name="quantity" type="number" min="1" max="99" value="${item?.quantity ?? 1}" inputmode="none" readonly required><button class="quantity-step" type="button" data-quantity-step="1" aria-label="Más">＋</button></div></label>`;
  const body = `<div class="customize-hero">${productArt(dish)}<div><p class="eyebrow">${escapeHtml(dish.category)}</p><h3>${escapeHtml(dish.name)}</h3><p>${escapeHtml(dish.description || "Preparado a tu gusto")}</p><strong data-product-price>${dish.modifier_groups?.some((group) => group.name === "Tamaño") ? "Desde " : ""}${money(dish.price)}</strong></div></div>${quantityField}<p class="dialog-hint">${unitProduct ? "Elegí cuántas unidades de cada opción · cada una se cobra al precio del producto." : item ? "Los cambios se actualizarán también en cocina." : "Usá − y ＋ para elegir cuántas unidades querés agregar."}${unitProduct && item ? " Los cambios se actualizarán también en cocina." : ""}</p>${modifierFields}<label class="priority-field"><input name="priority" type="checkbox" ${item?.priority ? "checked" : ""}><span>Prioridad</span><small>Producto rápido de preparar</small></label><label class="dialog-field">Nota para cocina<textarea name="note" maxlength="160" placeholder="Ej.: sin azúcar, bien tostado">${escapeHtml(item?.note || "")}</textarea></label>`;
  showDialog({ eyebrow: table.name, title: item ? "Editar pedido" : "Agregar al pedido", body, submitLabel: item ? "Guardar cambios" : "Agregar", onSubmit: (data) => {
    const wrappers = [...dialogBody.querySelectorAll("[data-modifier-wrapper]")];
    const modifiers = [];
    let missingRequiredGroup = "";
    groups.forEach((group, groupIndex) => {
      if (wrappers[groupIndex]?.hidden) return;
      if (group.selection === "single") {
        const option = data[`modifier-group-${groupIndex}`];
        if (option) modifiers.push({ group: group.name, option, quantity: 1 });
        return;
      }
      let selectedCount = 0;
      const included = includedChoices(wrappers[groupIndex], group);
      group.options.forEach((option, optionIndex) => {
        const quantity = Number(data[`modifier-${groupIndex}-${optionIndex}`]) || 0;
        if (quantity > 0) {
          selectedCount += quantity;
          modifiers.push({ group: group.name, option: option.name, quantity, ...(group.included_quantity ? { included_quantity: included.get(option.name) || 0 } : {}) });
        }
      });
      if (group.required && selectedCount === 0) {
        showToast(`Elegí al menos una opción para ${group.name}.`, true);
        missingRequiredGroup = group.name;
      }
    });
    if (missingRequiredGroup) return false;
    if (unitProduct && !modifiers.length) {
      showToast(`Elegí cuántas unidades querés de ${dish.name}.`, true);
      return false;
    }
    const action = item
      ? { type: "item_edit", table_id: table.id, item_id: item.id, menu_id: dish.id, quantity: Number(data.quantity) || 1, modifiers, note: data.note, priority: data.priority === "on", waiter: waiterInput.value.trim() || table.opened_by }
      : { type: "item_add", table_id: table.id, menu_id: dish.id, quantity: Number(data.quantity) || 1, modifiers, note: data.note, priority: data.priority === "on", waiter: waiterInput.value.trim() || table.opened_by };
    return sendAction(action, item ? `${dish.name} actualizado en cocina.` : `${dish.name} agregado.`);
  } });
  activeProductPreview = { dish, editing: Boolean(item) };
  dialog.classList.add("product-dialog");
  syncConditionalModifierGroups();
  updateProductPreview();
}

function syncConditionalModifierGroups() {
  const wrappers = [...dialogBody.querySelectorAll("[data-modifier-wrapper]")];
  if (!wrappers.length) return;
  const selectedByGroup = new Map();
  wrappers.forEach((wrapper) => {
    const chosen = [];
    const singleChoice = wrapper.querySelector("[data-single-choice]");
    if (singleChoice && singleChoice.value) chosen.push(singleChoice.value);
    wrapper.querySelectorAll("[data-quantity-choice]").forEach((input) => {
      const quantity = Number(input.value) || 0;
      for (let index = 0; index < quantity; index += 1) chosen.push(input.dataset.quantityChoice);
    });
    selectedByGroup.set(wrapper.dataset.modifierGroupName, chosen);
  });
  const visibility = new Map();
  wrappers.forEach((wrapper) => visibility.set(wrapper.dataset.modifierGroupName, !wrapper.hasAttribute("data-conditional-group")));
  let changed = true;
  while (changed) {
    changed = false;
    wrappers.forEach((wrapper) => {
      const name = wrapper.dataset.modifierGroupName;
      if (visibility.get(name)) return;
      const dependency = wrapper.dataset.whenGroup;
      if (!visibility.get(dependency)) return;
      const chosen = selectedByGroup.get(dependency) || [];
      if (!chosen.length) return;
      let conditionOptions = [];
      try { conditionOptions = JSON.parse(wrapper.dataset.whenOptions || "[]"); } catch (error) { conditionOptions = []; }
      if (!conditionOptions.length || conditionOptions.some((option) => chosen.includes(option))) {
        visibility.set(name, true);
        changed = true;
      }
    });
  }
  wrappers.forEach((wrapper) => {
    const visible = visibility.get(wrapper.dataset.modifierGroupName);
    if (visible) {
      wrapper.hidden = false;
      wrapper.dataset.visible = "true";
      wrapper.querySelectorAll("[data-single-choice]").forEach((input) => { input.required = input.dataset.required === "true"; });
      return;
    }
    wrapper.hidden = true;
    wrapper.dataset.visible = "false";
    wrapper.querySelectorAll("[data-single-choice]").forEach((input) => { input.required = false; input.value = ""; });
    wrapper.querySelectorAll("[data-quantity-choice]").forEach((input) => { input.value = "0"; });
  });
}


function updateProductPreview() {
  if (!activeProductPreview) return;
  const { dish, editing } = activeProductPreview;
  let extras = 0;
  let sizePrice = 0;
  let sizeSelected = false;
  let units = 0;
  dialogBody.querySelectorAll(".modifier-card").forEach((card) => {
    const input = card.querySelector("[data-quantity-choice]");
    const quantity = Number(input.value) || 0;
    card.classList.toggle("selected", quantity > 0);
    card.querySelector('[data-quantity-step="-1"]').disabled = quantity <= Number(input.min);
    card.querySelector('[data-quantity-step="1"]').disabled = quantity >= Number(input.max);
  });
  dialogBody.querySelectorAll("[data-modifier-wrapper]").forEach((wrapper, groupIndex) => {
    if (wrapper.hidden) return;
    const group = dish.modifier_groups[groupIndex];
    const selected = [];
    const included = includedChoices(wrapper, group);
    const choice = wrapper.querySelector("[data-single-choice]");
    if (choice?.value) {
      const price = Number(group.options.find((option) => option.name === choice.value)?.price || 0);
      selected.push({ quantity: 1, price });
      if (group.name === "Tamaño") { sizePrice = price; sizeSelected = true; }
    }
    wrapper.querySelectorAll("[data-quantity-choice]").forEach((input) => {
      const quantity = Number(input.value) || 0;
      units += quantity;
      selected.push({ quantity, included: included.get(input.dataset.quantityChoice) || 0, price: Number(group.options.find((option) => option.name === input.dataset.quantityChoice)?.price || 0) });
    });
    let groupCharge = 0;
    let groupUnits = 0;
    selected.forEach((option) => {
      groupCharge += (option.quantity - (option.included || 0)) * option.price;
      groupUnits += option.quantity;
    });
    extras += groupCharge;
    const summary = wrapper.querySelector("[data-included-summary]");
    if (summary) summary.textContent = `${Math.min(groupUnits, group.included_quantity)} de ${group.included_quantity} incluidos · ${Math.max(0, groupUnits - group.included_quantity)} extra${groupUnits - group.included_quantity === 1 ? "" : "s"} · ${money(groupCharge)} de recargo por combo`;
  });
  const quantity = Number(dialogBody.querySelector('[name="quantity"]')?.value) || 1;
  const total = isUnitProduct(dish) ? units * Number(dish.price) : (Number(dish.price) + extras) * quantity;
  const productPrice = dialogBody.querySelector("[data-product-price]");
  if (productPrice && dish.modifier_groups?.some((group) => group.name === "Tamaño")) productPrice.textContent = `${sizeSelected ? "" : "Desde "}${money(Number(dish.price) + sizePrice)}`;
  const submit = dialogActions.querySelector('[type="submit"]');
  if (submit) submit.textContent = `${editing ? "Guardar cambios" : "Agregar al pedido"} · ${money(total)}`;
}

function openItemEditDialog(tableId, itemId) {
  const table = state.tables.find((entry) => entry.id === tableId);
  const item = table?.items.find((child) => child.id === itemId);
  if (!item || !table) {
    showToast("No se encontró ese producto.", true);
    return;
  }
  const menuItem = state.menu.find((entry) => entry.id === item.menu_id);
  if (!menuItem) {
    showToast("El producto ya no está disponible.", true);
    return;
  }
  showAddItemDialog(table, menuItem, item);
}

function closeItemEditDialog() {
  dialog.close();
  dialogBody.innerHTML = "";
}

const originalShowDialogBody = dialogBody;
const originalShowDialogForm = dialogForm;
const originalShowDialogActions = dialogActions;

function setView(view) {
  if (!currentRole) return;
  if (currentRole === "cocina") view = "kitchen";
  activeView = view;
  activeTableId = null;
  productSearch = "";
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.querySelector(".main-nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-view]");
  if (!button) return;
  if (button.dataset.zone) activeZone = button.dataset.zone;
  setView(button.dataset.view);
});

appRoot.addEventListener("input", (event) => {
  if (event.target.id !== "productSearch") return;
  productSearch = event.target.value;
  filterKioskProducts();
});

appRoot.addEventListener("change", async (event) => {
  const statusSelect = event.target.closest("select[data-action=\"item-status-select\"]");
  if (!statusSelect) return;
  await sendAction({ type: "item_status_bulk", table_id: statusSelect.dataset.tableId, item_ids: JSON.parse(statusSelect.dataset.itemIds || "[]"), status: statusSelect.value });
});

appRoot.addEventListener("click", async (event) => {
  if (event.target.closest('[data-action="view-order"]')) { appRoot.querySelector("#tableOrder")?.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
  const profileButton = event.target.closest("[data-role]");
  if (profileButton) {
    currentRole = ["mozo", "barra", "cocina"].includes(profileButton.dataset.role) ? profileButton.dataset.role : "mozo";
    try { localStorage.setItem("comandaRole", currentRole); } catch (error) {}
    activeView = currentRole === "cocina" ? "kitchen" : "home";
    activeTableId = null;
    render();
    showToast(`Perfil ${{mozo:"Mozo",barra:"Barra / Cajero",cocina:"Cocina"}[currentRole]} activo.`);
    return;
  }
  const filterButton = event.target.closest("[data-kitchen-filter]");
  if (filterButton) { kitchenTimingFilter = filterButton.dataset.kitchenFilter; render(); return; }
  const goButton = event.target.closest("[data-go]");
  if (goButton) { setView(goButton.dataset.go); return; }
  const categoryButton = event.target.closest("[data-category]");
  if (categoryButton) { activeCategory = categoryButton.dataset.category; render(); return; }
  const tableButton = event.target.closest("[data-table]");
  if (tableButton) {
    const table = state.tables.find((entry) => entry.id === tableButton.dataset.table);
    if (!table) return;
    if (table.status === "free") {
      showOpenTableDialog(table);
    } else {
      activeTableId = table.id;
      activeView = "table-detail";
      render();
    }
    return;
  }
  const productButton = event.target.closest("[data-add-product]");
  if (productButton && activeView === "table-detail") {
    const table = state.tables.find((entry) => entry.id === activeTableId);
    const dish = state.menu.find((entry) => entry.id === productButton.dataset.addProduct);
    if (table && dish) showAddItemDialog(table, dish);
    return;
  }
  const priorityInput = event.target.closest('input[data-action="item-priority"]');
  if (priorityInput) {
    await sendAction({
      type: "item_priority_bulk",
      table_id: priorityInput.dataset.tableId,
      item_ids: JSON.parse(priorityInput.dataset.itemIds || "[]"),
      priority: priorityInput.checked,
    }, priorityInput.checked ? "Pedido marcado como prioridad." : "Prioridad quitada.");
    return;
  }
  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) return;
  const tableId = actionButton.dataset.tableId;
  if (actionButton.dataset.action === "add-table") showAddTableDialog();
  if (actionButton.dataset.action === "add-product") showProductDialog();
  if (actionButton.dataset.action === "edit-catalog") showCatalogDialog();
  if (actionButton.dataset.action === "edit-product") {
    const dish = state.menu.find((entry) => entry.id === actionButton.dataset.menuId);
    if (dish) showProductDialog(dish);
  }
  if (actionButton.dataset.action === "delete-product") {
    const dish = state.menu.find((entry) => entry.id === actionButton.dataset.menuId);
    if (dish && window.confirm(`¿Eliminar ${dish.name} de la carta?`)) await sendAction({ type: "menu_delete", menu_id: dish.id }, "Producto eliminado.");
  }
  if (actionButton.dataset.action === "send-order") await sendAction({ type: "order_send", table_id: tableId }, "Pedido enviado a cocina.");
  if (actionButton.dataset.action === "pay-items") {
    const table = state.tables.find((entry) => entry.id === tableId);
    if (table) showSeparatePaymentDialog(table);
  }
  if (actionButton.dataset.action === "pay-table") {
    if (window.confirm("¿Registrar el cobro y pasar la mesa a limpieza?")) await sendAction({ type: "table_paid", table_id: tableId }, "Cobro registrado. Mesa para limpiar.");
  }
  if (actionButton.dataset.action === "clean-table") {
    const cleaned = await sendAction({ type: "table_clean", table_id: tableId }, "Mesa liberada.");
    if (cleaned) setView("tables");
  }
  if (actionButton.dataset.action === "download-table-report") {
    const reportTable = state.tables.find((entry) => entry.id === tableId);
    if (reportTable) downloadTableReport(reportTable);
  }
  if (actionButton.dataset.action === "item-cancel") {
    const item = state.tables.find((entry) => entry.id === tableId)?.items.find((child) => child.id === actionButton.dataset.itemId);
    if (!item) {
      showToast("No se encontró ese producto.", true);
      return;
    }
    const confirmMessage = item.status === "canceled" ? "¿Reactivar este producto cancelado y devolverlo a cocina?" : `¿Cancelar este pedido? Se perderán los datos de la cocina actuales.`;
    if (!window.confirm(confirmMessage)) return;
    const nextStatus = item.status === "canceled" ? "draft" : "canceled";
    await sendAction({ type: "item_status", table_id: tableId, item_id: actionButton.dataset.itemId, status: nextStatus });
  }
  if (actionButton.dataset.action === "item-cancel-group") {
    const quantity = Number(actionButton.dataset.quantity) || 0;
    if (window.confirm(`\u00bfCancelar ${quantity} ${actionButton.dataset.name} de este grupo?`)) await sendAction({ type: "item_status_bulk", table_id: tableId, item_ids: JSON.parse(actionButton.dataset.itemIds || "[]"), status: "canceled" });
  }
  if (actionButton.dataset.action === "item-edit") {
    openItemEditDialog(tableId, actionButton.dataset.itemId);
  }  if (actionButton.dataset.action === "item-status") {
    await sendAction({ type: "item_status_bulk", table_id: tableId, item_ids: JSON.parse(actionButton.dataset.itemIds || "[]"), status: actionButton.dataset.status });
  }
  if (actionButton.dataset.action === "shift-start") {
    const shift = actionButton.dataset.shift;
    const started = await sendAction({ type: "shift_start", shift, waiter: waiterInput.value.trim() }, `Turno ${SHIFT_LABELS[shift]} iniciado.`);
    if (started) {
      activeView = currentRole === "cocina" ? "kitchen" : "home";
      activeTableId = null;
      render();
    }
  }
  if (actionButton.dataset.action === "shift-correct") {
    const nextShift = state.shift.type === "morning" ? "afternoon" : "morning";
    showDialog({ title: "Corregir turno", body: `<p>Turno actual: <b>${SHIFT_LABELS[state.shift.type]}</b>.</p><p>Se conservan las mesas, ventas y estadísticas del turno en curso.</p>`, submitLabel: `Cambiar a turno ${SHIFT_LABELS[nextShift]}`, onSubmit: () => sendAction({type:"shift_correct", shift:nextShift}, "Turno corregido.") });
    return;
  }
  if (actionButton.dataset.action === "shift-close") {
    const label = SHIFT_LABELS[state.shift?.type] || "";
    if (!window.confirm(`¿Cerrar el turno ${label}? Se guardan las estadísticas y las ventas arrancan de cero en el próximo turno.`)) return;
    const closed = await sendAction({ type: "shift_close" });
    if (closed) {
      activeView = "home";
      render();
      showShiftClosedDialog(state.sales_closures[state.sales_closures.length - 1]);
    }
  }
  if (actionButton.dataset.action === "closure-whatsapp") {
    const closure = state.sales_closures.find((entry) => entry.id === actionButton.dataset.closureId);
    if (closure) window.open(whatsappUrl(closure), "_blank");
  }
  if (actionButton.dataset.action === "finish-ticket") {
    const table = state.tables.find((entry) => entry.id === tableId);
    const pendingItems = table?.items.filter((item) => ["sent", "preparing", "suspended"].includes(item.status) && item.status !== "canceled") || [];
    if (pendingItems.length) await sendAction({ type: "item_status_bulk", table_id: tableId, item_ids: pendingItems.map((item) => item.id), status: "ready" });
  }
});

document.querySelector("#dialog").addEventListener("click", (event) => {
  if (event.target.closest("[data-close-dialog]")) dialog.close();
  const stepButton = event.target.closest("[data-quantity-step]");
  if (stepButton) {
    const quantityInput = stepButton.closest(".quantity-stepper")?.querySelector("input");
    if (!quantityInput) return;
    const minimum = Number(quantityInput.min);
    const maximum = Number(quantityInput.max);
    const current = Number(quantityInput.value);
    const next = Math.max(minimum, Math.min(maximum, (Number.isFinite(current) ? current : minimum) + Number(stepButton.dataset.quantityStep)));
    quantityInput.value = String(next);
    if (quantityInput.hasAttribute("data-payment-index")) dialogBody.oninput?.();
    syncConditionalModifierGroups();
    updateProductPreview();
  }
});

dialogBody.addEventListener("change", () => { syncConditionalModifierGroups(); updateProductPreview(); });

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  document.querySelector("#installButton").hidden = false;
});

document.querySelector("#installButton").addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  document.querySelector("#installButton").hidden = true;
});

document.querySelector("#roleButton").addEventListener("click", () => {
  currentRole = "";
  try { localStorage.removeItem("comandaRole"); } catch (error) {}
  activeView = "home";
  activeTableId = null;
  productSearch = "";
  render();
});

if ("serviceWorker" in navigator) {
  let hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController) window.location.reload();
    hadController = true;
  });
  navigator.serviceWorker.register("/sw.js?v=49", { updateViaCache: "none" }).catch(() => {});
}
loadState(true);
setInterval(() => loadState(), 2200);
setInterval(() => {
  if (state && activeView === "kitchen") renderKitchen();
}, 5000);
