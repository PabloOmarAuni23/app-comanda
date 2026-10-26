import json
import os
import re
import sqlite3
import unicodedata
import uuid
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, render_template, request

from carta import CARTA_SECTIONS, INFUSION_EXTRA_PRODUCTS, INFUSION_OPTIONS
from storage import PostgresConnection


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
                "included_quantity": 2,
                "options": [
                    {"name": "Tortilla fina", "price": 400},
                    {"name": "Tortilla gruesa", "price": 400},
                    {"name": "Bollito", "price": 400},
                    {"name": "Factura", "price": 700},
                    {"name": "Medialuna", "price": 700},
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


def default_modifier_catalog():
    groups = default_classic_combo()["modifier_groups"]
    groups[1].pop("show_when", None)
    groups[1]["options"].append({"name": "Factura con crema", "price": 700})
    groups.append({"name": "Incluido", "selection": "single", "required": False, "options": [
        {"name": "Soda", "price": 0}, {"name": "Agua", "price": 0},
    ]})
    return groups


def menu_slug(value):
    ascii_text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")


def build_site_menu(previous_menu=()):
    previous_ids = {menu_slug(dish.get("name", "")): str(dish["id"]) for dish in previous_menu if dish.get("id")}
    menu = []
    used_ids = set()
    for category, with_infusion, available, products in CARTA_SECTIONS:
        for name, description, price in products:
            key = menu_slug(name)
            dish_id = "menu-clasico" if key == "clasico" else previous_ids.get(key) or f"menu-{key}"
            if dish_id in used_ids:
                dish_id = f"{dish_id}-{len(menu)}"
            used_ids.add(dish_id)
            if key in {"cortado", "leche-cortada"}:
                groups = coffee_modifier_groups()
            elif key == "promo-de-licuado":
                groups = smoothie_promo_groups()
            elif key == "clasico":
                groups = default_classic_combo()["modifier_groups"]
            elif with_infusion or name in INFUSION_EXTRA_PRODUCTS:
                groups = [{"name": "Infusión", "selection": "single", "required": True, "options": [{"name": option, "price": 0} for option in INFUSION_OPTIONS]}]
            else:
                groups = []
            menu.append({
                "id": dish_id, "name": name, "description": description, "category": category,
                "price": price, "available": available, "modifier_groups": groups,
            })
    return menu


def smoothie_promo_groups():
    flavors = ["Licuado de banana", "Licuado de frutilla", "Licuado de maracuyá", "Licuado de arándanos", "Licuado de durazno"]
    return [
        {"name": label, "selection": "single", "required": True, "options": [{"name": flavor, "price": 0} for flavor in flavors]}
        for label in ["Primer licuado", "Segundo licuado"]
    ] + [{"name": "Tostado", "selection": "single", "required": True, "options": [
        {"name": "Tostado de miga", "price": 0}, {"name": "Tostado árabe", "price": 0}
    ]}]


def add_smoothie_promo(state):
    if not any(menu_slug(dish.get("name", "")) == "promo-de-licuado" for dish in state["menu"]):
        state["menu"].append(next(dish for dish in build_site_menu() if dish["id"] == "menu-promo-de-licuado"))


def coffee_modifier_groups():
    return [
        {"name": "Tamaño", "selection": "single", "required": True, "options": [
            {"name": "Jarrita", "price": 200},
            {"name": "Pocillo", "price": 0},
        ]},
        {"name": "Acompañamientos", "selection": "quantity", "required": False, "options": [
            {"name": "Tortilla fina", "price": 400},
            {"name": "Tortilla gruesa", "price": 400},
            {"name": "Bollito", "price": 400},
            {"name": "Medialuna", "price": 700},
            {"name": "Factura", "price": 700},
        ]},
        {"name": "Agregados", "selection": "quantity", "required": False, "options": [
            {"name": "Manteca", "price": 300},
            {"name": "Queso", "price": 500},
            {"name": "Mermelada", "price": 300},
        ]},
    ]


def configure_coffee_sizes(state):
    for dish in state.get("menu", []):
        if menu_slug(dish.get("name", "")) not in {"cortado", "cafe-lagrima", "leche-cortada"}:
            continue
        if menu_slug(dish["name"]) == "cafe-lagrima":
            dish["name"] = "Leche cortada"
        dish["price"] = 1300
        updated_groups = coffee_modifier_groups()
        known_names = {group["name"] for group in updated_groups}
        dish["modifier_groups"] = updated_groups + [group for group in dish.get("modifier_groups", []) if group["name"] not in known_names]


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


def merge_hot_drinks(state):
    """Unify categories without replacing edited products or their identifiers."""
    cappuccino_names = {"capuchino", "capuccino", "cappuccino", "capucchino"}
    found_cappuccino = False
    for dish in state.get("menu", []):
        is_cappuccino = menu_slug(dish.get("name", "")) in cappuccino_names
        if str(dish.get("category", "")).strip().casefold() in {"cafetería", "cafeteria"} or is_cappuccino:
            dish["category"] = "Bebidas calientes"
        found_cappuccino = found_cappuccino or is_cappuccino
    if not found_cappuccino:
        cappuccino = next(dish for dish in build_site_menu() if dish["name"] == "Capuchino")
        used_ids = {dish.get("id") for dish in state.get("menu", [])}
        if cappuccino["id"] in used_ids:
            cappuccino["id"] = f"menu-capuchino-{uuid.uuid4().hex[:8]}"
        state.setdefault("menu", []).append(cappuccino)


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


def configure_classic_extras(state):
    for dish in state.get("menu", []):
        if dish.get("id") != "menu-clasico" and menu_slug(dish.get("name", "")) != "clasico":
            continue
        for group in dish.get("modifier_groups", []):
            if menu_slug(group.get("name", "")) != "acompanamientos":
                continue
            group["included_quantity"] = 2
            for option in group.get("options", []):
                name = menu_slug(option.get("name", ""))
                if name in {"tortilla-fina", "tortilla-gruesa", "bollito"}:
                    option["price"] = 400
                elif name in {"factura", "medialuna"}:
                    option["price"] = 700
            if not any(menu_slug(option["name"]) == "medialuna" for option in group.get("options", [])):
                group["options"].append({"name": "Medialuna", "price": 700})


def restore_coffee_category(state):
    coffee_names = {"expresso", "cafe-con-leche", "cafe-lagrima", "cortado", "macchiato"}
    for dish in state.get("menu", []):
        if dish.get("category") == "Bebidas calientes" and menu_slug(dish.get("name", "")) in coffee_names:
            dish["category"] = "Cafetería"


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
        if "included_quantity" in group:
            included = group["included_quantity"]
            if isinstance(included, bool) or not isinstance(included, int) or not 0 <= included <= 99 or selection != "quantity":
                raise ValueError("Las unidades incluidas deben ser un entero entre 0 y 99 en un grupo de cantidades.")
            groups[-1]["included_quantity"] = included
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


def is_unit_product(dish):
    """Producto armado solo con grupos de cantidades cuyas opciones son gratis o cuestan lo mismo que el producto
    (por ejemplo una tortilla con sus variedades): cada unidad elegida se cobra al precio del producto."""
    groups = dish.get("modifier_groups", [])
    base_price = dish.get("price", 0)
    return base_price > 0 and bool(groups) and all(
        group.get("selection") == "quantity" and not group.get("included_quantity") and all(option["price"] in (0, base_price) for option in group.get("options", []))
        for group in groups
    )


def price_item(dish, modifiers, requested_quantity):
    if is_unit_product(dish):
        units = sum(entry["quantity"] for entry in modifiers)
        if units < 1:
            raise ValueError(f"Elegí cuántas unidades querés de {dish['name']}.")
        return dish["price"], min(units, 999), True
    extras = sum(entry["unit_price"] * entry["quantity"] for entry in modifiers)
    for group in dish.get("modifier_groups", []):
        remaining = group.get("included_quantity", 0)
        selected = [entry for entry in modifiers if entry["group"] == group["name"]]
        explicit_allowance = any("included_quantity" in entry for entry in selected)
        for entry in selected:
            included = entry.get("included_quantity", 0) if explicit_allowance else min(remaining, entry["quantity"])
            extras -= included * entry["unit_price"]
            remaining -= included
    return dish["price"] + extras, requested_quantity, False


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
        if "included_quantity" in selection:
            included = selection["included_quantity"]
            if not group.get("included_quantity") or isinstance(included, bool) or not isinstance(included, int) or not 0 <= included <= quantity:
                raise ValueError("Revisá las unidades incluidas del acompañamiento.")
            selected_by_group[group_name][-1]["included_quantity"] = included

    visibility = modifier_visibility(groups, selected_by_group)
    for group in groups:
        if not visibility.get(group["name"]) and selected_by_group.get(group["name"]):
            raise ValueError(f"{group['name']} no corresponde en esta combinación.")

    for group in groups:
        if not visibility.get(group["name"]):
            continue
        selected = selected_by_group.get(group["name"], [])
        if any("included_quantity" in entry for entry in selected):
            allowance = min(group.get("included_quantity", 0), sum(entry["quantity"] for entry in selected))
            if not all("included_quantity" in entry for entry in selected) or sum(entry["included_quantity"] for entry in selected) != allowance:
                raise ValueError("La cantidad de acompañamientos incluidos no coincide con el combo.")
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


ZONE_INSIDE = "Salón adentro"
ZONE_OUTSIDE = "Salón afuera"
ZONES = [ZONE_INSIDE, ZONE_OUTSIDE]


def new_table(table_id, name, zone):
    return {"id": table_id, "name": name, "zone": zone, "status": "free", "opened_by": "", "opened_at": None, "guests": None, "items": []}


def default_tables():
    return (
        [new_table(str(number), f"Mesa {number}", ZONE_INSIDE) for number in range(1, 9)]
        + [new_table(str(number), f"Mesa {number}", ZONE_OUTSIDE) for number in range(9, 17)]
        + [new_table(f"d{number}", f"D{number}", ZONE_OUTSIDE) for number in range(1, 6)]
        + [new_table(f"s{number}", f"S{number}", ZONE_OUTSIDE) for number in range(1, 3)]
    )


def apply_zones_migration(state):
    default_zone_by_name = {table["name"].casefold(): table["zone"] for table in default_tables()}
    tables = state["tables"]
    for table in tables:
        table["zone"] = default_zone_by_name.get(str(table.get("name", "")).casefold(), ZONE_OUTSIDE)
    existing_names = {str(table.get("name", "")).casefold() for table in tables}
    existing_ids = {str(table.get("id", "")) for table in tables}
    for table in default_tables():
        if table["name"].casefold() not in existing_names and table["id"] not in existing_ids:
            tables.append(table)


def normalize_zones(state):
    default_zone_by_name = {table["name"].casefold(): table["zone"] for table in default_tables()}
    for table in state["tables"]:
        if table.get("zone") not in ZONES:
            table["zone"] = default_zone_by_name.get(str(table.get("name", "")).casefold(), ZONE_OUTSIDE)


def initial_state():
    return {
        "_migrations": ["classic-combo-v1", "classic-combo-v2", "zones-v1", "zones-v2", "carta-las-palmeras-v1", "hot-drinks-v1", "classic-extras-v1", "coffee-categories-v2", "coffee-sizes-v1", "smoothie-promo-v1"],
        "shift": None,
        "tables": default_tables(),
        "pending_sales": [],
        "sales_closures": [],
        "menu": build_site_menu(),
        "modifier_catalog": default_modifier_catalog(),
    }


def database_url():
    return os.environ.get("DATABASE_URL", "").strip()


def storage_is_volatile():
    """En Render sin base externa ni disco, el archivo SQLite se borra en cada reinicio o despliegue."""
    return bool(os.environ.get("RENDER")) and not database_url() and not os.environ.get("DATABASE_PATH")


def connect_db():
    if database_url():
        return PostgresConnection(database_url())
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
        updated = False
        if not isinstance(state.get("modifier_catalog"), list):
            catalog = default_modifier_catalog()
            state["modifier_catalog"] = catalog
            catalog_by_name = {group["name"].casefold(): group for group in catalog}
            for dish in state.get("menu", []):
                for index, existing in enumerate(dish.get("modifier_groups", [])):
                    replacement = catalog_by_name.get(existing.get("name", "").casefold())
                    if replacement:
                        updated_group = dict(replacement)
                        if existing.get("show_when"):
                            updated_group["show_when"] = existing["show_when"]
                        dish["modifier_groups"][index] = updated_group
            updated = True
        migrations = state.get("_migrations", [])
        if not isinstance(migrations, list):
            migrations = []
        if "classic-combo-v1" not in migrations:
            if not any(str(dish.get("name", "")).strip().casefold() in {"clásico", "clasico"} for dish in state["menu"]):
                state["menu"].append(default_classic_combo())
            migrations.append("classic-combo-v1")
            updated = True
        if "classic-combo-v2" not in migrations:
            make_classic_combo_conditional(state)
            migrations.append("classic-combo-v2")
            updated = True
        if "zones-v1" not in migrations:
            apply_zones_migration(state)
            migrations.append("zones-v1")
            updated = True
        if "zones-v2" not in migrations:
            normalize_zones(state)
            migrations.append("zones-v2")
            updated = True
        if "carta-las-palmeras-v1" not in migrations:
            state["menu"] = build_site_menu(state.get("menu", []))
            migrations.append("carta-las-palmeras-v1")
            updated = True
        if "hot-drinks-v1" not in migrations:
            merge_hot_drinks(state)
            migrations.append("hot-drinks-v1")
            updated = True
        if "classic-extras-v1" not in migrations:
            configure_classic_extras(state)
            migrations.append("classic-extras-v1")
            updated = True
        if "coffee-categories-v2" not in migrations:
            restore_coffee_category(state)
            migrations.append("coffee-categories-v2")
            updated = True
        if "coffee-sizes-v1" not in migrations:
            configure_coffee_sizes(state)
            migrations.append("coffee-sizes-v1")
            updated = True
        if "smoothie-promo-v1" not in migrations:
            add_smoothie_promo(state)
            migrations.append("smoothie-promo-v1")
            updated = True
        if "bar-options-v1" not in migrations:
            configure_bar_options(state)
            migrations.append("bar-options-v1")
            updated = True
        for table in state["tables"]:
            if table["status"] != "open":
                continue
            for item in table["items"]:
                if item["status"] in {"sent", "preparing", "suspended"} and not item.get("production"):
                    item["production"] = production_plan(item, state["menu"])
                    if item["status"] == "preparing":
                        for part in item["production"].values():
                            part["status"] = "preparing"
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
    state.setdefault("pending_tickets", [])
    state.setdefault("shift", None)
    return state, updated_at


def configure_bar_options(state):
    for dish in state["menu"]:
        if dish.get("category") == "Desayunos y meriendas" and "jugo" in dish.get("description", "").lower():
            groups = dish.setdefault("modifier_groups", [])
            if not any(g["name"] == "Agua o soda incluida" for g in groups):
                groups.append({"name": "Agua o soda incluida", "selection": "single", "required": False,
                    "options": [{"name": "Agua", "price": 0}, {"name": "Soda", "price": 0}]})
    extras = ["Alfajor", "Magdalena", "Galletitas", "Jugo mediano", "Jugo grande", "Lata de Pepsi", "Lata de Pepsi Black", "Lata de Seven", "Lata de Mirinda naranja"]
    for name in extras:
        if not any(menu_slug(d["name"]) == menu_slug(name) for d in state["menu"]):
            state["menu"].append({"id": "menu-" + menu_slug(name), "name": name,
                "description": "Precio pendiente: cargar precio y activar desde Carta", "category": "Extras de barra",
                "price": 0, "available": False, "modifier_groups": []})


BREAD_MEALS = {"light-palmeras", "de-campo", "americano", "energetico", "avocado"}


def bread_portions(item):
    meal = menu_slug(item.get("name", ""))
    if meal == "clasico-medio-bollo":
        return [{"name": "Bollo", "quantity": item["quantity"] * 0.5, "pieces_per_portion": 2, "piece_name": "triángulos"}]
    if meal == "clasico":
        selected = [m for m in item.get("modifiers", []) if m["group"] == "Porción incluida" and m["name"] != "2 acompañamientos"]
        if not selected:
            return []
    elif meal.startswith("porcion-extra-de-"):
        bread_name = item["name"].replace("Porción extra de ", "", 1)
        return [{"name": bread_name, "quantity": item["quantity"], "pieces_per_portion": 2 if "bollo" in meal else 3, "piece_name": "triángulos" if "bollo" in meal else "rodajas"}]
    elif meal not in BREAD_MEALS:
        return []
    selected = [m for m in item.get("modifiers", []) if m["group"] in {"Tostadas", "Pan", "Porción incluida"} and m["name"] != "2 acompañamientos"]
    if not selected:
        selected = [{"name": "Pan de campo", "quantity": 1}]
    result = []
    for modifier in selected:
        slug = menu_slug(modifier["name"])
        half = "medio" in slug or "media" in slug or "1-2" in slug
        bollo = "bollo" in slug
        campo = "campo" in slug
        avocado_campo = menu_slug(item.get("name", "")) == "avocado"
        result.append({"name": "Bollo" if bollo else modifier["name"],
            "quantity": item["quantity"] * modifier["quantity"] * (0.5 if half else 1),
            "pieces_per_portion": 2 if bollo or avocado_campo else 3,
            "piece_name": "triángulos" if bollo else "tostadas" if avocado_campo else "rodajas"})
    return result


def production_plan(item, menu):
    dish = next((dish for dish in menu if dish["id"] == item["menu_id"]), {})
    category = dish.get("category", "")
    name = item.get("name", "")
    slug = menu_slug(name)
    parts = {}

    def part(station):
        return parts.setdefault(station, {"status": "sent", "modifiers": [], "details": []})

    def detail(station, text):
        if text:
            part(station)["details"].append(text)

    for modifier in item.get("modifiers", []):
        group = modifier["group"]
        if group == "Porción incluida" or (menu_slug(name) in BREAD_MEALS and group in {"Tostadas", "Pan"}):
            continue
        option = menu_slug(modifier["name"])
        if group in {"Infusión", "Tamaño", "Primer licuado", "Segundo licuado"}:
            station = "cocina"
        elif any(word in option for word in ["medialuna", "tortilla", "factura", "bollito"]):
            station = "barra"
        elif group in {"Agregados", "Agua o soda incluida"}:
            station = "barra"
        else:
            station = "cocina"
        part(station)["modifiers"].append(modifier)

    if category in {"Cafetería", "Bebidas calientes"}:
        detail("cocina", name)
    elif category == "Porciones adicionales":
        part("cocina")
    elif category == "Extras de barra":
        detail("barra", name)
    elif category == "Bebidas en general":
        detail("cocina" if any(word in slug for word in ["licuado", "limonada"]) else "barra", name)
    elif category == "Desayunos y meriendas":
        if "jugo" in dish.get("description", "").lower():
            detail("barra", "Jugo de naranja chico incluido")
        food = {
            "light-palmeras": "Queso crema, mermelada, yogurt y cereal",
            "de-campo": "Manteca y dulce de leche",
            "especial-tostado": "Tostado de jamón, queso, tomate y orégano",
            "energetico": "Avena, frutos secos y banana",
            "americano": "Huevos revueltos y panceta",
            "avocado": "Palta y huevo poché",
            "sandwich-pan-sanguchero-apretado": "Sandwich pan sanguchero (Apretado)",
        }
        if slug not in {"clasico", "clasico-medio-bollo"} and not (slug == "especial-tostado" and any(m["group"] == "Tostado" for m in item.get("modifiers", []))):
            detail("cocina", food.get(slug, name))
        if "gaseosa" in dish.get("description", "").lower():
            detail("barra", "Lata de gaseosa incluida")
    elif category == "Momentos especiales":
        fixed = {
            "momento-palmeras": [("cocina", "Café con leche"), ("barra", "2 medialunas")],
            "relax": [("cocina", "Porción de torta del día")],
            "dulce": [("cocina", "Capuchino y alfajor o brownie")],
            "refrescante": [("cocina", "Limonada"), ("cocina", "Tostado simple")],
            "saludable": [("cocina", "Licuado"), ("cocina", "Tostada integral")],
        }
        for station, text in fixed.get(slug, []):
            detail(station, text)
    elif any(word in slug for word in ["medialuna", "tortilla", "factura", "bollito"]):
        detail("barra", name)
    else:
        detail("cocina", name)
    if bread_portions(item):
        part("cocina")["bread"] = bread_portions(item)
    if not parts:
        detail("cocina", name)
    return parts


def mutate_state(action):
    with closing(connect_db()) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        state, _ = ensure_existing_state(connection)
        state.setdefault("pending_sales", [])
        state.setdefault("sales_closures", [])
        state.setdefault("pending_tickets", [])
        state.setdefault("shift", None)
        tables = state["tables"]
        menu = state["menu"]
        state.setdefault("modifier_catalog", default_modifier_catalog())
        action_type = action.get("type")
        stamp = now_iso()

        def find_table():
            table = next((entry for entry in tables if entry["id"] == str(action.get("table_id", ""))), None)
            if table is None:
                raise ValueError("No encontramos esa mesa.")
            return table

        if action_type == "station_status":
            table = find_table()
            item = next((item for item in table["items"] if item["id"] == str(action.get("item_id", ""))), None)
            station = str(action.get("station", ""))
            status = str(action.get("status", ""))
            if table["status"] != "open" or item is None or item["status"] not in {"sent", "preparing", "suspended"}:
                raise ValueError("Este producto ya no espera preparación.")
            production = item.setdefault("production", production_plan(item, menu))
            if station not in production or status not in {"preparing", "ready"}:
                raise ValueError("Revisá el sector y el estado.")
            previous = production[station]["status"]
            if (previous, status) not in {("sent", "preparing"), ("preparing", "ready")}:
                raise ValueError("El estado cambió. Revisá el pedido.")
            production[station]["status"] = status
            production[station]["updated_at"] = stamp
            if all(part["status"] == "ready" for part in production.values()):
                item.update(status="ready", ready_at=stamp)
            else:
                item["status"] = "preparing"
        elif action_type == "table_create":
            name = str(action.get("name", "")).strip()[:40]
            if not name:
                raise ValueError("Escribí el nombre de la mesa.")
            if any(entry["name"].casefold() == name.casefold() for entry in tables):
                raise ValueError("Ya existe una mesa con ese nombre.")
            zone = str(action.get("zone", "")).strip()
            tables.append(new_table(str(uuid.uuid4()), name, zone if zone in ZONES else ZONE_OUTSIDE))
        elif action_type == "table_open":
            table = find_table()
            if state["shift"] is None:
                raise ValueError("Iniciá el turno antes de abrir una mesa.")
            if table["status"] != "free":
                raise ValueError("Esta mesa ya está ocupada.")
            try:
                guests = int(action.get("guests", 1))
            except (TypeError, ValueError, OverflowError):
                guests = 1
            guests = max(1, min(guests, 30))
            table.update(status="open", opened_by=str(action.get("waiter", "Equipo")).strip()[:40] or "Equipo", opened_at=stamp, guests=guests, items=[], order_round=0)
        elif action_type == "item_add":
            table = find_table()
            if table["status"] != "open":
                raise ValueError("La mesa no está abierta.")
            dish = next((entry for entry in menu if entry["id"] == str(action.get("menu_id", "")) and entry["available"]), None)
            if dish is None:
                raise ValueError("Ese producto ya no está disponible.")
            quantity = max(1, min(int(action.get("quantity", 1)), 99))
            modifiers = select_modifiers(dish, action.get("modifiers", []))
            unit_price, quantity, unit_mode = price_item(dish, modifiers, quantity)
            table["items"].append({
                "id": str(uuid.uuid4()), "menu_id": dish["id"], "name": dish["name"], "price": unit_price,
                "modifiers": modifiers,
                "quantity": quantity, "note": str(action.get("note", "")).strip()[:160], "status": "draft", "added_by": str(action.get("waiter", "Equipo")).strip()[:40] or "Equipo",
                "priority": action.get("priority") is True, "created_at": stamp, "sent_at": None,
                "unit_mode": unit_mode,
            })
        elif action_type == "order_send":
            table = find_table()
            pending = [item for item in table["items"] if item["status"] == "draft"]
            if not pending:
                raise ValueError("No hay productos nuevos para enviar.")
            previous_round = int(table.get("order_round", 0))
            if not previous_round and any(item.get("sent_at") for item in table["items"] if item not in pending):
                previous_round = 1
            table["order_round"] = previous_round + 1
            for item in pending:
                item["order_round"] = table["order_round"]
                item.update(status="sent", sent_at=stamp, ready_at=None, retrieved_at=None, retrieved_by=None)
                item["production"] = production_plan(item, menu)
        elif action_type == "order_retrieve":
            table = find_table()
            item = next((entry for entry in table["items"] if entry["id"] == str(action.get("item_id", ""))), None)
            if item is None or item["status"] not in {"sent", "preparing"}:
                raise ValueError("No se encontró el producto o no está en cola de cocina.")
            if item.get("production") and not all(part["status"] == "ready" for part in item["production"].values()):
                raise ValueError("Falta terminar la preparación en barra o cocina.")
            item["status"] = "ready"
            item["ready_at"] = stamp
            item.pop("retrieved_at", None)
            item.pop("retrieved_by", None)
        elif action_type == "item_mark_retrieved":
            table = find_table()
            item = next((entry for entry in table["items"] if entry["id"] == str(action.get("item_id", ""))), None)
            if table["status"] != "open" or item is None or item["status"] != "ready" or item.get("retrieved_at"):
                raise ValueError("Solo se puede marcar como retirado un producto listo que todavía espera retiro.")
            item["retrieved_at"] = stamp
            item["retrieved_by"] = str(action.get("waiter", "Equipo")).strip()[:40] or "Equipo"
        elif action_type == "item_status":
            table = find_table()
            item = next((entry for entry in table["items"] if entry["id"] == str(action.get("item_id", ""))), None)
            current_status = str(item["status"]) if item is not None else ""
            status = str(action.get("status", ""))
            allowed_status = {
                "sent": {"preparing", "ready", "suspended", "draft", "canceled"},
                "preparing": {"ready", "suspended", "draft", "canceled"},
                "suspended": {"preparing", "ready", "draft", "canceled"},
                "ready": {"ready", "draft", "canceled"},
                "draft": {"draft", "canceled"},
                "canceled": {"draft"},
            }
            if item is None or status not in allowed_status.get(current_status, set()):
                raise ValueError("No se pudo actualizar el producto.")
            if status == "ready" and item.get("production") and not all(part["status"] == "ready" for part in item["production"].values()):
                raise ValueError("Falta terminar la preparación en barra o cocina.")
            item["status"] = status
            if status == "ready":
                item["ready_at"] = stamp
                item.pop("retrieved_at", None)
                item.pop("retrieved_by", None)
            else:
                item.pop("retrieved_at", None)
                item.pop("retrieved_by", None)
        elif action_type == "item_status_bulk":
            table = find_table()
            item_ids = action.get("item_ids")
            status = str(action.get("status", ""))
            if not isinstance(item_ids, list) or not 1 <= len(item_ids) <= 500 or len({str(item_id) for item_id in item_ids}) != len(item_ids):
                raise ValueError("No se pudo actualizar el grupo de productos.")
            items_by_id = {item["id"]: item for item in table["items"]}
            selected_items = [items_by_id.get(str(item_id)) for item_id in item_ids]
            allowed_status = {
                "sent": {"preparing", "ready", "suspended", "draft", "canceled"},
                "preparing": {"ready", "suspended", "draft", "canceled"},
                "suspended": {"preparing", "ready", "draft", "canceled"},
                "ready": {"ready", "draft", "canceled"},
                "draft": {"draft", "canceled"},
                "canceled": {"draft"},
            }
            if any(item is None or status not in allowed_status.get(item["status"], set()) for item in selected_items):
                raise ValueError("El grupo cambiÃ³. ActualizÃ¡ la cocina antes de continuar.")
            if status == "ready" and any(item.get("production") and not all(part["status"] == "ready" for part in item["production"].values()) for item in selected_items):
                raise ValueError("Falta terminar la preparaciÃ³n en barra o cocina.")
            for item in selected_items:
                item["status"] = status
                if status == "ready":
                    item["ready_at"] = stamp
                    item.pop("retrieved_at", None)
                    item.pop("retrieved_by", None)
                else:
                    item.pop("retrieved_at", None)
                    item.pop("retrieved_by", None)
        elif action_type == "item_edit":
            table = find_table()
            item = next((entry for entry in table["items"] if entry["id"] == str(action.get("item_id", ""))), None)
            if item is None:
                raise ValueError("No se encontró ese producto.")
            if item["status"] == "canceled":
                raise ValueError("No se puede editar un producto cancelado.")
            if table["status"] != "open":
                raise ValueError("La mesa no está abierta para editar el pedido.")
            menu_item = next((entry for entry in menu if entry["id"] == str(action.get("menu_id", "")) and entry["available"]), None)
            if menu_item is None:
                raise ValueError("Ese producto ya no está disponible en la carta.")
            if item["menu_id"] != menu_item["id"]:
                raise ValueError("El producto no corresponde a la carta seleccionada.")
            try:
                quantity = max(1, min(int(action.get("quantity", item["quantity"])), 99))
            except (TypeError, ValueError):
                raise ValueError("La cantidad tiene que ser un número entero entre 1 y 99.")
            if "modifiers" in action:
                if not isinstance(action["modifiers"], list) or len(action["modifiers"]) > 10:
                    raise ValueError("Revisá el número de opciones del pedido.")
                try:
                    edited_modifiers = select_modifiers(menu_item, action["modifiers"])
                except ValueError as error:
                    raise ValueError(str(error)) from error
                unit_price, quantity, unit_mode = price_item(menu_item, edited_modifiers, quantity)
                item["unit_mode"] = unit_mode
                if len(edited_modifiers) != len(item["modifiers"]):
                    item["edited_by"] = str(action.get("waiter", "Equipo")).strip()[:40] or "Equipo"
                    item["edited_at"] = stamp
                item["modifiers"] = edited_modifiers
            else:
                edited_modifiers = item["modifiers"]
                unit_price = item["price"]
                if item.get("unit_mode"):
                    quantity = item["quantity"]
            item["quantity"] = quantity
            if item.get("production"):
                item["production"] = production_plan(item, menu)
                if item["status"] != "draft":
                    item["status"] = "sent"
                    item["ready_at"] = None
            if "note" in action:
                item["note"] = str(action.get("note", "")).strip()[:160]
            if "priority" in action:
                item["priority"] = action.get("priority") is True
            item["price"] = unit_price
            item["edited_by"] = str(action.get("waiter", "Equipo")).strip()[:40] or "Equipo"
            item["edited_at"] = stamp

        elif action_type == "item_priority":
            table = find_table()
            item = next((entry for entry in table["items"] if entry["id"] == str(action.get("item_id", ""))), None)
            if item is None or item["status"] not in {"sent", "preparing", "suspended"}:
                raise ValueError("No se pudo actualizar la prioridad del producto.")
            item["priority"] = action.get("priority") is True
        elif action_type == "item_priority_bulk":
            table = find_table()
            item_ids = action.get("item_ids")
            if not isinstance(item_ids, list) or not 1 <= len(item_ids) <= 500 or len({str(item_id) for item_id in item_ids}) != len(item_ids):
                raise ValueError("No se pudo actualizar la prioridad del grupo.")
            items_by_id = {item["id"]: item for item in table["items"]}
            selected_items = [items_by_id.get(str(item_id)) for item_id in item_ids]
            if any(item is None or item["status"] not in {"sent", "preparing", "suspended"} for item in selected_items):
                raise ValueError("El grupo cambiÃ³. ActualizÃ¡ la cocina antes de continuar.")
            for item in selected_items:
                item["priority"] = action.get("priority") is True
        elif action_type in {"table_paid", "items_paid"}:
            table = find_table()
            if table["status"] != "open":
                raise ValueError("La mesa no se puede cobrar en este estado.")
            billable_items = [item for item in table["items"] if item["status"] != "canceled"]
            if not billable_items:
                raise ValueError("No hay productos activos para cobrar.")
            selected = action.get("items") if action_type == "items_paid" else None
            remaining_items = None
            if action_type == "items_paid":
                if not isinstance(selected, list) or not selected:
                    raise ValueError("Elegí al menos un producto para cobrar.")
                quantities = {}
                for entry in selected:
                    if not isinstance(entry, dict):
                        raise ValueError("Revisá los productos seleccionados.")
                    item_id = str(entry.get("item_id", ""))
                    quantity = entry.get("quantity")
                    item = next((row for row in billable_items if row["id"] == item_id), None)
                    if item_id in quantities or item is None or type(quantity) is not int or quantity < 1 or quantity > item["quantity"]:
                        raise ValueError("El pedido cambió. Revisá las cantidades antes de cobrar.")
                    if "expected_quantity" in entry and entry["expected_quantity"] != item["quantity"]:
                        raise ValueError("El pedido cambió. Cerrá esta ventana y revisá el saldo pendiente.")
                    quantities[item_id] = quantity
                remaining_items = []
                charged_items = []
                for item in table["items"]:
                    quantity = quantities.get(item["id"], 0)
                    charged = {**item, "quantity": quantity}
                    remainder = {**item, "quantity": item["quantity"] - quantity}
                    if quantity and item.get("unit_mode"):
                        charged["modifiers"], remainder["modifiers"] = [], []
                        units_left = quantity
                        for modifier in item.get("modifiers", []):
                            taken = min(units_left, modifier["quantity"])
                            if taken:
                                charged["modifiers"].append({**modifier, "quantity": taken})
                            if taken < modifier["quantity"]:
                                remainder["modifiers"].append({**modifier, "quantity": modifier["quantity"] - taken})
                            units_left -= taken
                    if quantity:
                        charged_items.append(charged)
                    if not quantity or quantity < item["quantity"]:
                        remaining_items.append(remainder)
                billable_items = charged_items
            if any(item["status"] != "ready" for item in billable_items):
                raise ValueError("Esperá a que los productos seleccionados estén listos antes de cobrar.")
            for item in billable_items:
                name = str(item.get("name", "")).strip()
                quantity = int(item.get("quantity", 0) or 0)
                if not name or quantity <= 0:
                    continue
                sale = next((entry for entry in state["pending_sales"] if normalize_menu_name(entry["name"]) == normalize_menu_name(name)), None)
                if sale is None:
                    state["pending_sales"].append({"name": name, "quantity": quantity})
                else:
                    sale["quantity"] += quantity
            state["pending_tickets"].append({
                "table_id": table["id"],
                "table_name": table["name"],
                "total": sum(int(item.get("price", 0) or 0) * int(item.get("quantity", 0) or 0) for item in billable_items),
                "units": sum(int(item.get("quantity", 0) or 0) for item in billable_items),
                "paid_at": stamp,
                "items": [dict(item) for item in billable_items],
            })
            if remaining_items is not None and any(item["status"] != "canceled" for item in remaining_items):
                table["items"] = remaining_items
            else:
                table.update(status="cleaning", paid_at=stamp)
        elif action_type == "shift_start":
            shift = str(action.get("shift", ""))
            if shift not in {"morning", "afternoon"}:
                raise ValueError("Elegí un turno válido.")
            if state["shift"] is not None:
                raise ValueError("Ya hay un turno en curso.")
            state["shift"] = {
                "type": shift,
                "started_at": stamp,
                "started_by": str(action.get("waiter", "")).strip()[:40],
            }
        elif action_type == "shift_correct":
            if state["shift"] is None:
                raise ValueError("No hay un turno en curso.")
            shift = str(action.get("shift", ""))
            if shift not in {"morning", "afternoon"}:
                raise ValueError("Elegí un turno válido.")
            state["shift"]["type"] = shift
        elif action_type == "shift_close":
            if state["shift"] is None:
                raise ValueError("No hay un turno en curso.")
            unpaid = [entry["name"] for entry in tables if entry["status"] == "open" and any(item["status"] != "canceled" for item in entry["items"])]
            if unpaid:
                raise ValueError(f"Hay mesas abiertas sin cobrar: {', '.join(unpaid)}. Cobralas o cancelá sus productos antes de cerrar el turno.")
            for entry in tables:
                if entry["status"] in {"open", "cleaning"}:
                    entry.update(status="free", opened_by="", opened_at=None, paid_at=None, guests=None, items=[])
            closure = {
                "id": str(uuid.uuid4()),
                "shift": state["shift"]["type"],
                "started_at": state["shift"]["started_at"],
                "started_by": state["shift"].get("started_by", ""),
                "closed_at": stamp,
                "items": [dict(item) for item in state["pending_sales"]],
                "total_units": sum(int(item["quantity"]) for item in state["pending_sales"]),
                "total_amount": sum(int(ticket["total"]) for ticket in state["pending_tickets"]),
                "tickets": len(state["pending_tickets"]),
            }
            state["sales_closures"].append(closure)
            state["pending_sales"] = []
            state["pending_tickets"] = []
            state["shift"] = None
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
        elif action_type == "modifier_catalog_update":
            catalog = normalize_modifier_groups(action.get("modifier_catalog", []))
            if not catalog:
                raise ValueError("La carta común necesita al menos una categoría con opciones.")
            state["modifier_catalog"] = catalog
            catalog_by_name = {group["name"].casefold(): group for group in catalog}
            for dish in menu:
                for index, existing in enumerate(dish.get("modifier_groups", [])):
                    replacement = catalog_by_name.get(existing.get("name", "").casefold())
                    if replacement:
                        updated_group = dict(replacement)
                        if existing.get("show_when"):
                            updated_group["show_when"] = existing["show_when"]
                        dish["modifier_groups"][index] = updated_group
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
    return jsonify({**state, "updated_at": updated_at, "storage_volatile": storage_is_volatile()})


@app.post("/api/action")
def api_action():
    action = request.get_json(silent=True) or {}
    try:
        state, updated_at = mutate_state(action)
    except (ValueError, TypeError, OverflowError) as error:
        return jsonify({"error": str(error)}), 400
    return jsonify({**state, "updated_at": updated_at, "storage_volatile": storage_is_volatile()})


initialize_db()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8000")), threaded=True)
