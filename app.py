import json
import os
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


def initial_state():
    return {
        "tables": [
            {"id": str(number), "name": f"Mesa {number}", "status": "free", "opened_by": "", "opened_at": None, "items": []}
            for number in range(1, 9)
        ],
        "menu": [
            {"id": "menu-te", "name": "Té", "description": "Consultar variedades", "category": "Infusiones", "price": 2000, "available": True},
            {"id": "menu-cafe", "name": "Café", "description": "Café en jarrito", "category": "Infusiones", "price": 1800, "available": True},
            {"id": "menu-jamon", "name": "Jamón y queso", "description": "Tostado en pan árabe o miga", "category": "Para acompañar", "price": 4500, "available": True},
            {"id": "menu-ternera", "name": "Ternera y queso", "description": "Tostado en pan árabe", "category": "Para acompañar", "price": 6000, "available": True},
            {"id": "menu-factura", "name": "Factura / medialuna", "description": "Factura o medialuna", "category": "Para acompañar", "price": 700, "available": True},
            {"id": "menu-licuado", "name": "Licuados", "description": "Fruta de estación", "category": "Bebidas", "price": 3000, "available": True},
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
        connection.execute(
            "INSERT OR IGNORE INTO app_state (id, document, updated_at) VALUES (1, ?, ?)",
            (json.dumps(initial_state(), ensure_ascii=False), now_iso()),
        )


def read_state():
    with closing(connect_db()) as connection, connection:
        row = connection.execute("SELECT document, updated_at FROM app_state WHERE id = 1").fetchone()
    return json.loads(row["document"]), row["updated_at"]


def mutate_state(action):
    with closing(connect_db()) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("SELECT document FROM app_state WHERE id = 1").fetchone()
        state = json.loads(row["document"])
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
            tables.append({"id": str(uuid.uuid4()), "name": name, "status": "free", "opened_by": "", "opened_at": None, "items": []})
        elif action_type == "table_open":
            table = find_table()
            if table["status"] != "free":
                raise ValueError("Esta mesa ya está ocupada.")
            table.update(status="open", opened_by=str(action.get("waiter", "Equipo")).strip()[:40] or "Equipo", opened_at=stamp, items=[])
        elif action_type == "item_add":
            table = find_table()
            if table["status"] != "open":
                raise ValueError("La mesa no está abierta.")
            dish = next((entry for entry in menu if entry["id"] == str(action.get("menu_id", "")) and entry["available"]), None)
            if dish is None:
                raise ValueError("Ese producto ya no está disponible.")
            quantity = max(1, min(int(action.get("quantity", 1)), 99))
            table["items"].append({
                "id": str(uuid.uuid4()), "menu_id": dish["id"], "name": dish["name"], "price": dish["price"],
                "quantity": quantity, "note": str(action.get("note", "")).strip()[:160], "status": "draft", "added_by": str(action.get("waiter", "Equipo")).strip()[:40] or "Equipo",
                "created_at": stamp, "sent_at": None,
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
            status = str(action.get("status", ""))
            if item is None or status not in {"preparing", "ready", "suspended"}:
                raise ValueError("No se pudo actualizar el producto.")
            item["status"] = status
        elif action_type == "table_paid":
            table = find_table()
            if table["status"] != "open":
                raise ValueError("La mesa no se puede cobrar en este estado.")
            if not table["items"] or any(item["status"] != "ready" for item in table["items"]):
                raise ValueError("Esperá a que todos los productos estén listos antes de cobrar.")
            table.update(status="cleaning", paid_at=stamp)
        elif action_type == "table_clean":
            table = find_table()
            if table["status"] != "cleaning":
                raise ValueError("La mesa todavía no está lista para limpiar.")
            table.update(status="free", opened_by="", opened_at=None, paid_at=None, items=[])
        elif action_type == "menu_add":
            name = str(action.get("name", "")).strip()[:80]
            category = str(action.get("category", "")).strip()[:40]
            description = str(action.get("description", "")).strip()[:120]
            price = int(action.get("price", 0))
            if not name or not category or price < 0:
                raise ValueError("Completá nombre, categoría y un precio válido.")
            menu.append({"id": str(uuid.uuid4()), "name": name, "description": description, "category": category, "price": price, "available": True})
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
            dish.update(name=name, category=category, description=description, price=price, available=bool(action.get("available", True)))
        elif action_type == "menu_delete":
            menu[:] = [entry for entry in menu if entry["id"] != str(action.get("menu_id", ""))]
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