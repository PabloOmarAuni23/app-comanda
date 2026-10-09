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
    const quantity = modifier.quantity * item.quantity;
    return { group: String(modifier.group ?? ""), option: quantity > 1 ? `${quantity} × ${modifier.name}` : String(modifier.name ?? "") };
  });
}

function itemModifierLines(item) {
  return itemModifierParts(item).map((part) => `${escapeHtml(part.group)}: ${escapeHtml(part.option)}`);
}

function itemModifierSummary(item) {
  return itemModifierLines(item).join(" · ");
}

function itemModifierText(item) {
  return itemModifierParts(item).map((part) => `${part.group}: ${part.option}`).join(" · ");
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

function pageHeading(eyebrow, title, subtitle, button = "") {
  return `<div class="page-heading"><div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div>${button}</div>`;
}

function renderReadyNotice() {
  if (currentRole !== "mozo") {
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

function applyRoleUi() {
  const picking = !currentRole;
  const kitchenOnly = currentRole === "cocina";
  document.querySelector(".main-nav").hidden = picking || kitchenOnly;
  document.querySelector(".waiter-field").hidden = picking || kitchenOnly;
  document.querySelector("#roleButton").hidden = picking;
  document.querySelectorAll(".nav-button").forEach((button) => {
    if (picking) button.classList.remove("active");
    else button.classList.toggle("active", kitchenOnly ? button.dataset.view === "kitchen" : button.dataset.view === activeView);
  });
}

function renderRolePicker() {
  applyRoleUi();
  readyNoticeElement.hidden = true;
  readyNoticeElement.innerHTML = "";
  appRoot.innerHTML = `<section class="role-screen"><div class="role-brand"><span class="brand-mark" aria-hidden="true">C</span><p class="eyebrow">Comanda del bar</p><h1>¿Cómo entrás hoy?</h1><p>Elegí un perfil para empezar. Podés cambiarlo cuando quieras con el botón ⇄ de la barra superior.</p></div><div class="role-grid"><button class="role-card" type="button" data-role="mozo"><span class="role-icon" aria-hidden="true">🍽</span><strong>Mozo / Moza</strong><span>Ves todo: mesas, carta, cocina, estado de los pedidos y descarga del detalle de cada mesa.</span></button><button class="role-card" type="button" data-role="cocina"><span class="role-icon" aria-hidden="true">♨</span><strong>Cocina</strong><span>Solo la producción: comandas, agregados, notas, prioridades y estados.</span></button></div></section>`;
}

function render() {
  if (!currentRole) { renderRolePicker(); return; }
  if (!state) return;
  if (currentRole === "cocina") activeView = "kitchen";
  applyRoleUi();
  renderReadyNotice();
  if (activeView === "home") renderHome();
  if (activeView === "tables") renderTables();
  if (activeView === "table-detail") renderTableDetail();
  if (activeView === "kitchen") renderKitchen();
  if (activeView === "statistics") renderStatistics();
  if (activeView === "menu") renderMenu();
}

function renderHome() {
  const free = state.tables.filter((table) => table.status === "free").length;
  const open = state.tables.filter((table) => table.status === "open").length;
  const cooking = state.tables.flatMap((table) => table.items).filter((item) => ["sent", "preparing", "suspended"].includes(item.status)).length;
  const ready = state.tables.flatMap((table) => table.items).filter((item) => item.status === "ready").length;
  const tables = state.tables.slice(0, 8).map((table) => `<button class="mini-table ${table.status === "open" ? "occupied" : ""}" data-table="${escapeHtml(table.id)}"><strong>${escapeHtml(table.name)}</strong><span>${table.status === "open" ? money(tableTotal(table)) : statusLabel(table.status)}</span></button>`).join("");
  const liveOrders = state.tables.filter((table) => table.status === "open" && table.items.length).slice(0, 4);
  const activity = liveOrders.length ? liveOrders.map((table) => `<button class="order-row" data-table="${escapeHtml(table.id)}"><span><span class="order-name">${escapeHtml(table.name)}</span><br><span class="order-meta">${table.items.length} ${table.items.length === 1 ? "producto" : "productos"} · ${escapeHtml(table.opened_by)}${guestsSuffix(table)}</span></span>${orderFlow(table) || `<span class="status open">En curso</span>`}<span class="order-price">${money(tableTotal(table))}</span></button>`).join("") : `<div class="activity-empty"><div class="empty-mark">⌂</div>Las mesas abiertas van a aparecer acá.</div>`;

  appRoot.innerHTML = `${pageHeading("Resumen del turno", "Comanda del bar", "Mesas, pedidos y cocina se actualizan entre todos los dispositivos.", `<button class="button button-secondary" data-go="statistics">Estadística</button>`)}
    <section class="stats" aria-label="Resumen de mesas y pedidos">
      <div class="stat"><div class="stat-label">Mesas libres</div><div class="stat-value">${free}</div></div>
      <div class="stat"><div class="stat-label">Abiertas</div><div class="stat-value">${open}</div></div>
      <div class="stat"><div class="stat-label">En cocina</div><div class="stat-value accent">${cooking}</div></div>
      <div class="stat"><div class="stat-label">Listos para retirar</div><div class="stat-value">${ready}</div></div>
    </section>
    <div class="home-grid">
      <section class="section-panel"><div class="section-title"><h2>Mesas</h2><button class="text-button" data-go="tables">Ver todas →</button></div><div class="overview-tables">${tables || ""}</div></section>
      <section class="section-panel"><div class="section-title"><h2>Pedidos activos</h2><button class="text-button" data-go="kitchen">Abrir cocina →</button></div><div class="order-list">${activity}</div></section>
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
    return `<article class="sales-closure"><div class="sales-closure-head"><strong>Turno ${shiftLabel}</strong><span>${closedDate}</span></div><div class="sales-closure-items">${items}</div><strong class="sales-closure-total">${Number(closure.total_units) || 0} unidades</strong></article>`;
  }).join("");
  const closeDisabled = pendingSales.length ? "" : "disabled";
  appRoot.innerHTML = `${pageHeading("Ventas", "Estadística", "Unidades de productos cobrados desde el último cierre de turno.", `<button class="button button-secondary" data-go="home">← Inicio</button>`)}
    <section class="section-panel sales-summary"><div class="section-title"><div><h2>Pendiente de cierre</h2><p class="order-meta">${pendingSales.length} productos · ${totalUnits} unidades</p></div></div><div class="sales-list">${saleRows}</div><div class="sales-close-actions"><button class="button button-primary" data-action="sales-close" data-shift="morning" ${closeDisabled}>Cerrar turno mañana y enviar por WhatsApp</button><button class="button button-primary" data-action="sales-close" data-shift="afternoon" ${closeDisabled}>Cerrar turno tarde y enviar por WhatsApp</button></div></section>
    <section class="section-panel sales-history"><div class="section-title"><h2>Últimos cierres</h2></div>${history || `<p class="order-meta">Todavía no hay cierres guardados.</p>`}</section>`;
}

function renderTables() {
  const openCount = state.tables.filter((table) => table.status === "open").length;
  const createButton = `<button class="button button-primary" data-action="add-table">＋ <span>Mesa</span></button>`;
  const tiles = state.tables.map((table) => {
    const description = table.status === "open" ? `${table.items.length} productos · ${money(tableTotal(table))}` : table.status === "cleaning" ? "Cobro registrado" : "Tocá para abrir";
    const caption = table.status === "open" ? `Atiende ${table.opened_by}${guestsSuffix(table)}` : statusLabel(table.status);
    return `<button class="table-tile ${table.status}" data-table="${escapeHtml(table.id)}"><span class="status ${table.status}">${statusLabel(table.status)}</span><strong>${escapeHtml(table.name)}</strong><span class="table-detail">${escapeHtml(description)}</span><span class="table-detail">${escapeHtml(caption)}</span>${table.status === "open" ? orderFlow(table) : ""}</button>`;
  }).join("");
  appRoot.innerHTML = `${pageHeading("Servicio", "Mesas", `${openCount} abiertas · tocá una mesa para abrirla o ver el pedido.`, createButton)}<div class="table-grid">${tiles}</div>`;
}

function renderTableDetail() {
  const table = state.tables.find((entry) => entry.id === activeTableId);
  if (!table) { activeView = "tables"; renderTables(); return; }
  if (table.status === "cleaning") {
    appRoot.innerHTML = `${pageHeading("Mesa cobrada", table.name, "La cuenta está cerrada. Cuando terminen de limpiar, liberá la mesa.", `<button class="button button-primary" data-action="clean-table" data-table-id="${escapeHtml(table.id)}">✓ Mesa limpia</button>`)}<section class="section-panel"><div class="empty-state"><div class="empty-mark">✓</div><h2>Cuenta cobrada</h2><p>Esta mesa queda visible para todo el equipo hasta marcarla limpia.</p></div></section>`;
    return;
  }
  if (table.status !== "open") { activeView = "tables"; renderTables(); return; }
  const categories = ["Todas", ...new Set(state.menu.filter((dish) => dish.available).map((dish) => dish.category))];
  if (!categories.includes(activeCategory)) activeCategory = "Todas";
  const dishes = state.menu.filter((dish) => dish.available && (activeCategory === "Todas" || dish.category === activeCategory));
  const categoryButtons = categories.map((category) => `<button class="category-button ${category === activeCategory ? "active" : ""}" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`).join("");
  const products = dishes.map((dish) => `<button class="product-button" data-add-product="${escapeHtml(dish.id)}"><strong>${escapeHtml(dish.name)}</strong><span>${escapeHtml(dish.description || dish.category)}</span><b>${money(dish.price)}</b></button>`).join("");
  const orderRows = table.items.length ? table.items.map((item) => {
    const canceled = item.status === "canceled";
    const controls = canceled
      ? `<button class="button button-secondary button-small" data-action="item-cancel" data-table-id="${escapeHtml(table.id)}" data-item-id="${escapeHtml(item.id)}">Reactivar</button>`
      : `<button class="button button-secondary button-small" data-action="item-edit" data-table-id="${escapeHtml(table.id)}" data-item-id="${escapeHtml(item.id)}">Editar</button><button class="button button-danger button-small" data-action="item-cancel" data-table-id="${escapeHtml(table.id)}" data-item-id="${escapeHtml(item.id)}">Cancelar</button>`;
    return `<div class="order-row ${item.status === "ready" ? "ready-order" : ""} ${canceled ? "canceled-order" : ""}"><div><div class="order-name">${item.quantity} × ${escapeHtml(item.name)}</div>${itemModifierSummary(item) ? `<div class="order-note">${itemModifierSummary(item)}</div>` : ""}${item.note ? `<div class="order-note">${escapeHtml(item.note)}</div>` : ""}<div class="order-meta">${item.status === "draft" ? `Agregado por ${escapeHtml(item.added_by)}` : `Tomado por ${escapeHtml(item.added_by)}`}</div><div class="order-controls">${controls}</div></div><span class="status ${item.status}">${item.status === "ready" ? "Listo para retirar" : statusLabel(item.status)}</span><span class="order-price">${money(canceled ? 0 : item.price * item.quantity)}</span></div>`;
  }).join("") : `<div class="empty-state"><div class="empty-mark">＋</div><h2>La mesa está abierta</h2><p>Agregá productos de la carta para empezar.</p></div>`;
  const billableItems = table.items.filter((item) => item.status !== "canceled");
  const hasDraft = billableItems.some((item) => item.status === "draft");
  const sendButton = hasDraft ? `<button class="button button-primary" data-action="send-order" data-table-id="${escapeHtml(table.id)}">Enviar a cocina</button>` : "";
  const canPay = billableItems.length > 0 && !hasDraft && billableItems.every((item) => item.status === "ready");
  const payButton = canPay ? `<button class="button button-secondary" data-action="pay-table" data-table-id="${escapeHtml(table.id)}">Cobrar ${money(tableTotal(table))}</button>` : "";
  const disabledPayMessage = !billableItems.length && table.items.length
    ? `<p class="order-meta">No hay productos activos para cobrar. Podés reactivar un producto cancelado.</p>`
    : billableItems.length && !canPay
      ? `<p class="order-meta">${hasDraft ? "Enviá los productos nuevos a cocina para cobrar." : "Podés cobrar cuando todos los productos estén listos."}</p>`
      : "";
  appRoot.innerHTML = `${pageHeading("Pedido de mesa", table.name, `Abierta por ${escapeHtml(table.opened_by)}${guestsSuffix(table)} · Total ${money(tableTotal(table))}`, `<button class="button button-secondary" data-go="tables">← Mesas</button>`)}
    <section class="section-panel"><div class="section-title"><h2>Carta</h2><button class="text-button" data-go="menu">Editar carta →</button></div><div class="category-row">${categoryButtons}</div><div class="product-grid">${products || `<div class="empty-state">No hay productos en esta categoría.</div>`}</div></section>
    <section class="table-section section-panel"><div class="section-title"><h2>Pedido <span class="order-meta">${table.items.length} productos</span></h2><strong>${money(tableTotal(table))}</strong></div><div class="order-list">${orderRows}</div><div class="dialog-actions">${disabledPayMessage}${sendButton}${payButton}</div></section>`;
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
  const countFor = (className) => activeItems.filter(({ timing }) => timing.className === className).length;
  const filters = [["all", "Todos", activeItems.length], ["ticket-on-time", "A tiempo", countFor("ticket-on-time")], ["ticket-delayed", "Demorado", countFor("ticket-delayed")], ["ticket-very-late", "Muy demorado", countFor("ticket-very-late")], ["ticket-cancel-risk", "Crítico", countFor("ticket-cancel-risk")]]
    .map(([key, label, amount]) => `<button class="kitchen-filter ${key === kitchenTimingFilter ? "active" : ""} ${key === "all" ? "" : key}" data-kitchen-filter="${key}" type="button">${label} <span>${amount}</span></button>`).join("");
  const cards = tickets.map((table) => {
    const items = table.items.filter((item) => ["sent", "preparing", "suspended"].includes(item.status)).sort((left, right) => Number(Boolean(right.priority)) - Number(Boolean(left.priority)) || (Date.parse(left.sent_at || "") || 0) - (Date.parse(right.sent_at || "") || 0));
    const oldestItem = items.reduce((oldest, item) => (Date.parse(item.sent_at || "") || 0) < (Date.parse(oldest.sent_at || "") || 0) ? item : oldest);
    const timing = kitchenTiming(oldestItem.sent_at);
    if (kitchenTimingFilter !== "all" && timing.className !== kitchenTimingFilter) return "";
    const renderedItems = items.map((item) => {
      const options = item.status === "sent" ? [["sent", "Pendiente"], ["preparing", "En preparación"], ["ready", "Terminado"], ["suspended", "Demorado"]] : item.status === "preparing" ? [["preparing", "En preparación"], ["ready", "Terminado"], ["suspended", "Demorado"]] : [["suspended", "Demorado"], ["preparing", "En preparación"], ["ready", "Terminado"]];
      const optionMarkup = options.map(([value, label]) => `<option value="${value}" ${item.status === value ? "selected" : ""}>${label}</option>`).join("");
      const modifierLines = itemModifierLines(item);
      const nextStatus = item.status === "preparing" ? "ready" : "preparing";
      const nextLabel = nextStatus === "preparing" ? "Empezar" : "Terminar producto";
      const priorityToggle = `<label class="priority-toggle"><input type="checkbox" data-action="item-priority" data-table-id="${escapeHtml(table.id)}" data-item-id="${escapeHtml(item.id)}" ${item.priority ? "checked" : ""}><span>Prioridad</span></label>`;
      const isCanceled = item.status === "canceled";
      const hasEditableControls = !isCanceled && (item.status === "sent" || item.status === "preparing" || item.status === "suspended" || item.status === "ready");
      const editButton = `<button class="kitchen-advance" type="button" title="Editar pedido" aria-label="Editar ${escapeHtml(item.name)}" data-action="item-edit" data-table-id="${escapeHtml(table.id)}" data-item-id="${escapeHtml(item.id)}">✎</button>`;
      const cancelButton = `<button class="kitchen-advance kitchen-cancel" type="button" title="Cancelar pedido" aria-label="Cancelar ${escapeHtml(item.name)}" data-action="item-cancel" data-table-id="${escapeHtml(table.id)}" data-item-id="${escapeHtml(item.id)}">✕</button>`;
      const statusControls = isCanceled
        ? `<span class="status canceled">Cancelado</span>`
        : `<select class="kitchen-state-select" aria-label="Estado de ${escapeHtml(item.name)}" data-action="item-status-select" data-table-id="${escapeHtml(table.id)}" data-item-id="${escapeHtml(item.id)}">${optionMarkup}</select><button class="kitchen-advance" type="button" title="${nextLabel}" aria-label="${nextLabel}" data-action="item-status" data-table-id="${escapeHtml(table.id)}" data-item-id="${escapeHtml(item.id)}" data-status="${nextStatus}">▶</button>`;
      return `<article class="ticket-item ${item.priority ? "ticket-priority" : ""} ${isCanceled ? "ticket-canceled" : ""}"><div class="ticket-product"><span class="ticket-item-quantity">${item.quantity}</span><div><strong>${escapeHtml(item.name)}</strong>${modifierLines.length ? `<p class="ticket-modifiers">${modifierLines.join("<br>")}</p>` : ""}${item.note ? `<p class="ticket-note">${escapeHtml(item.note)}</p>` : ""}</div></div><div class="ticket-item-controls">${statusControls}</div>${isCanceled ? "" : `<div class="ticket-item-tools">${priorityToggle}${hasEditableControls ? editButton + cancelButton : ""}</div>`}</article>`;
    }).join("");
    return `<section class="kitchen-ticket"><header class="ticket-head ${timing.className}"><div class="ticket-heading-main"><div class="ticket-heading-top"><span class="ticket-sent-time">${kitchenSentTime(oldestItem.sent_at)}</span><span class="kitchen-timer" role="timer" aria-label="Pedido hace ${timing.minutes} minutos: ${timing.label}"><strong>${timing.minutes} min</strong></span></div><h2>${escapeHtml(table.name)}</h2><p>Principal · Atiende ${escapeHtml(table.opened_by)}${guestsSuffix(table)}</p></div><span class="status open">${items.length} prod.</span></header><div class="ticket-items">${renderedItems}</div><footer class="ticket-footer"><span class="ticket-footer-meta">${items.length} pendientes</span><button class="button button-finish-all" data-action="finish-ticket" data-table-id="${escapeHtml(table.id)}">Terminar todo</button></footer></section>`;
  }).join("");
  const readyCount = state.tables.reduce((sum, table) => sum + table.items.filter((item) => item.status === "ready").length, 0);
  appRoot.innerHTML = `<div class="kitchen-board-heading"><div><p class="eyebrow">Producción</p><h1>Cocina</h1></div><span class="status ready">${readyCount} listos</span></div><div class="kitchen-toolbar" aria-label="Filtrar comandas">${filters}</div><div class="kitchen-grid">${cards || `<section class="section-panel kitchen-empty"><div class="empty-state"><div class="empty-mark">♨</div><h2>${activeItems.length ? "No hay pedidos en este filtro" : "Cocina al día"}</h2><p>${activeItems.length ? "Elegí otro tiempo para ver las comandas." : "Los pedidos enviados por los mozos van a aparecer acá."}</p></div></section>`}</div>`;
}

function renderMenu() {
  const addButton = `<button class="button button-primary" data-action="add-product">＋ <span>Plato</span></button>`;
  const categories = [...new Set(state.menu.map((dish) => dish.category))];
  const rows = categories.map((category) => {
    const products = state.menu.filter((dish) => dish.category === category).map((dish) => `<article class="menu-row ${dish.available ? "" : "unavailable"}"><div><h3>${escapeHtml(dish.name)}</h3><p>${escapeHtml(dish.description || "Sin descripción")} · ${dish.available ? "Disponible" : "Pausado"}</p></div><strong>${money(dish.price)}</strong><div class="menu-actions"><button class="icon-button" data-action="edit-product" data-menu-id="${escapeHtml(dish.id)}" aria-label="Editar ${escapeHtml(dish.name)}" title="Editar">✎</button><button class="icon-button" data-action="delete-product" data-menu-id="${escapeHtml(dish.id)}" aria-label="Eliminar ${escapeHtml(dish.name)}" title="Eliminar">×</button></div></article>`).join("");
    return `<section class="table-section"><h2 class="menu-category">${escapeHtml(category)}</h2><div class="menu-list">${products}</div></section>`;
  }).join("");
  appRoot.innerHTML = `${pageHeading("Productos y precios", "Carta del bar", `${state.menu.length} productos · los cambios se ven en todos los teléfonos.`, addButton)}${rows || `<section class="section-panel"><div class="empty-state"><h2>La carta está vacía</h2><p>Agregá el primer producto para empezar.</p></div></section>`}`;
}

function showDialog({ eyebrow = "", title, body, submitLabel = "Guardar", onSubmit }) {
  document.querySelector("#dialogEyebrow").textContent = eyebrow;
  document.querySelector("#dialogTitle").textContent = title;
  dialogBody.innerHTML = body;
  dialogActions.innerHTML = `<button class="button button-secondary" type="button" data-close-dialog>Cancelar</button><button class="button button-primary" type="submit">${escapeHtml(submitLabel)}</button>`;
  dialogForm.onsubmit = async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(dialogForm).entries());
    const completed = await onSubmit(data);
    if (completed) dialog.close();
  };
  dialog.showModal();
  dialog.querySelector("input, textarea, select")?.focus();
}

function showAddTableDialog() {
  showDialog({ eyebrow: "Salón", title: "Agregar mesa", body: `<label class="dialog-field">Nombre o número<input name="name" maxlength="40" placeholder="Por ejemplo: Patio 1" required></label>`, submitLabel: "Agregar mesa", onSubmit: (data) => sendAction({ type: "table_create", name: data.name }, "Mesa agregada.") });
}

function showOpenTableDialog(table) {
  const body = `<label class="dialog-field">¿Cuántas personas se sientan?<div class="quantity-stepper"><button class="quantity-step" type="button" data-quantity-step="-1" aria-label="Menos personas">−</button><input name="guests" type="number" min="1" max="30" value="2" inputmode="none" readonly required aria-live="polite"><button class="quantity-step" type="button" data-quantity-step="1" aria-label="Más personas">+</button></div></label><label class="dialog-field">Nombre del mozo o moza<input name="waiter" maxlength="40" value="${escapeHtml(waiterInput.value)}" placeholder="Escribí tu nombre" required></label>`;
  showDialog({ eyebrow: table.name, title: "Abrir mesa", body, submitLabel: "Abrir mesa", onSubmit: async (data) => {
    const waiter = data.waiter.trim().slice(0, 40);
    if (!waiter) return false;
    const guests = Math.max(1, Math.min(30, Number(data.guests) || 1));
    waiterInput.value = waiter;
    const opened = await sendAction({ type: "table_open", table_id: table.id, waiter, guests }, `${table.name} abierta · ${guests} ${guests === 1 ? "persona" : "personas"} · atiende ${waiter}.`);
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
    showGroupIndex: group.querySelector("[data-group-show-group]")?.value ?? "",
    showOptionIndexes: [...group.querySelectorAll("[data-group-show-option]:checked")].map((checkbox) => Number(checkbox.value)),
    options: [...group.querySelectorAll("[data-modifier-option]")].map((option) => ({
      name: option.querySelector("[data-option-name]").value.trim(),
      price: option.querySelector("[data-option-price]").value,
    })),
  }));
  return entries.map((entry) => {
    const group = { name: entry.name, selection: entry.selection, required: entry.required, options: entry.options };
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
    <label class="modifier-required"><input type="checkbox" data-group-required ${group.required ? "checked" : ""}><span>Obligatorio</span></label>
    <div class="modifier-options">${group.options.map((option) => `<div class="modifier-option" data-modifier-option><label class="dialog-field">Opción<input data-option-name maxlength="60" value="${escapeHtml(option.name)}" placeholder="Ej.: Mate cocido" required></label><label class="dialog-field modifier-price">Adicional<input data-option-price type="number" min="0" step="1" value="${escapeHtml(option.price ?? 0)}" required></label><button class="icon-button" type="button" data-group-action="remove-option" aria-label="Quitar opción">×</button></div>`).join("")}</div>
    <button class="text-button" type="button" data-group-action="add-option">＋ Agregar opción</button>
  </section>`;
  }).join("");
  return `<div class="modifier-editor"><h3>Opciones para el pedido</h3><p class="modifier-help">Se muestran al elegir este producto. Usá un adicional de $0 para opciones incluidas; solo los agregados con recargo aumentan el precio. Con «Mostrar cuando» el grupo se abre recién al marcar la opción que lo activa, por ejemplo los acompañamientos al elegir la infusión.</p>${groupRows || `<p class="modifier-empty">Sin opciones configuradas.</p>`}<button class="button button-secondary" type="button" data-group-action="add-group">＋ Agregar grupo</button></div>`;
}

function showProductDialog(dish = null) {
  const editing = Boolean(dish);
  const categories = [...new Set(state.menu.map((entry) => entry.category))];
  const categoryOptions = [...new Set([...categories, "Infusiones", "Para acompañar", "Bebidas"])].map((category) => `<option value="${escapeHtml(category)}" ${dish?.category === category ? "selected" : ""}>${escapeHtml(category)}</option>`).join("");
  const groups = dish?.modifier_groups || [];
  const body = `<label class="dialog-field">Nombre del producto<input name="name" maxlength="80" value="${escapeHtml(dish?.name || "")}" required></label><label class="dialog-field">Categoría<select name="category" required>${categoryOptions}<option value="__custom">Otra categoría…</option></select></label><label class="dialog-field custom-category" hidden>Nueva categoría<input name="custom_category" maxlength="40"></label><label class="dialog-field">Descripción<textarea name="description" maxlength="120" placeholder="Detalle opcional">${escapeHtml(dish?.description || "")}</textarea></label><label class="dialog-field">Precio en pesos<input name="price" type="number" min="0" step="1" value="${escapeHtml(dish?.price ?? "")}" required></label>${editing ? `<label class="dialog-field">Disponibilidad<select name="available"><option value="true" ${dish.available ? "selected" : ""}>Disponible</option><option value="false" ${!dish.available ? "selected" : ""}>Pausado</option></select></label>` : ""}${modifierGroupEditor(groups)}`;
  showDialog({ eyebrow: editing ? "Editar carta" : "Carta del bar", title: editing ? "Editar producto" : "Nuevo producto", body, submitLabel: editing ? "Guardar cambios" : "Agregar producto", onSubmit: (data) => {
    const category = data.category === "__custom" ? data.custom_category : data.category;
    const action = { type: editing ? "menu_update" : "menu_add", menu_id: dish?.id, name: data.name, category, description: data.description, price: data.price, available: data.available !== "false", modifier_groups: readModifierGroups() };
    return sendAction(action, editing ? "Producto actualizado." : "Producto agregado.");
  } });
  dialogBody.onclick = (event) => {
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

function showAddItemDialog(table, dish, item = null) {
  const groups = dish.modifier_groups || [];
  const selectedModifiers = item?.modifiers || [];
  const modifierFields = groups.map((group, groupIndex) => {
    const condition = group.show_when || null;
    const wrapperAttributes = `data-modifier-wrapper data-modifier-group-name="${escapeHtml(group.name)}"${condition ? ` data-conditional-group data-when-group="${escapeHtml(condition.group)}" data-when-options="${escapeHtml(JSON.stringify(condition.options || []))}"` : ""}`;
    const conditionHint = condition ? `<small class="modifier-condition-hint">Se abre al elegir ${escapeHtml(condition.group)}</small>` : "";
    const options = group.options.map((option, optionIndex) => {
      const surcharge = option.price ? ` · +${money(option.price)}` : " · incluido";
      return group.selection === "single"
        ? `<option value="${escapeHtml(option.name)}" ${selectedModifiers.some((modifier) => modifier.group === group.name && modifier.name === option.name) ? "selected" : ""}>${escapeHtml(option.name)}${surcharge}</option>`
        : `<div class="modifier-quantity-row"><span>${escapeHtml(option.name)}${surcharge}</span><div class="quantity-stepper modifier-stepper"><button class="quantity-step" type="button" data-quantity-step="-1" aria-label="Disminuir ${escapeHtml(option.name)}">−</button><input name="modifier-${groupIndex}-${optionIndex}" data-quantity-choice="${escapeHtml(option.name)}" type="number" min="0" max="99" value="${selectedModifiers.find((modifier) => modifier.group === group.name && modifier.name === option.name)?.quantity || 0}" inputmode="none" readonly aria-label="Cantidad de ${escapeHtml(option.name)}"><button class="quantity-step" type="button" data-quantity-step="1" aria-label="Aumentar ${escapeHtml(option.name)}">+</button></div></div>`;
    }).join("");
    return group.selection === "single"
      ? `<label class="dialog-field modifier-selection" ${wrapperAttributes}>${escapeHtml(group.name)}${group.required ? " · obligatorio" : ""}${conditionHint}<select name="modifier-group-${groupIndex}" data-single-choice ${group.required ? 'data-required="true" required' : ""}><option value="">${group.required ? "Elegí una opción" : "Sin selección"}</option>${options}</select></label>`
      : `<fieldset class="modifier-selection" ${wrapperAttributes}><legend>${escapeHtml(group.name)}${group.required ? " · elegí al menos una" : ""}</legend>${conditionHint}${options}</fieldset>`;
  }).join("");
  const quantityField = item ? `<label class="dialog-field">Cantidad<div class="quantity-stepper"><button class="quantity-step" type="button" data-quantity-step="-1" aria-label="Menos">−</button><input name="quantity" type="number" min="1" max="99" value="${item.quantity}" required><button class="quantity-step" type="button" data-quantity-step="1" aria-label="Más">＋</button></div></label>` : "";
  const body = `<div class="dialog-product-line"><strong>${escapeHtml(dish.name)}</strong><span>${money(dish.price)}</span></div>${quantityField}<p class="dialog-hint">${item ? "Los cambios se actualizarán también en cocina." : "Se agrega de a 1 plato por vez · repetí el producto si querés pedir más de uno."}</p>${modifierFields}<label class="priority-field"><input name="priority" type="checkbox" ${item?.priority ? "checked" : ""}><span>Prioridad</span><small>Producto rápido de preparar</small></label><label class="dialog-field">Nota para cocina<textarea name="note" maxlength="160" placeholder="Ej.: sin azúcar, bien tostado">${escapeHtml(item?.note || "")}</textarea></label>`;
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
      group.options.forEach((option, optionIndex) => {
        const quantity = Number(data[`modifier-${groupIndex}-${optionIndex}`]) || 0;
        if (quantity > 0) {
          selectedCount += quantity;
          modifiers.push({ group: group.name, option: option.name, quantity });
        }
      });
      if (group.required && selectedCount === 0) {
        showToast(`Elegí al menos una opción para ${group.name}.`, true);
        missingRequiredGroup = group.name;
      }
    });
    if (missingRequiredGroup) return false;
    const action = item
      ? { type: "item_edit", table_id: table.id, item_id: item.id, menu_id: dish.id, quantity: Number(data.quantity), modifiers, note: data.note, priority: data.priority === "on", waiter: waiterInput.value.trim() || table.opened_by }
      : { type: "item_add", table_id: table.id, menu_id: dish.id, quantity: 1, modifiers, note: data.note, priority: data.priority === "on", waiter: waiterInput.value.trim() || table.opened_by };
    return sendAction(action, item ? `${dish.name} actualizado en cocina.` : `${dish.name} agregado.`);
  } });
  syncConditionalModifierGroups();
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
    const wasVisible = wrapper.dataset.visible !== "false";
    const singleChoice = wrapper.querySelector("[data-single-choice]");
    if (visible) {
      wrapper.hidden = false;
      wrapper.dataset.visible = "true";
      if (wasVisible) return;
      if (singleChoice) singleChoice.required = singleChoice.dataset.required === "true";
      return;
    }
    wrapper.hidden = true;
    wrapper.dataset.visible = "false";
    if (singleChoice) {
      singleChoice.required = false;
      singleChoice.value = "";
    }
    wrapper.querySelectorAll("[data-quantity-choice]").forEach((input) => { input.value = "0"; });
  });
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
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.querySelector(".main-nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-view]");
  if (button) setView(button.dataset.view);
});

