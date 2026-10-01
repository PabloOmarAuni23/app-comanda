const appRoot = document.querySelector("#app");
const dialog = document.querySelector("#dialog");
const dialogForm = document.querySelector("#dialogForm");
const dialogBody = document.querySelector("#dialogBody");
const dialogActions = document.querySelector("#dialogActions");
const toastElement = document.querySelector("#toast");
const syncElement = document.querySelector("#syncState");
const waiterInput = document.querySelector("#waiterName");

let state = null;
let activeView = "home";
let activeTableId = null;
let activeCategory = "Todas";
let lastToastTimer;
let deferredInstallPrompt = null;
let requestPending = false;

waiterInput.value = localStorage.getItem("comanda-waiter") || "Equipo";
waiterInput.addEventListener("change", () => {
  const name = waiterInput.value.trim().slice(0, 40) || "Equipo";
  waiterInput.value = name;
  localStorage.setItem("comanda-waiter", name);
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function money(value) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(Number(value) || 0);
}

function tableTotal(table) {
  return table.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

function statusLabel(status) {
  return ({ free: "Libre", open: "Abierta", cleaning: "Para limpiar", draft: "Sin enviar", sent: "En cocina", preparing: "En proceso", ready: "Listo", suspended: "Demorado" })[status] || status;
}

function showToast(message, error = false) {
  toastElement.textContent = message;
  toastElement.style.background = error ? "#9e4034" : "#202923";
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

function render() {
  if (!state) return;
  document.querySelectorAll(".nav-button").forEach((button) => button.classList.toggle("active", button.dataset.view === activeView));
  if (activeView === "home") renderHome();
  if (activeView === "tables") renderTables();
  if (activeView === "table-detail") renderTableDetail();
  if (activeView === "kitchen") renderKitchen();
  if (activeView === "menu") renderMenu();
}

function renderHome() {
  const free = state.tables.filter((table) => table.status === "free").length;
  const open = state.tables.filter((table) => table.status === "open").length;
  const cooking = state.tables.flatMap((table) => table.items).filter((item) => ["sent", "preparing", "suspended"].includes(item.status)).length;
  const ready = state.tables.flatMap((table) => table.items).filter((item) => item.status === "ready").length;
  const tables = state.tables.slice(0, 8).map((table) => `<button class="mini-table ${table.status === "open" ? "occupied" : ""}" data-table="${escapeHtml(table.id)}"><strong>${escapeHtml(table.name)}</strong><span>${table.status === "open" ? money(tableTotal(table)) : statusLabel(table.status)}</span></button>`).join("");
  const liveOrders = state.tables.filter((table) => table.status === "open" && table.items.length).slice(0, 4);
  const activity = liveOrders.length ? liveOrders.map((table) => `<button class="order-row" data-table="${escapeHtml(table.id)}"><span><span class="order-name">${escapeHtml(table.name)}</span><br><span class="order-meta">${table.items.length} ${table.items.length === 1 ? "producto" : "productos"} · ${escapeHtml(table.opened_by)}</span></span><span class="status open">${table.items.some((item) => item.status === "draft") ? "Sin enviar" : "En curso"}</span><span class="order-price">${money(tableTotal(table))}</span></button>`).join("") : `<div class="activity-empty"><div class="empty-mark">⌂</div>Las mesas abiertas van a aparecer acá.</div>`;

  appRoot.innerHTML = `${pageHeading("Resumen del turno", "Comanda del bar", "Mesas, pedidos y cocina se actualizan entre todos los dispositivos.")}
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

function renderTables() {
  const openCount = state.tables.filter((table) => table.status === "open").length;
  const createButton = `<button class="button button-primary" data-action="add-table">＋ <span>Mesa</span></button>`;
  const tiles = state.tables.map((table) => {
    const description = table.status === "open" ? `${table.items.length} productos · ${money(tableTotal(table))}` : table.status === "cleaning" ? "Cobro registrado" : "Tocá para abrir";
    const caption = table.status === "open" ? `Atiende ${table.opened_by}` : statusLabel(table.status);
    return `<button class="table-tile ${table.status}" data-table="${escapeHtml(table.id)}"><span class="status ${table.status}">${statusLabel(table.status)}</span><strong>${escapeHtml(table.name)}</strong><span class="table-detail">${escapeHtml(description)}</span><span class="table-detail">${escapeHtml(caption)}</span></button>`;
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
  const orderRows = table.items.length ? table.items.map((item) => `<div class="order-row"><div><div class="order-name">${item.quantity} × ${escapeHtml(item.name)}</div>${item.note ? `<div class="order-note">${escapeHtml(item.note)}</div>` : ""}<div class="order-meta">${item.status === "draft" ? `Agregado por ${escapeHtml(item.added_by)}` : `Tomado por ${escapeHtml(item.added_by)}`}</div></div><span class="status ${item.status}">${statusLabel(item.status)}</span><span class="order-price">${money(item.price * item.quantity)}</span></div>`).join("") : `<div class="empty-state"><div class="empty-mark">＋</div><h2>La mesa está abierta</h2><p>Agregá productos de la carta para empezar.</p></div>`;
  const hasDraft = table.items.some((item) => item.status === "draft");
  const sendButton = hasDraft ? `<button class="button button-primary" data-action="send-order" data-table-id="${escapeHtml(table.id)}">Enviar a cocina</button>` : "";
  const canPay = table.items.length > 0 && !hasDraft && table.items.every((item) => item.status === "ready");
  const payButton = canPay ? `<button class="button button-secondary" data-action="pay-table" data-table-id="${escapeHtml(table.id)}">Cobrar ${money(tableTotal(table))}</button>` : "";
  const disabledPayMessage = table.items.length && !canPay ? `<p class="order-meta">${hasDraft ? "Enviá los productos nuevos a cocina para cobrar." : "Podés cobrar cuando todos los productos estén listos."}</p>` : "";
  appRoot.innerHTML = `${pageHeading("Pedido de mesa", table.name, `Abierta por ${escapeHtml(table.opened_by)} · Total ${money(tableTotal(table))}`, `<button class="button button-secondary" data-go="tables">← Mesas</button>`)}
    <section class="section-panel"><div class="section-title"><h2>Carta</h2><button class="text-button" data-go="menu">Editar carta →</button></div><div class="category-row">${categoryButtons}</div><div class="product-grid">${products || `<div class="empty-state">No hay productos en esta categoría.</div>`}</div></section>
    <section class="table-section section-panel"><div class="section-title"><h2>Pedido <span class="order-meta">${table.items.length} productos</span></h2><strong>${money(tableTotal(table))}</strong></div><div class="order-list">${orderRows}</div><div class="dialog-actions">${disabledPayMessage}${sendButton}${payButton}</div></section>`;
}

function minutesSince(timestamp) {
  return timestamp ? Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 60000)) : 0;
}

function renderKitchen() {
  const tickets = state.tables.filter((table) => table.status === "open" && table.items.some((item) => ["sent", "preparing", "suspended"].includes(item.status)));
  const count = tickets.reduce((sum, table) => sum + table.items.filter((item) => ["sent", "preparing", "suspended"].includes(item.status)).length, 0);
  const cards = tickets.map((table) => {
    const items = table.items.filter((item) => ["sent", "preparing", "suspended"].includes(item.status));
    const renderedItems = items.map((item) => {
      const minutes = minutesSince(item.sent_at);
      const urgencyClass = minutes < 15 ? "ticket-young" : minutes < 30 ? "ticket-mid" : "ticket-old";
      const actionButtons = item.status === "sent"
        ? `<button class="button button-primary button-small" data-action="item-status" data-table-id="${escapeHtml(table.id)}" data-item-id="${escapeHtml(item.id)}" data-status="preparing">Empezar</button>`
        : "";
      const otherButtons = `<button class="button button-secondary button-small" data-action="item-status" data-table-id="${escapeHtml(table.id)}" data-item-id="${escapeHtml(item.id)}" data-status="ready">Listo</button><button class="button button-secondary button-small" data-action="item-status" data-table-id="${escapeHtml(table.id)}" data-item-id="${escapeHtml(item.id)}" data-status="${item.status === "suspended" ? "preparing" : "suspended"}">${item.status === "suspended" ? "Reanudar" : "Suspender"}</button>`;
      return `<article class="ticket-item ${urgencyClass}"><div class="ticket-item-head"><strong>${item.quantity} × ${escapeHtml(item.name)}</strong><span>${minutes}′ · ${statusLabel(item.status)}</span></div>${item.note ? `<p>Nota: ${escapeHtml(item.note)}</p>` : ""}<div class="ticket-actions">${actionButtons}${otherButtons}</div></article>`;
    }).join("");
    return `<section class="kitchen-ticket"><header class="ticket-head"><div><h2>${escapeHtml(table.name)}</h2><p>Abierta por ${escapeHtml(table.opened_by)}</p></div><span class="status open">${items.length} ${items.length === 1 ? "producto" : "productos"}</span></header><div class="ticket-items">${renderedItems}</div></section>`;
  }).join("");
  const readyCount = state.tables.reduce((sum, table) => sum + table.items.filter((item) => item.status === "ready").length, 0);
  appRoot.innerHTML = `${pageHeading("Producción", "Cocina", `${count} productos activos · los pedidos nuevos aparecen automáticamente.`)}<div class="section-title"><h2>En preparación</h2><span class="status ready">${readyCount} listos para retirar</span></div>${tickets.length ? `<div class="kitchen-grid">${cards}</div>` : `<section class="section-panel"><div class="empty-state"><div class="empty-mark">♨</div><h2>Cocina al día</h2><p>Los pedidos enviados por los mozos van a aparecer acá.</p></div></section>`}`;
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

function showProductDialog(dish = null) {
  const editing = Boolean(dish);
  const categories = [...new Set(state.menu.map((entry) => entry.category))];
  const categoryOptions = [...new Set([...categories, "Infusiones", "Para acompañar", "Bebidas"])].map((category) => `<option value="${escapeHtml(category)}" ${dish?.category === category ? "selected" : ""}>${escapeHtml(category)}</option>`).join("");
  const body = `<label class="dialog-field">Nombre del producto<input name="name" maxlength="80" value="${escapeHtml(dish?.name || "")}" required></label><label class="dialog-field">Categoría<select name="category" required>${categoryOptions}<option value="__custom">Otra categoría…</option></select></label><label class="dialog-field custom-category" hidden>Nueva categoría<input name="custom_category" maxlength="40"></label><label class="dialog-field">Descripción<textarea name="description" maxlength="120" placeholder="Detalle opcional">${escapeHtml(dish?.description || "")}</textarea></label><label class="dialog-field">Precio en pesos<input name="price" type="number" min="0" step="1" value="${escapeHtml(dish?.price ?? "")}" required></label>${editing ? `<label class="dialog-field">Disponibilidad<select name="available"><option value="true" ${dish.available ? "selected" : ""}>Disponible</option><option value="false" ${!dish.available ? "selected" : ""}>Pausado</option></select></label>` : ""}`;
  showDialog({ eyebrow: editing ? "Editar carta" : "Carta del bar", title: editing ? "Editar producto" : "Nuevo producto", body, submitLabel: editing ? "Guardar cambios" : "Agregar producto", onSubmit: (data) => {
    const category = data.category === "__custom" ? data.custom_category : data.category;
    const action = { type: editing ? "menu_update" : "menu_add", menu_id: dish?.id, name: data.name, category, description: data.description, price: data.price, available: data.available !== "false" };
    return sendAction(action, editing ? "Producto actualizado." : "Producto agregado.");
  } });
  dialogBody.querySelector('select[name="category"]')?.addEventListener("change", (event) => {
    dialogBody.querySelector(".custom-category").hidden = event.target.value !== "__custom";
    if (event.target.value === "__custom") dialogBody.querySelector('input[name="custom_category"]').required = true;
  });
}

function showAddItemDialog(table, dish) {
  const body = `<div class="dialog-product-line"><strong>${escapeHtml(dish.name)}</strong><span>${money(dish.price)}</span></div><label class="dialog-field">Cantidad<input name="quantity" type="number" min="1" max="99" value="1" required></label><label class="dialog-field">Nota para cocina<textarea name="note" maxlength="160" placeholder="Ej.: sin azúcar, bien tostado"></textarea></label>`;
  showDialog({ eyebrow: table.name, title: "Agregar al pedido", body, submitLabel: "Agregar", onSubmit: (data) => sendAction({ type: "item_add", table_id: table.id, menu_id: dish.id, quantity: data.quantity, note: data.note, waiter: waiterInput.value }, `${dish.name} agregado.`) });
}

function setView(view) {
  activeView = view;
  activeTableId = null;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.querySelector(".main-nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-view]");
  if (button) setView(button.dataset.view);
});

appRoot.addEventListener("click", async (event) => {
  const goButton = event.target.closest("[data-go]");
  if (goButton) { setView(goButton.dataset.go); return; }
  const categoryButton = event.target.closest("[data-category]");
  if (categoryButton) { activeCategory = categoryButton.dataset.category; render(); return; }
  const tableButton = event.target.closest("[data-table]");
  if (tableButton) {
    const table = state.tables.find((entry) => entry.id === tableButton.dataset.table);
    if (!table) return;
    if (table.status === "free") {
      const opened = await sendAction({ type: "table_open", table_id: table.id, waiter: waiterInput.value }, `${table.name} abierta.`);
      if (opened) { activeTableId = table.id; activeView = "table-detail"; render(); }
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
  if (actionButton.dataset.action === "item-status") {
    await sendAction({ type: "item_status", table_id: tableId, item_id: actionButton.dataset.itemId, status: actionButton.dataset.status });
  }
});

document.querySelector("#dialog").addEventListener("click", (event) => {
  if (event.target.closest("[data-close-dialog]")) dialog.close();
});

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

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
loadState(true);
setInterval(() => loadState(), 2200);