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


if __name__ == "__main__":
    unittest.main()