appRoot.addEventListener("change", async (event) => {
  const statusSelect = event.target.closest("select[data-action=\"item-status-select\"]");
  if (!statusSelect) return;
  await sendAction({ type: "item_status", table_id: statusSelect.dataset.tableId, item_id: statusSelect.dataset.itemId, status: statusSelect.value });
});

appRoot.addEventListener("click", async (event) => {
  const profileButton = event.target.closest("[data-role]");
  if (profileButton) {
    currentRole = profileButton.dataset.role === "cocina" ? "cocina" : "mozo";
    try { localStorage.setItem("comandaRole", currentRole); } catch (error) {}
    activeView = currentRole === "cocina" ? "kitchen" : "home";
    activeTableId = null;
    render();
    showToast(currentRole === "cocina" ? "Perfil Cocina activo." : "Perfil Mozo activo.");
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
      type: "item_priority",
      table_id: priorityInput.dataset.tableId,
      item_id: priorityInput.dataset.itemId,
      priority: priorityInput.checked,
    }, priorityInput.checked ? "Pedido marcado como prioridad." : "Prioridad quitada.");
    return;
  }
  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) return;
  const tableId = actionButton.dataset.tableId;
  if (actionButton.dataset.action === "add-table") showAddTableDialog();
  if (actionButton.dataset.action === "add-product") showProductDialog();
  if (actionButton.dataset.action === "edit-product") {
    const dish = state.menu.find((entry) => entry.id === actionButton.dataset.menuId);
    if (dish) showProductDialog(dish);
  }
  if (actionButton.dataset.action === "delete-product") {
    const dish = state.menu.find((entry) => entry.id === actionButton.dataset.menuId);
    if (dish && window.confirm(`¿Eliminar ${dish.name} de la carta?`)) await sendAction({ type: "menu_delete", menu_id: dish.id }, "Producto eliminado.");
  }
  if (actionButton.dataset.action === "send-order") await sendAction({ type: "order_send", table_id: tableId }, "Pedido enviado a cocina.");
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
  if (actionButton.dataset.action === "item-edit") {
    openItemEditDialog(tableId, actionButton.dataset.itemId);
  }  if (actionButton.dataset.action === "item-status") {
    await sendAction({ type: "item_status", table_id: tableId, item_id: actionButton.dataset.itemId, status: actionButton.dataset.status });
  }
  if (actionButton.dataset.action === "sales-close") {
    const shift = actionButton.dataset.shift;
    const shiftLabel = shift === "morning" ? "mañana" : "tarde";
    if (!window.confirm(`¿Cerrar el turno ${shiftLabel}? Las ventas actuales quedarán separadas para el siguiente turno.`)) return;
    const whatsappWindow = window.open("about:blank", "_blank");
    const closed = await sendAction({ type: "sales_close", shift }, `Cierre del turno ${shiftLabel} guardado.`);
    if (!closed) { whatsappWindow?.close(); return; }
    const closure = state.sales_closures[state.sales_closures.length - 1];
    const lines = closure.items.map((item) => `• ${item.name}: ${item.quantity}`);
    const message = [`CIERRE TURNO ${shiftLabel.toUpperCase()}`, `Fecha: ${new Date(closure.closed_at).toLocaleString("es-AR")}`, "", "Productos vendidos:", ...lines, "", `Total de unidades: ${closure.total_units}`].join("\n");
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(message)}`;
    if (whatsappWindow) whatsappWindow.location.href = whatsappUrl;
    else showToast("El cierre quedó guardado, pero el navegador bloqueó la ventana de WhatsApp.", true);
  }
  if (actionButton.dataset.action === "finish-ticket") {
    const table = state.tables.find((entry) => entry.id === tableId);
    const pendingItems = table?.items.filter((item) => ["sent", "preparing", "suspended"].includes(item.status) && item.status !== "canceled") || [];
    for (const item of pendingItems) {
      const completed = await sendAction({ type: "item_status", table_id: tableId, item_id: item.id, status: "ready" });
      if (!completed) break;
    }
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
    syncConditionalModifierGroups();
  }
});

dialogBody.addEventListener("change", () => syncConditionalModifierGroups());

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
  render();
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js?v=12").catch(() => {});
loadState(true);
setInterval(() => loadState(), 2200);
setInterval(() => {
  if (state && activeView === "kitchen") renderKitchen();
}, 5000);
