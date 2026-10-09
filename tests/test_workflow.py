import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app


SAMPLE_MENU = [
    {"id": "menu-te", "name": "Té", "description": "Consultar variedades", "category": "Infusiones", "price": 2000, "available": True},
    {"id": "menu-cafe", "name": "Café", "description": "Café en jarrito", "category": "Infusiones", "price": 1800, "available": True},
    {"id": "menu-jamon", "name": "Jamón y queso", "description": "Tostado en pan árabe o miga", "category": "Para acompañar", "price": 4500, "available": True},
    {"id": "menu-licuado", "name": "Licuados", "description": "Fruta de estación", "category": "Bebidas", "price": 3000, "available": True},
]


class ComandaWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        database_path = Path(self.temporary_directory.name) / "test.sqlite3"
        self.database_patch = patch.object(app, "DATABASE_PATH", database_path)
        self.database_patch.start()
        app.initialize_db()
        self.client = app.app.test_client()
        self.use_sample_menu()
        self.action("shift_start", shift="morning", waiter="Prueba")

    def use_sample_menu(self):
        with app.closing(app.connect_db()) as connection, connection:
            state = app.json.loads(connection.execute("SELECT document FROM app_state WHERE id = 1").fetchone()["document"])
            combo = app.default_classic_combo()
            combo["price"] = 4500
            combo["category"] = "Combos"
            state["menu"] = [dict(dish) for dish in SAMPLE_MENU] + [combo]
            connection.execute("UPDATE app_state SET document = ? WHERE id = 1", (app.json.dumps(state, ensure_ascii=False),))

    def tearDown(self):
        self.database_patch.stop()
        self.temporary_directory.cleanup()

    def action(self, action_type, **values):
        return self.client.post("/api/action", json={"type": action_type, **values})

    def test_cannot_charge_until_every_item_is_ready(self):
        opened = self.action("table_open", table_id="1", waiter="Prueba")
        self.assertEqual(opened.status_code, 200)

        added = self.action("item_add", table_id="1", menu_id="menu-te", quantity=1, waiter="Prueba")
        self.assertEqual(added.status_code, 200)

        premature_payment = self.action("table_paid", table_id="1")
        self.assertEqual(premature_payment.status_code, 400)

        sent = self.action("order_send", table_id="1")
        item_id = sent.json["tables"][0]["items"][0]["id"]
        self.assertEqual(sent.status_code, 200)

        ready = self.action("item_status", table_id="1", item_id=item_id, status="ready")
        self.assertEqual(ready.status_code, 200)

        paid = self.action("table_paid", table_id="1")
        self.assertEqual(paid.status_code, 200)
        self.assertEqual(paid.json["tables"][0]["status"], "cleaning")

        cleaned = self.action("table_clean", table_id="1")
        self.assertEqual(cleaned.status_code, 200)
        self.assertEqual(cleaned.json["tables"][0]["status"], "free")

    def test_sent_item_can_be_edited_without_leaving_the_kitchen_queue(self):
        self.action("table_open", table_id="1", waiter="Prueba")
        self.action("item_add", table_id="1", menu_id="menu-te", quantity=1, note="Con azúcar")
        sent = self.action("order_send", table_id="1")
        item = sent.json["tables"][0]["items"][0]

        edited = self.action(
            "item_edit",
            table_id="1",
            item_id=item["id"],
            menu_id="menu-te",
            quantity=2,
            modifiers=[],
            note="Sin azúcar",
            priority=True,
            waiter="Prueba",
        )

        self.assertEqual(edited.status_code, 200)
        updated_item = edited.json["tables"][0]["items"][0]
        self.assertEqual(updated_item["status"], "sent")
        self.assertEqual(updated_item["quantity"], 2)
        self.assertEqual(updated_item["note"], "Sin azúcar")
        self.assertTrue(updated_item["priority"])
        self.assertEqual(updated_item["price"], 2000)

    def test_canceled_items_are_excluded_from_payment_and_sales(self):
        self.action("table_open", table_id="1", waiter="Prueba")
        self.action("item_add", table_id="1", menu_id="menu-te", quantity=1)
        self.action("item_add", table_id="1", menu_id="menu-cafe", quantity=2)
        sent = self.action("order_send", table_id="1")
        items = sent.json["tables"][0]["items"]

        canceled = self.action("item_status", table_id="1", item_id=items[0]["id"], status="canceled")
        self.assertEqual(canceled.status_code, 200)
        paid_early = self.action("table_paid", table_id="1")
        self.assertEqual(paid_early.status_code, 400)

        ready = self.action("item_status", table_id="1", item_id=items[1]["id"], status="ready")
        self.assertEqual(ready.status_code, 200)
        paid = self.action("table_paid", table_id="1")

        self.assertEqual(paid.status_code, 200)
        self.assertEqual(paid.json["pending_sales"], [{"name": "Café", "quantity": 2}])

    def test_table_with_only_canceled_items_cannot_be_paid(self):
        self.action("table_open", table_id="1", waiter="Prueba")
        added = self.action("item_add", table_id="1", menu_id="menu-te", quantity=1)
        item_id = added.json["tables"][0]["items"][0]["id"]
        self.action("item_status", table_id="1", item_id=item_id, status="canceled")

        paid = self.action("table_paid", table_id="1")

        self.assertEqual(paid.status_code, 400)
        self.assertEqual(paid.json["error"], "No hay productos activos para cobrar.")

    def test_canceled_item_can_be_reactivated_as_draft(self):
        self.action("table_open", table_id="1", waiter="Prueba")
        added = self.action("item_add", table_id="1", menu_id="menu-te", quantity=1)
        item_id = added.json["tables"][0]["items"][0]["id"]
        self.action("order_send", table_id="1")
        self.action("item_status", table_id="1", item_id=item_id, status="canceled")

        reactivated = self.action("item_status", table_id="1", item_id=item_id, status="draft")

        self.assertEqual(reactivated.status_code, 200)
        self.assertEqual(reactivated.json["tables"][0]["items"][0]["status"], "draft")

    def test_menu_import_merges_duplicate_products(self):
        initial_count = len(app.read_state()[0]["menu"])

        payload = [
            {"name": "Café", "description": "Café en jarrito", "category": "Infusiones", "price": 1800},
            {"name": "Té", "description": "Consultar variedades", "category": "Infusiones", "price": 2000},
            {"name": "Medialuna", "description": "Clásica", "category": "Para acompañar", "price": 700},
        ]

        response = self.action("menu_import", items=payload)
        self.assertEqual(response.status_code, 200)

        state = response.json
        menu = state["menu"]
        self.assertEqual(len(menu), initial_count + 1)
        self.assertTrue(any(dish["name"] == "Medialuna" for dish in menu))
        self.assertTrue(sum(1 for dish in menu if dish["name"] == "Café") == 1)
        self.assertTrue(sum(1 for dish in menu if dish["name"] == "Té") == 1)

    def test_combo_modifiers_are_required_priced_and_saved_per_unit(self):
        groups = [
            {
                "name": "Infusión",
                "selection": "single",
                "required": True,
                "options": [{"name": "Mate", "price": 0}, {"name": "Café con leche", "price": 0}],
            },
            {
                "name": "Acompañamientos",
                "selection": "quantity",
                "required": True,
                "options": [{"name": "Tortilla fina", "price": 0}, {"name": "Tortilla gruesa", "price": 0}],
            },
            {
                "name": "Extras",
                "selection": "quantity",
                "required": False,
                "options": [{"name": "Manteca", "price": 250}, {"name": "Mermelada", "price": 300}],
            },
        ]
        combo = next(dish for dish in app.read_state()[0]["menu"] if dish["name"] == "Clásico")
        created = self.action(
            "menu_update",
            menu_id=combo["id"],
            name="Clásico",
            category="Combos",
            description="Infusión con acompañamientos",
            price=3500,
            modifier_groups=groups,
        )
        self.assertEqual(created.status_code, 200)
        combo_id = combo["id"]
        self.action("table_open", table_id="1", waiter="Prueba")

        missing_required = self.action("item_add", table_id="1", menu_id=combo_id, quantity=1)
        self.assertEqual(missing_required.status_code, 400)

        added = self.action(
            "item_add",
            table_id="1",
            menu_id=combo_id,
            quantity=2,
            modifiers=[
                {"group": "Infusión", "option": "Mate", "quantity": 1},
                {"group": "Acompañamientos", "option": "Tortilla fina", "quantity": 1},
                {"group": "Acompañamientos", "option": "Tortilla gruesa", "quantity": 1},
                {"group": "Extras", "option": "Manteca", "quantity": 1},
            ],
        )
        self.assertEqual(added.status_code, 200)
        item = added.json["tables"][0]["items"][0]
        self.assertEqual(item["price"], 3750)
        self.assertEqual(item["quantity"], 2)
        self.assertEqual(item["modifiers"][1]["quantity"], 1)
        self.assertEqual(added.json["tables"][0]["items"][0]["price"] * 2, 7500)

        imported = self.action("menu_import", items=[{"name": "Clásico", "category": "Combos", "price": 3500}])
        self.assertEqual(imported.status_code, 200)
        combo = next(dish for dish in imported.json["menu"] if dish["name"] == "Clásico")
        self.assertEqual(combo["modifier_groups"], groups)

    def test_combo_modifier_selection_rejects_unknown_and_duplicate_options(self):
        groups = [{
            "name": "Infusión",
            "selection": "single",
            "required": True,
            "options": [{"name": "Mate", "price": 0}],
        }]
        created = self.action("menu_add", name="Combo", category="Combos", price=1000, modifier_groups=groups)
        combo_id = created.json["menu"][-1]["id"]
        self.action("table_open", table_id="1", waiter="Prueba")

        unknown = self.action("item_add", table_id="1", menu_id=combo_id, modifiers=[{"group": "Infusión", "option": "Té", "quantity": 1}])
        self.assertEqual(unknown.status_code, 400)

        duplicate = self.action("item_add", table_id="1", menu_id=combo_id, modifiers=[
            {"group": "Infusión", "option": "Mate", "quantity": 1},
            {"group": "Infusión", "option": "Mate", "quantity": 1},
        ])
        self.assertEqual(duplicate.status_code, 400)

    def test_conditional_groups_hide_until_dependency_is_selected(self):
        groups = [
            {
                "name": "Infusión",
                "selection": "single",
                "required": False,
                "options": [{"name": "Mate", "price": 0}, {"name": "Café", "price": 0}],
            },
            {
                "name": "Acompañamientos",
                "selection": "quantity",
                "required": True,
                "show_when": {"group": "Infusión"},
                "options": [{"name": "Tortilla fina", "price": 0}, {"name": "Factura", "price": 100}],
            },
        ]
        created = self.action("menu_add", name="Combo condicional", category="Combos", price=1000, modifier_groups=groups)
        self.assertEqual(created.status_code, 200)
        combo = created.json["menu"][-1]
        self.assertEqual(combo["modifier_groups"][1]["show_when"], {"group": "Infusión"})
        combo_id = combo["id"]
        self.action("table_open", table_id="1", waiter="Prueba")

        hidden_without_dependency = self.action("item_add", table_id="1", menu_id=combo_id, modifiers=[])
        self.assertEqual(hidden_without_dependency.status_code, 200)

        selections_on_hidden_group = self.action(
            "item_add",
            table_id="1",
            menu_id=combo_id,
            modifiers=[{"group": "Acompañamientos", "option": "Tortilla fina", "quantity": 1}],
        )
        self.assertEqual(selections_on_hidden_group.status_code, 400)

        missing_conditional = self.action(
            "item_add",
            table_id="1",
            menu_id=combo_id,
            modifiers=[{"group": "Infusión", "option": "Café", "quantity": 1}],
        )
        self.assertEqual(missing_conditional.status_code, 400)

        complete = self.action(
            "item_add",
            table_id="1",
            menu_id=combo_id,
            modifiers=[
                {"group": "Infusión", "option": "Café", "quantity": 1},
                {"group": "Acompañamientos", "option": "Tortilla fina", "quantity": 2},
                {"group": "Acompañamientos", "option": "Factura", "quantity": 1},
            ],
        )
        self.assertEqual(complete.status_code, 200)
        item = complete.json["tables"][0]["items"][-1]
        self.assertEqual(item["price"], 1100)
        self.assertEqual(len(item["modifiers"]), 3)

    def test_conditional_group_can_depend_on_specific_options(self):
        groups = [
            {
                "name": "Infusión",
                "selection": "single",
                "required": True,
                "options": [{"name": "Mate", "price": 0}, {"name": "Café", "price": 0}],
            },
            {
                "name": "Solo café",
                "selection": "quantity",
                "required": True,
                "show_when": {"group": "Infusión", "options": ["Café"]},
                "options": [{"name": "Azúcar", "price": 0}],
            },
        ]
        created = self.action("menu_add", name="Combo solo café", category="Combos", price=900, modifier_groups=groups)
        self.assertEqual(created.status_code, 200)
        combo = created.json["menu"][-1]
        self.assertEqual(combo["modifier_groups"][1]["show_when"], {"group": "Infusión", "options": ["Café"]})
        combo_id = combo["id"]
        self.action("table_open", table_id="1", waiter="Prueba")

        with_mate = self.action(
            "item_add",
            table_id="1",
            menu_id=combo_id,
            modifiers=[{"group": "Infusión", "option": "Mate", "quantity": 1}],
        )
        self.assertEqual(with_mate.status_code, 200)

        with_coffee_missing_extra = self.action(
            "item_add",
            table_id="1",
            menu_id=combo_id,
            modifiers=[{"group": "Infusión", "option": "Café", "quantity": 1}],
        )
        self.assertEqual(with_coffee_missing_extra.status_code, 400)

        with_coffee = self.action(
            "item_add",
            table_id="1",
            menu_id=combo_id,
            modifiers=[
                {"group": "Infusión", "option": "Café", "quantity": 1},
                {"group": "Solo café", "option": "Azúcar", "quantity": 2},
            ],
        )
        self.assertEqual(with_coffee.status_code, 200)

    def test_conditional_group_rejects_invalid_conditions(self):
        base_group = {"name": "Infusión", "selection": "single", "required": False, "options": [{"name": "Mate", "price": 0}]}

        unknown_group = self.action("menu_add", name="Combo A", category="Combos", price=500, modifier_groups=[
            base_group,
            {"name": "Acompañados", "selection": "quantity", "required": False, "show_when": {"group": "Inexistente"}, "options": [{"name": "Queso", "price": 0}]},
        ])
        self.assertEqual(unknown_group.status_code, 400)

        self_reference = self.action("menu_add", name="Combo B", category="Combos", price=500, modifier_groups=[
            {**base_group, "show_when": {"group": "Infusión"}},
            {"name": "Acompañados", "selection": "quantity", "required": False, "options": [{"name": "Queso", "price": 0}]},
        ])
        self.assertEqual(self_reference.status_code, 400)

        unknown_option = self.action("menu_add", name="Combo C", category="Combos", price=500, modifier_groups=[
            base_group,
            {"name": "Acompañados", "selection": "quantity", "required": False, "show_when": {"group": "Infusión", "options": ["Té"]}, "options": [{"name": "Queso", "price": 0}]},
        ])
        self.assertEqual(unknown_option.status_code, 400)

        cycle = self.action("menu_add", name="Combo D", category="Combos", price=500, modifier_groups=[
            {**base_group, "show_when": {"group": "Acompañados"}},
            {"name": "Acompañados", "selection": "quantity", "required": False, "show_when": {"group": "Infusión"}, "options": [{"name": "Queso", "price": 0}]},
        ])
        self.assertEqual(cycle.status_code, 400)

    def test_classic_combo_accompaniments_are_conditional_by_default(self):
        state = app.read_state()[0]
        combo = next(dish for dish in state["menu"] if dish["id"] == "menu-clasico")
        accompaniments = next(group for group in combo["modifier_groups"] if group["name"] == "Acompañamientos")
        self.assertEqual(accompaniments.get("show_when"), {"group": "Infusión"})

        self.action("table_open", table_id="1", waiter="Prueba")
        without_infusion = self.action("item_add", table_id="1", menu_id="menu-clasico", quantity=1)
        self.assertEqual(without_infusion.status_code, 400)

        complete = self.action("item_add", table_id="1", menu_id="menu-clasico", quantity=1, modifiers=[
            {"group": "Infusión", "option": "Mate", "quantity": 1},
            {"group": "Acompañamientos", "option": "Tortilla gruesa", "quantity": 2},
        ])
        self.assertEqual(complete.status_code, 200)
        self.assertEqual(complete.json["tables"][0]["items"][-1]["price"], 4500)

    def test_priority_is_saved_and_default_is_false(self):
        opened = self.action("table_open", table_id="1", waiter="Prueba")
        self.assertEqual(opened.status_code, 200)

        regular = self.action("item_add", table_id="1", menu_id="menu-te", quantity=1, waiter="Prueba")
        self.assertEqual(regular.status_code, 200)
        priority = self.action("item_add", table_id="1", menu_id="menu-cafe", quantity=1, waiter="Prueba", priority=True)
        self.assertEqual(priority.status_code, 200)

        items = priority.json["tables"][0]["items"]
        self.assertFalse(items[0]["priority"])
        self.assertTrue(items[1]["priority"])

        sent = self.action("order_send", table_id="1")
        self.assertEqual(sent.status_code, 200)
        self.assertTrue(sent.json["tables"][0]["items"][1]["priority"])

    def test_kitchen_priority_can_be_toggled_after_sending(self):
        self.action("table_open", table_id="1", waiter="Prueba")
        self.action("item_add", table_id="1", menu_id="menu-te", quantity=1, waiter="Prueba")
        sent = self.action("order_send", table_id="1")
        item_id = sent.json["tables"][0]["items"][0]["id"]

        marked = self.action("item_priority", table_id="1", item_id=item_id, priority=True)
        self.assertEqual(marked.status_code, 200)
        self.assertTrue(marked.json["tables"][0]["items"][0]["priority"])

        unmarked = self.action("item_priority", table_id="1", item_id=item_id, priority=False)
        self.assertEqual(unmarked.status_code, 200)
        self.assertFalse(unmarked.json["tables"][0]["items"][0]["priority"])


    def test_table_open_stores_guest_count(self):
        opened = self.action("table_open", table_id="1", waiter="Prueba", guests=5)
        self.assertEqual(opened.status_code, 200)
        self.assertEqual(opened.json["tables"][0]["guests"], 5)

    def test_table_open_clamps_and_defaults_guest_count(self):
        default_open = self.action("table_open", table_id="1", waiter="Prueba")
        self.assertEqual(default_open.status_code, 200)
        self.assertEqual(default_open.json["tables"][0]["guests"], 1)

        clamped_high = self.action("table_open", table_id="2", waiter="Prueba", guests=999)
        self.assertEqual(clamped_high.json["tables"][1]["guests"], 30)

        clamped_low = self.action("table_open", table_id="3", waiter="Prueba", guests=0)
        self.assertEqual(clamped_low.json["tables"][2]["guests"], 1)

    def test_retrieve_item_marks_ready_without_claiming_waiter_picked_it_up(self):
        self.action("table_open", table_id="1", waiter="Prueba")
        self.action("item_add", table_id="1", menu_id="menu-te", quantity=1, waiter="Prueba")
        sent = self.action("order_send", table_id="1")
        self.assertEqual(sent.status_code, 200)
        item_id = sent.json["tables"][0]["items"][0]["id"]

        retrieve = self.action("order_retrieve", table_id="1", item_id=item_id)
        self.assertEqual(retrieve.status_code, 200)
        item = retrieve.json["tables"][0]["items"][0]
        self.assertEqual(item["status"], "ready")
        self.assertIsNotNone(item["ready_at"])
        self.assertNotIn("retrieved_at", item)

        paid = self.action("table_paid", table_id="1")
        self.assertEqual(paid.status_code, 200)
        self.assertEqual(paid.json["tables"][0]["status"], "cleaning")

    def test_waiter_can_mark_ready_item_as_retrieved(self):
        self.action("table_open", table_id="1", waiter="Prueba")
        self.action("item_add", table_id="1", menu_id="menu-te", quantity=1)
        sent = self.action("order_send", table_id="1")
        item_id = sent.json["tables"][0]["items"][0]["id"]
        ready = self.action("item_status", table_id="1", item_id=item_id, status="ready")
        self.assertEqual(ready.status_code, 200)
        self.assertNotIn("retrieved_at", ready.json["tables"][0]["items"][0])

        retrieved = self.action("item_mark_retrieved", table_id="1", item_id=item_id, waiter="Ana")

        self.assertEqual(retrieved.status_code, 200)
        item = retrieved.json["tables"][0]["items"][0]
        self.assertEqual(item["status"], "ready")
        self.assertIsNotNone(item["retrieved_at"])
        self.assertEqual(item["retrieved_by"], "Ana")

    def test_waiter_cannot_mark_an_unready_item_as_retrieved(self):
        self.action("table_open", table_id="1", waiter="Prueba")
        added = self.action("item_add", table_id="1", menu_id="menu-te", quantity=1)
        item_id = added.json["tables"][0]["items"][0]["id"]

        response = self.action("item_mark_retrieved", table_id="1", item_id=item_id, waiter="Ana")

        self.assertEqual(response.status_code, 400)

    def test_item_cannot_be_marked_retrieved_twice(self):
        self.action("table_open", table_id="1", waiter="Prueba")
        self.action("item_add", table_id="1", menu_id="menu-te", quantity=1)
        sent = self.action("order_send", table_id="1")
        item_id = sent.json["tables"][0]["items"][0]["id"]
        self.action("item_status", table_id="1", item_id=item_id, status="ready")
        self.assertEqual(self.action("item_mark_retrieved", table_id="1", item_id=item_id).status_code, 200)

        duplicate = self.action("item_mark_retrieved", table_id="1", item_id=item_id)

        self.assertEqual(duplicate.status_code, 400)

    def test_retrieve_requires_existing_item_on_open_table(self):
        retrieved = self.action("order_retrieve", table_id="1", item_id="no-such-item")
        self.assertEqual(retrieved.status_code, 400)

    def test_retrieve_requires_item_in_cook_queue(self):
        self.action("table_open", table_id="1", waiter="Prueba")
        self.action("item_add", table_id="1", menu_id="menu-te", quantity=1, waiter="Prueba")
        retrieved = self.action("order_retrieve", table_id="1", item_id="no-such-item")
        self.assertEqual(retrieved.status_code, 400)

    def test_retrieve_rejects_completed_or_stale_item(self):
        self.action("table_open", table_id="1", waiter="Prueba")
        self.action("item_add", table_id="1", menu_id="menu-te", quantity=1, waiter="Prueba")
        sent = self.action("order_send", table_id="1")
        item_id = sent.json["tables"][0]["items"][0]["id"]
        self.action("item_status", table_id="1", item_id=item_id, status="ready")
        retrieved = self.action("order_retrieve", table_id="1", item_id=item_id)
        self.assertEqual(retrieved.status_code, 400)

    def test_default_tables_are_grouped_by_zone(self):
        tables = self.client.get("/api/state").json["tables"]
        by_zone = {}
        for table in tables:
            by_zone.setdefault(table["zone"], []).append(table["name"])
        self.assertEqual(by_zone["Salón adentro"], [f"Mesa {number}" for number in range(1, 9)])
        self.assertEqual(set(by_zone), {"Salón adentro", "Salón afuera"})
        self.assertEqual(
            by_zone["Salón afuera"],
            [f"Mesa {number}" for number in range(9, 17)] + [f"D{number}" for number in range(1, 6)] + ["S1", "S2"],
        )

    def test_existing_state_gets_zones_and_missing_tables(self):
        with app.closing(app.connect_db()) as connection, connection:
            document = {
                "_migrations": ["classic-combo-v1", "classic-combo-v2"],
                "tables": [
                    {"id": "1", "name": "Mesa 1", "status": "open", "opened_by": "Ana", "opened_at": None, "guests": 2, "items": []},
                    {"id": "custom", "name": "Patio", "zone": "Otras", "status": "free", "opened_by": "", "opened_at": None, "guests": None, "items": []},
                ],
                "pending_sales": [],
                "sales_closures": [],
                "menu": [],
            }
            connection.execute("UPDATE app_state SET document = ? WHERE id = 1", (app.json.dumps(document),))
        tables = {table["name"]: table for table in self.client.get("/api/state").json["tables"]}
        self.assertEqual(tables["Mesa 1"]["zone"], "Salón adentro")
        self.assertEqual(tables["Mesa 1"]["status"], "open")
        self.assertEqual(tables["Patio"]["zone"], "Salón afuera")
        self.assertEqual(len(tables), 24)
        self.assertIn("S2", tables)

    def test_new_table_can_be_added_to_a_zone(self):
        created = self.action("table_create", name="Mesa 17", zone="Salón afuera")
        self.assertEqual(created.status_code, 200)
        self.assertEqual(created.json["tables"][-1]["zone"], "Salón afuera")
        fallback = self.action("table_create", name="Rincón", zone="inexistente")
        self.assertEqual(fallback.json["tables"][-1]["zone"], "Salón afuera")

    def test_old_four_zone_layout_is_collapsed_to_two_salons(self):
        with app.closing(app.connect_db()) as connection, connection:
            state = app.json.loads(connection.execute("SELECT document FROM app_state WHERE id = 1").fetchone()["document"])
            old_zones = {"D1": "Desayunador", "S1": "Sombrillas", "Patio": "Otras", "Mesa 9": "Salón afuera", "Mesa 2": "Salón adentro"}
            state["tables"] = [app.new_table(name.lower(), name, zone) for name, zone in old_zones.items()]
            state["_migrations"] = ["classic-combo-v1", "classic-combo-v2", "zones-v1"]
            connection.execute("UPDATE app_state SET document = ? WHERE id = 1", (app.json.dumps(state),))
        tables = {table["name"]: table["zone"] for table in self.client.get("/api/state").json["tables"]}
        self.assertEqual(tables["Mesa 2"], "Salón adentro")
        self.assertEqual({tables[name] for name in ("D1", "S1", "Patio", "Mesa 9")}, {"Salón afuera"})

    def test_paid_tables_are_recorded_as_tickets_and_closed_with_the_shift(self):
        self.action("table_open", table_id="1", waiter="Prueba")
        self.action("item_add", table_id="1", menu_id="menu-te", quantity=2)
        sent = self.action("order_send", table_id="1")
        item_id = sent.json["tables"][0]["items"][0]["id"]
        self.action("item_status", table_id="1", item_id=item_id, status="ready")
        paid = self.action("table_paid", table_id="1")
        self.assertEqual(paid.status_code, 200)
        tickets = paid.json["pending_tickets"]
        self.assertEqual(len(tickets), 1)
        self.assertEqual((tickets[0]["table_name"], tickets[0]["total"], tickets[0]["units"]), ("Mesa 1", 4000, 2))

        closed = self.action("shift_close")
        self.assertEqual(closed.status_code, 200)
        self.assertEqual(closed.json["pending_tickets"], [])
        self.assertEqual(closed.json["sales_closures"][-1]["total_amount"], 4000)
        self.assertEqual(closed.json["sales_closures"][-1]["tickets"], 1)
    def unit_dish(self, option_price=0, name="Tortilla"):
        created = self.action("menu_add", name=name, category="Para acompañar", price=3000, modifier_groups=[{
            "name": "Para acompañar",
            "selection": "quantity",
            "required": False,
            "options": [{"name": option, "price": option_price} for option in ("gruesa", "fina", "bollito")],
        }])
        return next(dish for dish in created.json["menu"] if dish["name"] == name)["id"]

    def test_chosen_options_are_units_charged_at_the_product_price(self):
        for option_price in (0, 3000):
            with self.subTest(option_price=option_price):
                dish_id = self.unit_dish(option_price=option_price, name=f"Tortilla {option_price}")
                self.action("table_open", table_id="1", waiter="Prueba") if option_price == 0 else None
                added = self.action("item_add", table_id="1", menu_id=dish_id, quantity=1, modifiers=[
                    {"group": "Para acompañar", "option": "fina", "quantity": 2},
                    {"group": "Para acompañar", "option": "bollito", "quantity": 1},
                ])
                self.assertEqual(added.status_code, 200)
                item = added.json["tables"][0]["items"][-1]
                self.assertEqual((item["quantity"], item["price"], item["unit_mode"]), (3, 3000, True))
                self.assertEqual(item["price"] * item["quantity"], 9000)

    def test_unit_product_needs_at_least_one_unit_and_can_be_edited(self):
        dish_id = self.unit_dish()
        self.action("table_open", table_id="1", waiter="Prueba")
        empty = self.action("item_add", table_id="1", menu_id=dish_id, quantity=1, modifiers=[])
        self.assertEqual(empty.status_code, 400)

        added = self.action("item_add", table_id="1", menu_id=dish_id, quantity=1, modifiers=[
            {"group": "Para acompañar", "option": "gruesa", "quantity": 1},
        ])
        item = added.json["tables"][0]["items"][0]
        self.assertEqual(item["quantity"], 1)
        edited = self.action("item_edit", table_id="1", item_id=item["id"], menu_id=dish_id, quantity=1, modifiers=[
            {"group": "Para acompañar", "option": "gruesa", "quantity": 2},
            {"group": "Para acompañar", "option": "fina", "quantity": 2},
        ])
        edited_item = edited.json["tables"][0]["items"][0]
        self.assertEqual((edited_item["quantity"], edited_item["price"]), (4, 3000))

    def test_products_with_a_single_choice_group_keep_the_base_price_plus_extras(self):
        combo = next(dish for dish in app.read_state()[0]["menu"] if dish["id"] == "menu-clasico")
        self.assertFalse(app.is_unit_product(combo))
        self.action("table_open", table_id="1", waiter="Prueba")
        added = self.action("item_add", table_id="1", menu_id="menu-clasico", quantity=2, modifiers=[
            {"group": "Infusión", "option": "Mate", "quantity": 1},
            {"group": "Acompañamientos", "option": "Bollito", "quantity": 1},
            {"group": "Agregados", "option": "Manteca", "quantity": 1},
        ])
        item = added.json["tables"][0]["items"][0]
        self.assertEqual((item["quantity"], item["price"], item["unit_mode"]), (2, 4800, False))

    def test_options_with_a_real_surcharge_are_not_units(self):
        dish_id = self.unit_dish(option_price=500, name="Tortilla extra")
        self.action("table_open", table_id="1", waiter="Prueba")
        added = self.action("item_add", table_id="1", menu_id=dish_id, quantity=2, modifiers=[
            {"group": "Para acompañar", "option": "gruesa", "quantity": 1},
        ])
        item = added.json["tables"][0]["items"][0]
        self.assertEqual((item["quantity"], item["price"], item["unit_mode"]), (2, 3500, False))
    def test_shift_must_be_started_before_opening_tables_and_closed_to_finish(self):
        self.action("shift_close")
        blocked = self.action("table_open", table_id="1", waiter="Prueba")
        self.assertEqual(blocked.status_code, 400)
        self.assertEqual(self.action("shift_start", shift="evening").status_code, 400)

        started = self.action("shift_start", shift="afternoon", waiter="Ana")
        self.assertEqual((started.status_code, started.json["shift"]["type"], started.json["shift"]["started_by"]), (200, "afternoon", "Ana"))
        self.assertEqual(self.action("shift_start", shift="morning").status_code, 400)
        self.assertEqual(self.action("table_open", table_id="1", waiter="Ana").status_code, 200)

    def test_shift_cannot_close_with_unpaid_tables_and_resets_everything_when_closed(self):
        self.action("table_open", table_id="1", waiter="Prueba")
        self.action("item_add", table_id="1", menu_id="menu-te", quantity=1)
        self.action("table_open", table_id="2", waiter="Prueba")
        blocked = self.action("shift_close")
        self.assertEqual(blocked.status_code, 400)
        self.assertIn("Mesa 1", blocked.json["error"])

        sent = self.action("order_send", table_id="1")
        item_id = sent.json["tables"][0]["items"][0]["id"]
        self.action("item_status", table_id="1", item_id=item_id, status="ready")
        self.action("table_paid", table_id="1")
        self.action("item_add", table_id="2", menu_id="menu-te", quantity=1)
        self.action("item_status", table_id="2", item_id=self.client.get("/api/state").json["tables"][1]["items"][0]["id"], status="canceled")

        closed = self.action("shift_close")
        self.assertEqual(closed.status_code, 200)
        state = closed.json
        self.assertIsNone(state["shift"])
        self.assertEqual({table["status"] for table in state["tables"]}, {"free"})
        self.assertEqual((state["pending_sales"], state["pending_tickets"]), ([], []))
        closure = state["sales_closures"][-1]
        self.assertEqual((closure["shift"], closure["total_amount"], closure["total_units"], closure["tickets"]), ("morning", 2000, 1, 1))
        self.assertIn("started_at", closure)

        again = self.action("shift_close")
        self.assertEqual(again.status_code, 400)
        self.assertEqual(self.action("shift_start", shift="afternoon").status_code, 200)

class SiteMenuTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        database_path = Path(self.temporary_directory.name) / "test.sqlite3"
        self.database_patch = patch.object(app, "DATABASE_PATH", database_path)
        self.database_patch.start()
        app.initialize_db()
        self.client = app.app.test_client()

    def tearDown(self):
        self.database_patch.stop()
        self.temporary_directory.cleanup()

    def menu(self):
        return {dish["name"]: dish for dish in self.client.get("/api/state").json["menu"]}

    def test_default_menu_is_the_las_palmeras_carta(self):
        menu = self.menu()
        self.assertEqual(len(menu), 37)
        self.assertEqual(len({dish["id"] for dish in menu.values()}), 37)
        self.assertEqual(menu["Capuchino"]["price"], 3000)
        self.assertEqual(menu["Avocado"]["description"], "Pan de masa madre, palta y huevo poché. Incluye infusión")
        self.assertEqual(menu["Gaseosa 1500 cc"]["category"], "Bebidas en general")
        self.assertEqual(menu["Clásico"]["id"], "menu-clasico")
        self.assertEqual([group["name"] for group in menu["Clásico"]["modifier_groups"]], ["Infusión", "Acompañamientos", "Agregados"])

    def test_breakfasts_require_an_infusion_and_special_sandwiches_are_paused(self):
        menu = self.menu()
        group = menu["Energético"]["modifier_groups"][0]
        self.assertEqual((group["name"], group["required"], group["selection"]), ("Infusión", True, "single"))
        self.assertFalse(menu["Palmeras Perú"]["available"])
        self.assertFalse(menu["Palmeras San Martín"]["available"])

    def test_existing_menu_is_replaced_once_keeping_ids_of_matching_products(self):
        with app.closing(app.connect_db()) as connection, connection:
            state = app.json.loads(connection.execute("SELECT document FROM app_state WHERE id = 1").fetchone()["document"])
            state["menu"] = [{"id": "viejo-jamon", "name": "Jamón y queso", "description": "", "category": "X", "price": 1, "available": True}]
            state["_migrations"] = [name for name in state["_migrations"] if name != "carta-las-palmeras-v1"]
            connection.execute("UPDATE app_state SET document = ? WHERE id = 1", (app.json.dumps(state, ensure_ascii=False),))
        menu = self.menu()
        self.assertEqual(len(menu), 37)
        self.assertEqual(menu["Jamón y queso"]["id"], "viejo-jamon")
        self.assertEqual(menu["Jamón y queso"]["price"], 3500)
        again = self.client.post("/api/action", json={"type": "menu_add", "name": "Nuevo", "category": "X", "price": 100})
        self.assertEqual(len(again.json["menu"]), 38)
        self.assertEqual(len(self.menu()), 38)


