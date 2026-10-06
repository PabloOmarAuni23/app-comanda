import json
import os
import re
import sqlite3
import uuid
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, render_template, request


app = Flask(__name__)
DATABASE_PATH = Path(os.environ.get("DATABASE_PATH", "instance/comanda.sqlite3"))


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def normalize_menu_name(value):
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def default_classic_combo():
    return {
        "id": "menu-clasico",
        "name": "Clásico",
        "description": "Elegí una infusión y combiná los acompañamientos",
        "category": "Combos",
        "price": 4500,
        "available": True,
        "modifier_groups": [
            {
                "name": "Infusión",
                "selection": "single",
                "required": True,
                "options": [
                    {"name": "Mate", "price": 0},
                    {"name": "Mate cocido", "price": 0},
                    {"name": "Café", "price": 0},
                    {"name": "Café con leche", "price": 0},
                    {"name": "Leche cortada", "price": 0},
                    {"name": "Té", "price": 0},
                ],
            },
            {
                "name": "Acompañamientos",
                "selection": "quantity",
                "required": True,
                "show_when": {"group": "Infusión"},
                "options": [
                    {"name": "Tortilla fina", "price": 0},
                    {"name": "Tortilla gruesa", "price": 0},
                    {"name": "Bollito", "price": 0},
                    {"name": "Factura", "price": 0},
                ],
            },
            {
                "name": "Agregados",
                "selection": "quantity",
                "required": False,
                "options": [
                    {"name": "Manteca", "price": 300},
                    {"name": "Queso", "price": 500},
                    {"name": "Mermelada", "price": 300},
                ],
            },
        ],
    }


def make_classic_combo_conditional(state):
    for dish in state.get("menu", []):
        if str(dish.get("id", "")) != "menu-clasico" and str(dish.get("name", "")).strip().casefold() not in {"clásico", "clasico"}:
            continue
        groups = dish.get("modifier_groups")
        if not isinstance(groups, list):
            continue
        infusion = next((group for group in groups if str(group.get("name", "")).strip().casefold() == "infusión"), None)
        accompaniment = next((group for group in groups if str(group.get("name", "")).strip().casefold() == "acompañamientos"), None)
        if infusion is not None and accompaniment is not None and not accompaniment.get("show_when"):
            accompaniment["show_when"] = {"group": infusion["name"]}


def normalize_show_when(groups, group, condition):
    if condition is None or condition == "" or condition == {}:
        return None
    if not isinstance(condition, dict):
        raise ValueError("Revisá la condición de visibilidad de los grupos.")
    dependency_name = str(condition.get("group", "")).strip()
    dependency = next((entry for entry in groups if entry["name"].casefold() == dependency_name.casefold()), None)
    if dependency is None or dependency["name"] == group["name"]:
        raise ValueError("La condición de un grupo debe apuntar a otro grupo del mismo producto.")
    normalized = {"group": dependency["name"]}
    raw_options = condition.get("options")
    if raw_options is not None and raw_options != "" and raw_options != []:
        if not isinstance(raw_options, list) or len(raw_options) > 30:
            raise ValueError("Revisá las opciones de la condición de un grupo.")
        known_options = {option["name"].casefold(): option["name"] for option in dependency["options"]}
        options = []
        for option_name in raw_options:
            canonical = known_options.get(str(option_name).strip().casefold())
            if canonical is None or canonical in options:
                raise ValueError("La condición de un grupo referencia opciones que no existen.")
            options.append(canonical)
        normalized["options"] = options
    return normalized


