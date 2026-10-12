import unittest
import app

class SmoothiePromoTests(unittest.TestCase):
    def test_flavors_repeat_and_price_is_per_promo(self):
        dish = next(d for d in app.build_site_menu() if d['id']=='menu-promo-de-licuado')
        self.assertEqual(dish['category'], 'Momentos especiales')
        self.assertEqual(len(dish['modifier_groups'][0]['options']),5)
        for flavor in dish['modifier_groups'][0]['options']:
            for bread in ['Tostado de miga','Tostado árabe']:
                selected = app.select_modifiers(dish,[{'group':'Primer licuado','option':flavor['name']},{'group':'Segundo licuado','option':flavor['name']},{'group':'Tostado','option':bread}])
                self.assertEqual(app.price_item(dish,selected,2),(9000,2,False))

    def test_requires_two_drinks_and_toast(self):
        dish = next(d for d in app.build_site_menu() if d['id']=='menu-promo-de-licuado')
        choices = [{'group':'Primer licuado','option':'Licuado de banana'},{'group':'Segundo licuado','option':'Licuado de durazno'},{'group':'Tostado','option':'Tostado de miga'}]
        for missing in range(3):
            with self.assertRaises(ValueError): app.select_modifiers(dish,[c for i,c in enumerate(choices) if i!=missing])

    def test_migration_adds_once_and_preserves_existing_menu(self):
        state={'menu':[{'id':'custom','name':'Especial','price':1234}]}
        app.add_smoothie_promo(state)
        app.add_smoothie_promo(state)
        self.assertEqual(len(state['menu']),2)
        self.assertEqual(state['menu'][0]['price'],1234)
