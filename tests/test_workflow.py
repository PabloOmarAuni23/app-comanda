import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app


class ComandaWorkflowTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()