def normalize_modifier_groups(value):
    if not isinstance(value, list) or len(value) > 10:
        raise ValueError("Configurá hasta 10 grupos de opciones.")

    groups = []
    group_names = set()
    pending_conditions = []
    for group in value:
        if not isinstance(group, dict):
            raise ValueError("Revisá los grupos de opciones.")
        name = str(group.get("name", "")).strip()[:60]
        selection = str(group.get("selection", "quantity"))
        options = group.get("options", [])
        if not name or name.casefold() in group_names or selection not in {"single", "quantity"}:
            raise ValueError("Cada grupo necesita un nombre único y un tipo válido.")
        if not isinstance(options, list) or not 1 <= len(options) <= 30:
            raise ValueError(f"El grupo {name} necesita entre 1 y 30 opciones.")

        option_names = set()
        normalized_options = []
        for option in options:
            if not isinstance(option, dict):
                raise ValueError(f"Revisá las opciones del grupo {name}.")
            option_name = str(option.get("name", "")).strip()[:60]
            try:
                price = int(option.get("price", 0))
            except (TypeError, ValueError, OverflowError) as error:
                raise ValueError(f"El recargo de {option_name or name} no es válido.") from error
            if not option_name or option_name.casefold() in option_names or price < 0:
                raise ValueError(f"Cada opción de {name} necesita un nombre único y un recargo válido.")
            option_names.add(option_name.casefold())
            normalized_options.append({"name": option_name, "price": price})

        group_names.add(name.casefold())
        groups.append({
            "name": name,
            "selection": selection,
            "required": group.get("required") is True,
            "options": normalized_options,
        })
        pending_conditions.append(group.get("show_when"))

    for group, condition in zip(groups, pending_conditions):
        normalized_condition = normalize_show_when(groups, group, condition)
        if normalized_condition is not None:
            group["show_when"] = normalized_condition

    for group in groups:
        seen = {group["name"]}
        current = group
        while current.get("show_when"):
            current = next(entry for entry in groups if entry["name"] == current["show_when"]["group"])
            if current["name"] in seen:
                raise ValueError("Las condiciones de los grupos no pueden depender entre sí en ciclo.")
            seen.add(current["name"])
    return groups


def modifier_visibility(groups, selected_by_group):
    visible = {group["name"]: not group.get("show_when") for group in groups}
    changed = True
    while changed:
        changed = False
        for group in groups:
            name = group["name"]
            if visible.get(name):
                continue
            condition = group["show_when"]
            dependency = condition["group"]
            if not visible.get(dependency):
                continue
            chosen = {entry["name"] for entry in selected_by_group.get(dependency, [])}
            wanted = condition.get("options")
            if chosen and (not wanted or chosen.intersection(wanted)):
                visible[name] = True
                changed = True
    return visible


def select_modifiers(dish, value):
    groups = dish.get("modifier_groups", [])
    if not isinstance(value, list):
        raise ValueError("No se pudieron validar las opciones del producto.")

    selected_by_group = {}
    selected_options = set()
    for selection in value:
        if not isinstance(selection, dict):
            raise ValueError("No se pudieron validar las opciones del producto.")
        group_name = str(selection.get("group", ""))
        option_name = str(selection.get("option", ""))
        group = next((entry for entry in groups if entry["name"] == group_name), None)
        option = next((entry for entry in group["options"] if entry["name"] == option_name), None) if group else None
        if option is None:
            raise ValueError("Una de las opciones seleccionadas ya no está disponible.")
        selection_key = (group_name, option_name)
        if selection_key in selected_options:
            raise ValueError("Una opción no se puede repetir; indicá su cantidad.")
        selected_options.add(selection_key)
        try:
            quantity = int(selection.get("quantity", 1))
        except (TypeError, ValueError, OverflowError) as error:
            raise ValueError("La cantidad de una opción no es válida.") from error
        if quantity < 1 or quantity > 99 or (group["selection"] == "single" and quantity != 1):
            raise ValueError("Revisá las cantidades de las opciones.")
        selected_by_group.setdefault(group_name, []).append({
            "group": group_name,
            "name": option_name,
            "quantity": quantity,
            "unit_price": option["price"],
        })

    visibility = modifier_visibility(groups, selected_by_group)
    for group in groups:
        if not visibility.get(group["name"]) and selected_by_group.get(group["name"]):
            raise ValueError(f"{group['name']} no corresponde en esta combinación.")

    for group in groups:
        if not visibility.get(group["name"]):
            continue
        selected = selected_by_group.get(group["name"], [])
        if group["selection"] == "single" and (len(selected) > 1 or (group["required"] and len(selected) != 1)):
            raise ValueError(f"Elegí una opción para {group['name']}.")
        if group["selection"] == "quantity" and group["required"] and not selected:
            raise ValueError(f"Elegí al menos una opción para {group['name']}.")

    return [entry for group in groups for entry in selected_by_group.get(group["name"], [])]


