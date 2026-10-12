import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app


class CoffeeSizesTests(unittest.TestCase):
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

    def test_sizes_and_accompaniments_are_charged_from_the_first_unit(self):
        for dish_id in ["menu-cortado", "menu-leche-cortada"]:
            for size, additions, quantity, expected in [
                ("Pocillo", [], 1, 1300),
                ("Jarrita", [], 1, 1500),
                ("Pocillo", [("Acompañamientos", "Tortilla fina", 1)], 1, 1700),
                ("Jarrita", [("Acompañamientos", "Medialuna", 1)], 1, 2200),
                ("Jarrita", [("Acompañamientos", "Bollito", 2), ("Agregados", "Manteca", 1)], 1, 2600),
                ("Pocillo", [("Acompañamientos", "Factura", 1), ("Agregados", "Queso", 1)], 2, 5000),
            ]:
                with self.subTest(dish=dish_id, size=size, additions=additions, quantity=quantity):
                    modifiers = [{"group": "Tamaño", "option": size, "quantity": 1}] + [{"group": group, "option": name, "quantity": units} for group, name, units in additions]
                    result = self.client.post("/api/action", json={"type": "item_add", "table_id": "1", "menu_id": dish_id, "quantity": quantity, "modifiers": modifiers})
                    self.assertEqual(result.status_code, 200, result.json)
                    item = result.json["tables"][0]["items"][-1]
                    self.assertEqual(item["price"] * item["quantity"], expected)

    def test_size_is_required(self):
        result = self.client.post("/api/action", json={"type": "item_add", "table_id": "1", "menu_id": "menu-cortado", "quantity": 1, "modifiers": []})
        self.assertEqual(result.status_code, 400)

    def test_rename_keeps_identifiers_and_existing_orders(self):
        state = {"menu": [{"id": "menu-cafe-lagrima", "name": "Café lágrima", "category": "Cafetería", "price": 2800, "available": True}], "tables": [{"items": [{"menu_id": "menu-cafe-lagrima", "name": "Café lágrima", "price": 2800}]}]}
        original_orders = copy.deepcopy(state["tables"])
        app.configure_coffee_sizes(state)
        self.assertEqual(state["menu"][0]["id"], "menu-cafe-lagrima")
        self.assertEqual(state["menu"][0]["name"], "Leche cortada")
        self.assertEqual(state["tables"], original_orders)
        self.assertNotIn("included_quantity", state["menu"][0]["modifier_groups"][1])
