import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app


class ClassicExtraTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.database = patch.object(app, "DATABASE_PATH", Path(self.temp.name) / "test.sqlite3")
        self.database.start()
        app.initialize_db()
        self.client = app.app.test_client()
        self.client.post("/api/action", json={"type": "shift_start", "shift": "morning", "waiter": "Prueba"})
        self.client.post("/api/action", json={"type": "table_open", "table_id": "1", "waiter": "Prueba"})

    def tearDown(self):
        self.database.stop()
        self.temp.cleanup()

    def modifiers(self, options):
        return [{"group": "Infusión", "option": "Café", "quantity": 1}] + [
            {"group": "Acompañamientos", "option": name, "quantity": quantity}
            for name, quantity in options
        ]

    def test_boundaries_mixed_choices_and_multiple_combos(self):
        cases = [
            ([("Tortilla fina", 2)], 1, 3000),
            ([("Tortilla fina", 3)], 1, 3400),
            ([("Bollito", 4)], 1, 3800),
            ([("Medialuna", 3)], 1, 3700),
            ([("Tortilla fina", 1), ("Medialuna", 1)], 1, 3000),
            ([("Tortilla fina", 2), ("Medialuna", 1)], 1, 3700),
            ([("Medialuna", 1), ("Tortilla fina", 2)], 1, 3400),
            ([("Tortilla gruesa", 3)], 2, 6800),
            ([("Medialuna", 3)], 2, 7400),
        ]
        for options, quantity, total in cases:
            with self.subTest(options=options, quantity=quantity):
                result = self.client.post("/api/action", json={"type": "item_add", "table_id": "1", "menu_id": "menu-clasico", "quantity": quantity, "modifiers": self.modifiers(options)})
                self.assertEqual(result.status_code, 200, result.json)
                item = result.json["tables"][0]["items"][-1]
                self.assertEqual(item["price"] * item["quantity"], total)

    def test_edit_removes_extra_and_send_keeps_the_price(self):
        added = self.client.post("/api/action", json={"type": "item_add", "table_id": "1", "menu_id": "menu-clasico", "quantity": 1, "modifiers": self.modifiers([("Tortilla fina", 3)])})
        item = added.json["tables"][0]["items"][-1]
        self.assertEqual(item["price"], 3400)
        edited = self.client.post("/api/action", json={"type": "item_edit", "table_id": "1", "item_id": item["id"], "menu_id": "menu-clasico", "quantity": 1, "modifiers": self.modifiers([("Tortilla fina", 2)])})
        self.assertEqual(edited.status_code, 200, edited.json)
        sent = self.client.post("/api/action", json={"type": "order_send", "table_id": "1"})
        self.assertEqual(sent.json["tables"][0]["items"][-1]["price"], 3000)

    def test_selection_order_survives_menu_order_and_editing(self):
        modifiers = self.modifiers([("Tortilla fina", 1), ("Medialuna", 2)])
        # Two medialunas were chosen first, then the tortilla; payload follows menu order.
        modifiers[1]["included_quantity"] = 0
        modifiers[2]["included_quantity"] = 2
        added = self.client.post("/api/action", json={"type": "item_add", "table_id": "1", "menu_id": "menu-clasico", "quantity": 1, "modifiers": modifiers})
        self.assertEqual(added.status_code, 200, added.json)
        item = added.json["tables"][0]["items"][-1]
        self.assertEqual(item["price"], 3400)
        saved = [{"group": entry["group"], "option": entry["name"], "quantity": entry["quantity"], **({"included_quantity": entry["included_quantity"]} if "included_quantity" in entry else {})} for entry in item["modifiers"]]
        edited = self.client.post("/api/action", json={"type": "item_edit", "table_id": "1", "item_id": item["id"], "menu_id": "menu-clasico", "quantity": 2, "modifiers": saved})
        self.assertEqual(edited.status_code, 200, edited.json)
        self.assertEqual(edited.json["tables"][0]["items"][-1]["price"], 3400)

    def test_two_tortillas_then_factura_costs_700(self):
        modifiers = self.modifiers([("Tortilla fina", 2), ("Factura", 1)])
        modifiers[1]["included_quantity"] = 2
        modifiers[2]["included_quantity"] = 0
        added = self.client.post("/api/action", json={"type": "item_add", "table_id": "1", "menu_id": "menu-clasico", "quantity": 1, "modifiers": modifiers})
        self.assertEqual(added.status_code, 200, added.json)
        self.assertEqual(added.json["tables"][0]["items"][-1]["price"], 3700)

    def test_cannot_claim_more_than_two_included_units(self):
        modifiers = self.modifiers([("Medialuna", 3)])
        modifiers[1]["included_quantity"] = 3
        added = self.client.post("/api/action", json={"type": "item_add", "table_id": "1", "menu_id": "menu-clasico", "quantity": 1, "modifiers": modifiers})
        self.assertEqual(added.status_code, 400)

    def test_updating_menu_keeps_the_included_allowance(self):
        dish = app.default_classic_combo()
        normalized = app.normalize_modifier_groups(dish["modifier_groups"])
        self.assertEqual(normalized[1]["included_quantity"], 2)

    def test_migration_preserves_existing_order_prices(self):
        dish = app.default_classic_combo()
        dish["price"] = 3500
        del dish["modifier_groups"][1]["included_quantity"]
        state = {"menu": [dish], "tables": [{"items": [{"menu_id": dish["id"], "price": 3000}]}]}
        previous_tables = copy.deepcopy(state["tables"])
        app.configure_classic_extras(state)
        self.assertEqual(dish["price"], 3500)
        self.assertEqual(state["tables"], previous_tables)
        self.assertEqual(dish["modifier_groups"][1]["included_quantity"], 2)
        once = copy.deepcopy(state)
        app.configure_classic_extras(state)
        self.assertEqual(state, once)