def merge_menu_entries(existing_menu, incoming_menu):
    merged = [dict(item) for item in existing_menu]
    index_by_name = {normalize_menu_name(item.get("name", "")): idx for idx, item in enumerate(merged)}

    for item in incoming_menu or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "")).strip()
        category = str(item.get("category", "")).strip()
        price = int(item.get("price", 0) or 0)
        if not name or not category or price < 0:
            continue

        key = normalize_menu_name(name)
        if key in index_by_name:
            current = merged[index_by_name[key]]
            current.update({
                "name": name,
                "category": category,
                "description": str(item.get("description", current.get("description", "")))[:120],
                "price": price,
                "available": bool(item.get("available", current.get("available", True))),
            })
            continue

        merged.append({
            "id": str(item.get("id") or uuid.uuid4()),
            "name": name,
            "description": str(item.get("description", ""))[:120],
            "category": category,
            "price": price,
            "available": bool(item.get("available", True)),
            "modifier_groups": [],
        })
        index_by_name[key] = len(merged) - 1

    return merged


def initial_state():
    return {
        "_migrations": ["classic-combo-v1", "classic-combo-v2"],
        "tables": [
            {"id": str(number), "name": f"Mesa {number}", "status": "free", "opened_by": "", "opened_at": None, "guests": None, "items": []}
            for number in range(1, 9)
        ],
        "pending_sales": [],
        "sales_closures": [],
        "menu": [
            {"id": "menu-te", "name": "Té", "description": "Consultar variedades", "category": "Infusiones", "price": 2000, "available": True},
            {"id": "menu-cafe", "name": "Café", "description": "Café en jarrito", "category": "Infusiones", "price": 1800, "available": True},
            {"id": "menu-jamon", "name": "Jamón y queso", "description": "Tostado en pan árabe o miga", "category": "Para acompañar", "price": 4500, "available": True},
            {"id": "menu-ternera", "name": "Ternera y queso", "description": "Tostado en pan árabe", "category": "Para acompañar", "price": 6000, "available": True},
            {"id": "menu-factura", "name": "Factura / medialuna", "description": "Factura o medialuna", "category": "Para acompañar", "price": 700, "available": True},
            {"id": "menu-licuado", "name": "Licuados", "description": "Fruta de estación", "category": "Bebidas", "price": 3000, "available": True},
            default_classic_combo(),
        ],
    }


def connect_db():
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH, timeout=15)
    connection.row_factory = sqlite3.Row
    return connection


def initialize_db():
    with closing(connect_db()) as connection, connection:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK (id = 1), document TEXT NOT NULL, updated_at TEXT NOT NULL)"
        )
        row = connection.execute("SELECT id FROM app_state WHERE id = 1").fetchone()
        if row is None:
            connection.execute(
                "INSERT INTO app_state (id, document, updated_at) VALUES (1, ?, ?)",
                (json.dumps(initial_state(), ensure_ascii=False), now_iso()),
            )


def ensure_existing_state(connection):
    row = connection.execute("SELECT document, updated_at FROM app_state WHERE id = 1").fetchone()
    if row is not None:
        state = json.loads(row["document"])
        migrations = state.get("_migrations", [])
        if not isinstance(migrations, list):
            migrations = []
        updated = False
        if "classic-combo-v1" not in migrations:
            if not any(str(dish.get("name", "")).strip().casefold() in {"clásico", "clasico"} for dish in state["menu"]):
                state["menu"].append(default_classic_combo())
            migrations.append("classic-combo-v1")
            updated = True
        if "classic-combo-v2" not in migrations:
            make_classic_combo_conditional(state)
            migrations.append("classic-combo-v2")
            updated = True
        state["_migrations"] = migrations
        if updated:
            stamp = now_iso()
            connection.execute(
                "UPDATE app_state SET document = ?, updated_at = ? WHERE id = 1",
                (json.dumps(state, ensure_ascii=False), stamp),
            )
            return state, stamp
        return state, row["updated_at"]
    initial_document = json.dumps(initial_state(), ensure_ascii=False)
    stamp = now_iso()
    connection.execute(
        "INSERT INTO app_state (id, document, updated_at) VALUES (1, ?, ?)",
        (initial_document, stamp),
    )
    return json.loads(initial_document), stamp


