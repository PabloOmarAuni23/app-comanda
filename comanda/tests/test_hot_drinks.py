import copy
import unittest

import app


class HotDrinksTests(unittest.TestCase):
    def test_initial_menu_has_one_hot_drinks_category_and_cappuccino(self):
        menu = app.initial_state()["menu"]
        self.assertIn("Cafetería", {dish["category"] for dish in menu})
        cappuccinos = [dish for dish in menu if dish["name"] == "Capuchino"]
        self.assertEqual(len(cappuccinos), 1)
        self.assertEqual(cappuccinos[0]["category"], "Bebidas calientes")

    def test_merge_preserves_custom_prices_options_and_orders(self):
        state = {"menu": [
            {"id": "custom-cap", "name": "Capuchino", "category": "Cafetería", "price": 4500, "available": False, "modifier_groups": [{"name": "Leche"}]},
            {"id": "coffee", "name": "Café", "category": "Cafetería", "price": 3200},
            {"id": "tea", "name": "Té", "category": "Bebidas calientes", "price": 2600},
        ], "tables": [{"items": [{"menu_id": "custom-cap", "price": 4000}]}]}
        before = copy.deepcopy(state)
        app.merge_hot_drinks(state)
        self.assertEqual(state["tables"], before["tables"])
        for previous, current in zip(before["menu"], state["menu"]):
            self.assertEqual(current, {**previous, "category": "Bebidas calientes"})
        once = copy.deepcopy(state)
        app.merge_hot_drinks(state)
        self.assertEqual(state, once)

    def test_missing_cappuccino_is_added_only_once(self):
        state = {"menu": [{"id": "menu-capuchino", "name": "Otro producto", "category": "Bebidas calientes"}]}
        app.merge_hot_drinks(state)
        app.merge_hot_drinks(state)
        self.assertEqual(len(state["menu"]), 2)
        self.assertEqual(len({dish["id"] for dish in state["menu"]}), 2)
        self.assertEqual(state["menu"][1]["name"], "Capuchino")