@unittest.skipUnless(os.environ.get("TEST_DATABASE_URL"), "Definí TEST_DATABASE_URL para probar PostgreSQL")
class PostgresStorageTests(unittest.TestCase):
    def setUp(self):
        self.environment_patch = patch.dict(os.environ, {"DATABASE_URL": os.environ["TEST_DATABASE_URL"]})
        self.environment_patch.start()
        with app.closing(app.connect_db()) as connection, connection:
            connection.execute("DROP TABLE IF EXISTS app_state")
        app.initialize_db()
        self.client = app.app.test_client()

    def tearDown(self):
        self.environment_patch.stop()

    def test_changes_are_kept_between_connections(self):
        self.assertEqual(self.client.post("/api/action", json={"type": "shift_start", "shift": "morning"}).status_code, 200)
        created = self.client.post("/api/action", json={"type": "menu_add", "name": "Plato nuevo", "category": "Extra", "price": 1234})
        self.assertEqual(created.status_code, 200)

        state = self.client.get("/api/state").json
        self.assertEqual(state["shift"]["type"], "morning")
        self.assertTrue(any(dish["name"] == "Plato nuevo" for dish in state["menu"]))
        self.assertEqual(len(state["menu"]), 38)
        self.assertFalse(state["storage_volatile"])

    def test_failed_action_does_not_change_the_stored_state(self):
        failed = self.client.post("/api/action", json={"type": "table_open", "table_id": "1", "waiter": "Ana"})
        self.assertEqual(failed.status_code, 400)
        self.assertTrue(all(table["status"] == "free" for table in self.client.get("/api/state").json["tables"]))