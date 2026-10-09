const renderApplication = render;
const renderOrderFlow = orderFlow;

orderFlow = function (table) {
  return renderOrderFlow({
    ...table,
    items: table.items.filter((item) => item.status !== "ready" || !item.retrieved_at),
  });
};

render = function () {
  renderApplication();
  renderPickupState();
};

function elapsedMinutes(timestamp) {
  const start = Date.parse(timestamp || "");
  return Number.isFinite(start) ? Math.max(0, Math.floor((Date.now() - start) / 60000)) : null;
}

function formatElapsed(minutes) {
  if (minutes === null) return "Tiempo no disponible";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} h ${remainder} min` : `${hours} h`;
}

function formatClock(startTimestamp, endTimestamp) {
  const start = Date.parse(startTimestamp || "");
  if (!Number.isFinite(start)) return "--:--";
  const end = endTimestamp ? Date.parse(endTimestamp) : Date.now();
  const totalSeconds = Math.max(0, Math.floor(((Number.isFinite(end) ? end : Date.now()) - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}

function createClock(startTimestamp, endTimestamp) {
  const clock = document.createElement("span");
  clock.className = "order-clock";
  clock.dataset.start = startTimestamp || "";
  clock.dataset.end = endTimestamp || "";
  clock.textContent = formatClock(startTimestamp, endTimestamp);
  clock.setAttribute("role", "timer");
  return clock;
}

function tickOrderClocks() {
  appRoot.querySelectorAll(".order-clock").forEach((clock) => {
    if (!clock.dataset.end) clock.textContent = formatClock(clock.dataset.start, null);
  });
}

function readyPickupTables() {
  return state.tables
    .filter((table) => table.status === "open")
    .map((table) => ({
      ...table,
      readyItems: table.items.filter((item) => item.status === "ready" && !item.retrieved_at),
    }))
    .filter((table) => table.readyItems.length);
}

function renderReadyNotices(readyTables) {
  readyNoticeElement.hidden = currentRole !== "mozo" || readyTables.length === 0;
  readyNoticeElement.replaceChildren();
  if (readyNoticeElement.hidden) return;

  const list = document.createElement("div");
  list.className = "ready-notice-list";
  readyTables.forEach((table) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "ready-notice-table";
    card.dataset.readyTableId = table.id;
    card.setAttribute("aria-label", `${table.name}: ir a retirar el pedido listo`);

    const heading = document.createElement("strong");
    heading.className = "ready-notice-table-name";
    heading.textContent = table.name;
    card.append(heading);

    const products = document.createElement("span");
    products.className = "ready-notice-items";
    products.textContent = table.readyItems
      .map((item) => `${item.quantity} × ${item.name}`)
      .join(" · ");
    card.append(products);

    const timings = document.createElement("span");
    timings.className = "ready-notice-timing";
    timings.textContent = table.readyItems
      .map((item) => `${item.name}: espera ${formatElapsed(elapsedMinutes(item.ready_at || item.sent_at))}`)
      .join(" · ");
    card.append(timings);

    const action = document.createElement("span");
    action.className = "ready-notice-action";
    action.textContent = "Ver mesa →";
    card.append(action);
    list.append(card);
  });
  readyNoticeElement.append(list);
}

function renderTableOrderStatus(table) {
  const tableSection = appRoot.querySelector(".table-section");
  tableSection?.querySelector("#tablePickupNotice")?.remove();
  if (!table || !tableSection) return;

  const tableReadyItems = table.items.filter((item) => item.status === "ready" && !item.retrieved_at);
  if (tableReadyItems.length) {
    const notice = document.createElement("div");
    notice.id = "tablePickupNotice";
    notice.className = "table-pickup-notice";
    notice.setAttribute("role", "status");

    const heading = document.createElement("strong");
    heading.textContent = `${tableReadyItems.length === 1 ? "Un pedido listo" : `${tableReadyItems.length} pedidos listos`} para retirar`;
    notice.append(heading);

    const products = document.createElement("span");
    products.textContent = tableReadyItems.map((item) => `${item.quantity} × ${item.name}`).join(" · ");
    notice.append(products);

    const actions = document.createElement("div");
    actions.className = "table-pickup-actions";
    tableReadyItems.forEach((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button button-primary button-small";
      button.dataset.action = "item-mark-retrieved";
      button.dataset.tableId = table.id;
      button.dataset.itemId = item.id;
      button.textContent = "Retirado";
      actions.append(button);
    });
    notice.append(actions);
    tableSection.insertBefore(notice, tableSection.querySelector(".order-list"));
  }

  table.items.forEach((item) => {
    const row = [...tableSection.querySelectorAll(".order-row")]
      .find((entry) => [...entry.querySelectorAll("[data-item-id]")].some((button) => button.dataset.itemId === item.id));
    if (!row) return;

    const status = row.querySelector(".status");
    if (status && item.status === "ready") {
      if (item.retrieved_at) {
        const time = new Intl.DateTimeFormat("es-AR", { hour: "2-digit", minute: "2-digit" }).format(new Date(item.retrieved_at));
        status.textContent = `Retirado${item.retrieved_by ? ` por ${item.retrieved_by}` : ""} · ${time}`;
      } else {
        status.textContent = "Listo para retirar";
      }
    }

    row.querySelector(".order-elapsed")?.remove();
    if (!["sent", "preparing", "suspended", "ready"].includes(item.status) || item.status === "ready" && item.retrieved_at) return;

    const elapsed = document.createElement("div");
    elapsed.className = "order-elapsed";
    if (item.status === "ready") {
      elapsed.append(
        "Tiempo total ",
        createClock(item.sent_at, item.ready_at || null),
        " · esperando retiro ",
        createClock(item.ready_at || item.sent_at, null),
      );
    } else {
      const labels = { sent: "En cocina", preparing: "En preparación", suspended: "Demorado" };
      elapsed.append(`${labels[item.status]} · `, createClock(item.sent_at, null));
    }
    row.querySelector(".order-meta")?.after(elapsed);
  });
}

function renderPickupState() {
  if (!state || !currentRole) return;

  const readyTables = readyPickupTables();
  const readyCount = readyTables.reduce((sum, table) => sum + table.readyItems.length, 0);
  const homeReadyCount = appRoot.querySelector(".stats .stat:nth-child(4) .stat-value");
  if (homeReadyCount) homeReadyCount.textContent = String(readyCount);
  renderReadyNotices(readyTables);

  const table = activeView === "table-detail" ? state.tables.find((entry) => entry.id === activeTableId) : null;
  renderTableOrderStatus(table);
}

readyNoticeElement.addEventListener("click", (event) => {
  const card = event.target.closest("[data-ready-table-id]");
  const tableId = card?.dataset.readyTableId;
  if (!tableId || !state?.tables.some((table) => table.id === tableId)) return;
  activeTableId = tableId;
  activeView = "table-detail";
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

appRoot.addEventListener("click", async (event) => {
  const button = event.target.closest('[data-action="item-mark-retrieved"]');
  if (!button) return;
  await sendAction({
    type: "item_mark_retrieved",
    table_id: button.dataset.tableId,
    item_id: button.dataset.itemId,
    waiter: waiterInput.value.trim() || "Equipo",
  }, "Pedido marcado como retirado.");
});

setInterval(() => {
  if (state && currentRole) renderPickupState();
}, 15000);

setInterval(tickOrderClocks, 1000);
