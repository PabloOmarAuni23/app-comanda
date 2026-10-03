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