def read_state():
    with closing(connect_db()) as connection, connection:
        state, updated_at = ensure_existing_state(connection)
    state.setdefault("pending_sales", [])
    state.setdefault("sales_closures", [])
    return state, updated_at


def mutate_state(action):
    with closing(connect_db()) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        state, _ = ensure_existing_state(connection)
        state.setdefault("pending_sales", [])
        state.setdefault("sales_closures", [])
        tables = state["tables"]
        menu = state["menu"]
        action_type = action.get("type")
        stamp = now_iso()

        def find_table():
            table = next((entry for entry in tables if entry["id"] == str(action.get("table_id", ""))), None)
            if table is None:
                raise ValueError("No encontramos esa mesa.")
            return table

        if action_type == "table_create":
            name = str(action.get("name", "")).strip()[:40]
            if not name:
                raise ValueError("Escribí el nombre de la mesa.")
            if any(entry["name"].casefold() == name.casefold() for entry in tables):
                raise ValueError("Ya existe una mesa con ese nombre.")
            tables.append({"id": str(uuid.uuid4()), "name": name, "status": "free", "opened_by": "", "opened_at": None, "guests": None, "items": []})
        elif action_type == "table_open":
            table = find_table()
            if table["status"] != "free":
                raise ValueError("Esta mesa ya está ocupada.")
            try:
                guests = int(action.get("guests", 1))
            except (TypeError, ValueError, OverflowError):
                guests = 1
            guests = max(1, min(guests, 30))
            table.update(status="open", opened_by=str(action.get("waiter", "Equipo")).strip()[:40] or "Equipo", opened_at=stamp, guests=guests, items=[])
        elif action_type == "item_add":
            table = find_table()
            if table["status"] != "open":
                raise ValueError("La mesa no está abierta.")
            dish = next((entry for entry in menu if entry["id"] == str(action.get("menu_id", "")) and entry["available"]), None)
            if dish is None:
                raise ValueError("Ese producto ya no está disponible.")
            quantity = max(1, min(int(action.get("quantity", 1)), 99))
            modifiers = select_modifiers(dish, action.get("modifiers", []))
            unit_price = dish["price"] + sum(entry["unit_price"] * entry["quantity"] for entry in modifiers)
            table["items"].append({
                "id": str(uuid.uuid4()), "menu_id": dish["id"], "name": dish["name"], "price": unit_price,
                "modifiers": modifiers,
                "quantity": quantity, "note": str(action.get("note", "")).strip()[:160], "status": "draft", "added_by": str(action.get("waiter", "Equipo")).strip()[:40] or "Equipo",
                "priority": action.get("priority") is True, "created_at": stamp, "sent_at": None,
            })
        elif action_type == "order_send":
            table = find_table()
            pending = [item for item in table["items"] if item["status"] == "draft"]
            if not pending:
                raise ValueError("No hay productos nuevos para enviar.")
            for item in pending:
                item.update(status="sent", sent_at=stamp)
        elif action_type == "item_status":
            table = find_table()
            item = next((entry for entry in table["items"] if entry["id"] == str(action.get("item_id", ""))), None)
            current_status = str(item["status"]) if item is not None else ""
            status = str(action.get("status", ""))
            allowed_status = {
                "sent": {"preparing", "ready", "suspended"},
                "preparing": {"ready", "suspended"},
                "suspended": {"preparing", "ready"},
                "ready": {"ready"},
            }
            if item is None or status not in {"preparing", "ready", "suspended"} or status not in allowed_status.get(current_status, set()):
                raise ValueError("No se pudo actualizar el producto.")
            item["status"] = status
        elif action_type == "item_priority":
            table = find_table()
            item = next((entry for entry in table["items"] if entry["id"] == str(action.get("item_id", ""))), None)
            if item is None or item["status"] not in {"sent", "preparing", "suspended"}:
                raise ValueError("No se pudo actualizar la prioridad del producto.")
            item["priority"] = action.get("priority") is True
        elif action_type == "table_paid":
            table = find_table()
            if table["status"] != "open":
                raise ValueError("La mesa no se puede cobrar en este estado.")
            if not table["items"] or any(item["status"] != "ready" for item in table["items"]):
                raise ValueError("Esperá a que todos los productos estén listos antes de cobrar.")
            for item in table["items"]:
                name = str(item.get("name", "")).strip()
                quantity = int(item.get("quantity", 0) or 0)
                if not name or quantity <= 0:
                    continue
                sale = next((entry for entry in state["pending_sales"] if normalize_menu_name(entry["name"]) == normalize_menu_name(name)), None)
                if sale is None:
                    state["pending_sales"].append({"name": name, "quantity": quantity})
                else:
                    sale["quantity"] += quantity
            table.update(status="cleaning", paid_at=stamp)
        elif action_type == "sales_close":
            shift = str(action.get("shift", ""))
            if shift not in {"morning", "afternoon"}:
                raise ValueError("Elegí un turno válido.")
            if not state["pending_sales"]:
                raise ValueError("No hay unidades vendidas pendientes para cerrar.")
            closure = {
                "id": str(uuid.uuid4()),
                "shift": shift,
                "closed_at": stamp,
                "items": [dict(item) for item in state["pending_sales"]],
                "total_units": sum(int(item["quantity"]) for item in state["pending_sales"]),
            }
            state["sales_closures"].append(closure)
            state["pending_sales"] = []
        elif action_type == "table_clean":
            table = find_table()
            if table["status"] != "cleaning":
                raise ValueError("La mesa todavía no está lista para limpiar.")
            table.update(status="free", opened_by="", opened_at=None, paid_at=None, guests=None, items=[])
        elif action_type == "menu_add":
            name = str(action.get("name", "")).strip()[:80]
            category = str(action.get("category", "")).strip()[:40]
            description = str(action.get("description", "")).strip()[:120]
            price = int(action.get("price", 0))
            if not name or not category or price < 0:
                raise ValueError("Completá nombre, categoría y un precio válido.")
            modifier_groups = normalize_modifier_groups(action.get("modifier_groups", []))
            menu.append({"id": str(uuid.uuid4()), "name": name, "description": description, "category": category, "price": price, "available": True, "modifier_groups": modifier_groups})
        elif action_type == "menu_update":
            dish = next((entry for entry in menu if entry["id"] == str(action.get("menu_id", ""))), None)
            if dish is None:
                raise ValueError("No encontramos ese producto.")
            name = str(action.get("name", "")).strip()[:80]
            category = str(action.get("category", "")).strip()[:40]
            description = str(action.get("description", "")).strip()[:120]
            price = int(action.get("price", -1))
            if not name or not category or price < 0:
                raise ValueError("Completá nombre, categoría y un precio válido.")
            modifier_groups = normalize_modifier_groups(action["modifier_groups"]) if "modifier_groups" in action else dish.get("modifier_groups", [])
            dish.update(name=name, category=category, description=description, price=price, available=bool(action.get("available", True)), modifier_groups=modifier_groups)
        elif action_type == "menu_delete":
            menu[:] = [entry for entry in menu if entry["id"] != str(action.get("menu_id", ""))]
        elif action_type == "menu_import":
            incoming_menu = action.get("items", [])
            if not isinstance(incoming_menu, list):
                raise ValueError("La importación de la carta debe venir como una lista de productos.")
            menu[:] = merge_menu_entries(menu, incoming_menu)
        else:
            raise ValueError("Acción no reconocida.")

        connection.execute(
            "UPDATE app_state SET document = ?, updated_at = ? WHERE id = 1",
            (json.dumps(state, ensure_ascii=False), stamp),
        )
        connection.commit()
    return state, stamp


@app.get("/")
def home():
    return render_template("index.html")


@app.get("/manifest.json")
def manifest():
    return app.send_static_file("manifest.json")


@app.get("/sw.js")
def service_worker():
    response = app.send_static_file("sw.js")
    response.headers["Service-Worker-Allowed"] = "/"
    response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/api/state")
def api_state():
    state, updated_at = read_state()
    return jsonify({**state, "updated_at": updated_at})


@app.post("/api/action")
def api_action():
    action = request.get_json(silent=True) or {}
    try:
        state, updated_at = mutate_state(action)
    except (ValueError, TypeError, OverflowError) as error:
        return jsonify({"error": str(error)}), 400
    return jsonify({**state, "updated_at": updated_at})


initialize_db()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8000")), threaded=True)
