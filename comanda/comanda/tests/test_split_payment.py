import unittest
import test_workflow

class SplitPaymentTests(unittest.TestCase):
    setUp = test_workflow.ComandaWorkflowTests.setUp
    tearDown = test_workflow.ComandaWorkflowTests.tearDown
    action = test_workflow.ComandaWorkflowTests.action
    use_sample_menu = test_workflow.ComandaWorkflowTests.use_sample_menu
    def prepare(self):
        self.action('table_open', table_id='1', waiter='Prueba')
        result = self.action('item_add', table_id='1', menu_id='menu-te', quantity=3)
        item = result.json['tables'][0]['items'][0]
        self.action('order_send', table_id='1')
        self.action('item_status', table_id='1', item_id=item['id'], status='ready')
        return item['id']

    def test_partial_then_full_counts_each_unit_once(self):
        item_id = self.prepare()
        result = self.action('items_paid', table_id='1', items=[{'item_id':item_id,'quantity':1}])
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json['tables'][0]['status'], 'open')
        self.assertEqual(result.json['tables'][0]['items'][0]['quantity'], 2)
        self.assertEqual(result.json['pending_tickets'][-1]['total'], 2000)
        result = self.action('table_paid', table_id='1')
        self.assertEqual(result.json['tables'][0]['status'], 'cleaning')
        self.assertEqual(sum(t['total'] for t in result.json['pending_tickets']), 6000)
        self.assertEqual(result.json['pending_sales'][0]['quantity'], 3)

    def test_invalid_selection_is_atomic(self):
        item_id = self.prepare()
        for items in [[], [{'item_id':item_id,'quantity':4}], [{'item_id':item_id,'quantity':-1}], [{'item_id':item_id,'quantity':1.5}], [{'item_id':item_id,'quantity':1}]*2]:
            result = self.action('items_paid', table_id='1', items=items)
            self.assertEqual(result.status_code, 400)
        state = self.client.get('/api/state').json
        self.assertEqual(state['tables'][0]['items'][0]['quantity'], 3)
        self.assertEqual(state['pending_tickets'], [])

    def test_ready_product_can_be_paid_while_other_is_pending(self):
        item_id = self.prepare()
        self.action('item_add', table_id='1', menu_id='menu-cafe', quantity=1)
        result = self.action('items_paid', table_id='1', items=[{'item_id':item_id,'quantity':3}])
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json['tables'][0]['status'], 'open')
        self.assertEqual(len(result.json['tables'][0]['items']), 1)
        self.assertEqual(result.json['tables'][0]['items'][0]['name'], 'Café')

    def test_cannot_pay_unready_item(self):
        self.action('table_open', table_id='1', waiter='Prueba')
        result = self.action('item_add', table_id='1', menu_id='menu-te', quantity=1)
        item_id = result.json['tables'][0]['items'][0]['id']
        result = self.action('items_paid', table_id='1', items=[{'item_id':item_id,'quantity':1}])
        self.assertEqual(result.status_code, 400)

    def test_last_separate_payment_closes_table(self):
        item_id = self.prepare()
        result = self.action('items_paid', table_id='1', items=[{'item_id':item_id,'quantity':3}])
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json['tables'][0]['status'], 'cleaning')
        self.assertEqual(self.action('items_paid', table_id='1', items=[{'item_id':item_id,'quantity':3}]).status_code,400)

