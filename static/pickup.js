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

function renderPickupState() {
  if (!state || !currentRole) return;

  const readyCount = state.tables.flatMap((table) => table.items)
    .filter((item) => item.status === "ready" && !item.retrieved_at).length;
  const homeReadyCount = appRoot.querySelector(".stats .stat:nth-child(4) .stat-value");
  if (homeReadyCount) homeReadyCount.textContent = String(readyCount);

  const readyTables = state.tables
    .filter((table) => table.status === "open")
    .map((table) => ({ ...table, readyItems: table.items.filter((item) => item.status === "ready" && !item.retrieved_at) }))
    .filter((table) => table.readyItems.length);
  const readyItems = readyTables.flatMap((table) => table.readyItems.map((item) => ({ table, item })));

  readyNoticeElement.hidden = currentRole !== "mozo" || readyItems.length === 0;
  if (readyItems.length) {
    const preview = readyItems.slice(0, 3)
      .map(({ table, item }) => `${escapeHtml(table.name)} · ${item.quantity} × ${escapeHtml(item.name)}`)
      .join(" &nbsp; | &nbsp; ");
    const remaining = readyItems.length - Math.min(readyItems.length, 3);
    const summary = `${readyTables.length} ${readyTables.length === 1 ? "mesa" : "mesas"} · ${readyItems.length} ${readyItems.length === 1 ? "producto listo" : "productos listos"} para retirar`;
    readyNoticeElement.dataset.tableId = readyTables[0].id;
    readyNoticeElement.setAttribute("aria-label", `${summary}. Ir a ${readyTables[0].name} para retirar el pedido.`);
    readyNoticeElement.innerHTML = `<span class="ready-notice-icon" aria-hidden="true">!</span><span class="ready-notice-copy"><strong>¡Hay pedidos listos para retirar!</strong><span>${summary}</span><span class="ready-notice-items">${preview}${remaining ? ` &nbsp; | &nbsp; y ${remaining} más` : ""}</span></span><span class="ready-notice-action">Ir a buscar →</span>`;
  } else {
    readyNoticeElement.innerHTML = "";
    delete readyNoticeElement.dataset.tableId;
  }

  const table = activeView === "table-detail" ? state.tables.find((entry) => entry.id === activeTableId) : null;
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
    heading.textContent = `¡Hay ${tableReadyItems.length === 1 ? "un pedido listo" : `${tableReadyItems.length} pedidos listos`} para retirar!`;
    notice.append(heading);

    const summary = document.createElement("span");
    summary.textContent = tableReadyItems.map((item) => `${item.quantity} × ${item.name}`).join(" · ");
    notice.append(summary);

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

  table.items.filter((item) => item.status === "ready" && item.retrieved_at).forEach((item) => {
    const row = [...tableSection.querySelectorAll(".order-row")]
      .find((entry) => [...entry.querySelectorAll("[data-item-id]")].some((button) => button.dataset.itemId === item.id));
    const status = row?.querySelector(".status");
    if (!status) return;
    const time = new Intl.DateTimeFormat("es-AR", { hour: "2-digit", minute: "2-digit" }).format(new Date(item.retrieved_at));
    status.textContent = `Retirado${item.retrieved_by ? ` por ${item.retrieved_by}` : ""} · ${time}`;
  });
}

readyNoticeElement.addEventListener("click", () => {
  const tableId = readyNoticeElement.dataset.tableId;
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
